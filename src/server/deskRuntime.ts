import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { installAgentSurfaceBroker } from './agentSurfaceBroker.js';
import { disposeChannelsRuntime, initChannelsRuntime } from './channels/index.js';
import type { ChannelsRuntimeOwner } from './channels/index.js';
import type { DeskApiHost } from './deskApiTypes.js';
import type { DeskServices } from './deskServices.js';
import type { DisposerRegistry } from './disposerRegistry.js';
import { installFsWatchBridge } from './fsWatchBridge.js';
import { installLspWebSocketBridge } from './lspWebSocketBridge.js';
import { forceKillActiveStdioVirtualSessionChildren } from './lsp/stdioVirtualSession.js';
import type { DeskPlugin } from './plugin.js';
import { startSystemSampling, stopSystemSampling } from './systemSampler.js';
import { installTerminalDaemonProxy } from './terminalDaemonProxy.js';
import {
  daemonChildEnv,
  resolveMoorBinPath,
  resolveDaemonCommand,
  startDaemonSupervisor
} from './runtime/daemonSupervisor.js';

interface InstallDeskRuntimeOptions {
  host: DeskApiHost;
  services: DeskServices;
  plugins: DeskPlugin[];
  disposers: DisposerRegistry;
  channelsOwner: ChannelsRuntimeOwner;
}


export function installDeskRuntime({ host, services, plugins, disposers, channelsOwner }: InstallDeskRuntimeOptions): void {
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

    // The web server PROXIES /ws/terminal to the separate daemon process
    // (byte-forwarding, no @xterm/headless in the web server, so serve
    // startup timing is unaffected) and OWNS that process's lifecycle via the
    // supervisor (same-release spawn, bounded restarts, SIGTERM on close).
    // DESK_DAEMON_EXTERNAL=1 skips the supervisor for a hand-run daemon
    // (debugging). This is the only terminal transport — there is no flag.
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
            DESK_MOOR_BIN: resolveMoorBinPath(import.meta.url)
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

  startSystemSampling();
  disposers.add(stopSystemSampling);
  initChannelsRuntime({
    agentSurfaceBroker: services.agentSurfaceBroker,
    owner: channelsOwner,
    // Plugin order is provider order: each wraps the previous result.
    providers: plugins.map((plugin) => plugin.channels).filter((entry) => entry !== undefined)
  });
  disposers.add(disposeChannelsRuntime);
}
