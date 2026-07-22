import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { listTmuxSessions, loadDesk } from '../core/runner.js';
import { installAgentSurfaceBroker } from './agentSurfaceBroker.js';
import {
  attemptResumeCaptureForSession,
  restorePendingResumeCaptures
} from './resumeCapture.js';
import {
  setRaiseListener,
  startAttentionPolling,
  stopAttentionPolling
} from './attention.js';
import { disposeChannelsRuntime, initChannelsRuntime } from './channelsApi.js';
import type { DeskApiHost } from './deskApiTypes.js';
import type { DeskServices } from './deskServices.js';
import type { DisposerRegistry } from './disposerRegistry.js';
import { installFsWatchBridge } from './fsWatchBridge.js';
import { installLspWebSocketBridge } from './lspWebSocketBridge.js';
import { forceKillActiveStdioVirtualSessionChildren } from './lsp/stdioVirtualSession.js';
import type { DeskPlugin } from './plugin.js';
import { startSystemSampling, stopSystemSampling } from './systemSampler.js';
import { installTerminalBroker } from './terminalBroker.js';
import { installTerminalDaemonProxy } from './terminalDaemonProxy.js';
import {
  daemonChildEnv,
  resolveAtchBinPath,
  resolveDaemonCommand,
  startDaemonSupervisor
} from './runtime/daemonSupervisor.js';
import { repairTinyTmuxWindows } from './terminalBridge.js';
import { ensureTmuxGlobalOptions } from './tmuxOptions.js';

interface InstallDeskRuntimeOptions {
  host: DeskApiHost;
  services: DeskServices;
  plugins: DeskPlugin[];
  disposers: DisposerRegistry;
}

function repairConfiguredTinyWindows(): void {
  try {
    const running = listTmuxSessions();
    const sessions = loadDesk({}).sessions.filter((session) => running.has(session.tmuxSession));
    const repair = repairTinyTmuxWindows(sessions);
    if (repair.repaired.length > 0 || repair.failed.length > 0) {
      console.warn(
        `desk repaired ${repair.repaired.length} tiny tmux window(s); ${repair.failed.length} repair attempt(s) failed`
      );
    }
  } catch (error) {
    console.warn(`desk tiny-window repair skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function installDeskRuntime({ host, services, plugins, disposers }: InstallDeskRuntimeOptions): void {
  const { httpServer } = host;
  if (httpServer) {
    disposers.bind(httpServer);
    const upgradeGuards = plugins
      .map((plugin) => plugin.upgradeGuard)
      .filter((guard): guard is NonNullable<typeof guard> => typeof guard === 'function');
    if (upgradeGuards.length > 0) {
      const onUpgrade = (request: IncomingMessage, socket: Duplex): void => {
        if (!upgradeGuards.every((guard) => guard(request))) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
        }
      };
      httpServer.on('upgrade', onUpgrade);
      disposers.add(() => httpServer.off('upgrade', onUpgrade));
    }

    // atch-native, behind a default-OFF cutover flag: the web server PROXIES
    // /ws/terminal to the separate daemon process (byte-forwarding, no
    // @xterm/headless in the web server, so serve startup timing is unaffected)
    // and OWNS that process's lifecycle via the supervisor (same-release spawn,
    // bounded restarts, SIGTERM on close). DESK_DAEMON_EXTERNAL=1 skips the
    // supervisor for a hand-run daemon (debugging). Flag off ⇒ the live tmux
    // path is untouched; the tmux/string removal is the gated cutover step.
    if (process.env.DESK_ATCH_NATIVE === '1') {
      disposers.add(
        installTerminalDaemonProxy(httpServer, {
          daemonBaseUrl: process.env.DESK_DAEMON_URL ?? 'ws://127.0.0.1:5178'
        })
      );
      if (process.env.DESK_DAEMON_EXTERNAL !== '1') {
        try {
          const childEnv = daemonChildEnv();
          const supervisor = startDaemonSupervisor({
            command: resolveDaemonCommand(import.meta.url),
            env: {
              ...childEnv,
              DESK_ATCH_BIN: resolveAtchBinPath(import.meta.url)
            },
            healthUrl: `http://${childEnv.DESK_DAEMON_HOST}:${childEnv.DESK_DAEMON_PORT}/control/health`
          });
          disposers.add(() => supervisor.dispose());
        } catch (error) {
          // Fail closed without taking the web server down: native terminals
          // read MISSING until the operator fixes the release or sets
          // DESK_DAEMON_CMD, and the reason is in the log.
          console.error(
            `terminal daemon not started: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    disposers.add(installTerminalBroker(httpServer, services.terminalBroker));
    disposers.add(installAgentSurfaceBroker(httpServer, services.agentSurfaceBroker));
    disposers.add(installFsWatchBridge(httpServer));
    disposers.add(
      installLspWebSocketBridge(httpServer, {
        createSession: services.createEditorSession
      })
    );
    services.lspWarmSessions.scheduleBootWarmup();
    disposers.add(() => {
      services.lspWarmSessions.dispose();
      forceKillActiveStdioVirtualSessionChildren();
    });
    disposers.add(() => {
      services.managedAgentLsp.cleanupAll();
      services.lspCapabilityTokens.dispose();
      void services.lspManager.stopAll();
    });
  }

  for (const plugin of plugins) {
    const dispose = plugin.setup?.({
      httpServer,
      onClose: (fn) => disposers.add(fn)
    });
    if (dispose) {
      disposers.add(dispose);
    }
  }

  startAttentionPolling();
  disposers.add(stopAttentionPolling);
  startSystemSampling();
  disposers.add(stopSystemSampling);
  initChannelsRuntime({ agentSurfaceBroker: services.agentSurfaceBroker });
  restorePendingResumeCaptures(loadDesk({}).sessions);
  disposers.add(disposeChannelsRuntime);
  setRaiseListener((tmuxSession) => {
    void attemptResumeCaptureForSession(tmuxSession, () =>
      loadDesk({}).sessions.find((candidate) => candidate.tmuxSession === tmuxSession)
    );
  });
  disposers.add(() => setRaiseListener(null));
  ensureTmuxGlobalOptions();
  repairConfiguredTinyWindows();
}
