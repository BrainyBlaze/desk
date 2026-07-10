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
