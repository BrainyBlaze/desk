import type { Server as NodeHttpServer } from 'node:http';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { handleAgentSessionInjectRequest } from './agentSessionsApi.js';
import { handleChannelsRequest } from './channelsApi.js';
import {
  acquireChannelsRuntimeOwner,
  type ChannelsRuntimeOwner
} from './channelsRuntimeOwner.js';
import { resolveChannelsHome } from './channelsStore.js';
import { createDeskApiMiddleware } from './deskApiRouter.js';
import type { DeskApiHost } from './deskApiTypes.js';
import { installDeskRuntime } from './deskRuntime.js';
import { createDeskServices } from './deskServices.js';
import { createDisposerRegistry } from './disposerRegistry.js';
import { handleFsRequest } from './fsApi.js';
import { handleGitRequest } from './gitApi.js';
import type { DeskPlugin, DeskRoute } from './plugin.js';
import { loadPluginsFromEnv } from './pluginLoader.js';
import { handleProjectsRequest } from './projectsApi.js';
import { createLspRoutes } from './routes/lspRoutes.js';
import { createSessionsRoutes } from './routes/sessionsRoutes.js';
import { createSettingsRoutes } from './routes/settingsRoutes.js';
import { createSystemRoutes } from './routes/systemRoutes.js';
import { createProfileRoutes } from './routes/profileRoutes.js';
import { createTerminalRoutes } from './routes/terminalRoutes.js';

export type { DeskApiHost } from './deskApiTypes.js';
export { applySettingsPatch } from './routes/settingsRoutes.js';
export {
  collectGroupDeleteSessions,
  collectMoveSourceSessions,
  collectProjectDeleteSessions,
  collectSessionDeleteTargets,
  findSessionForStart,
  validateSessionCwd
} from './routes/sessionsRoutes.js';

export interface InstallDeskApiOptions {
  plugins?: DeskPlugin[];
  /** Test seam for proving Channels ownership gates every startup side effect. */
  acquireChannelsOwner?: (home: string) => ChannelsRuntimeOwner;
}

/**
 * Compose the Desk backend onto a Vite, preview, or standalone host. Service
 * construction, runtime lifecycle, route behavior, and disposal live in their
 * owning modules; this function only wires those boundaries together.
 */
export function installDeskApi(host: DeskApiHost, options: InstallDeskApiOptions = {}): void {
  const channelsOwner = (options.acquireChannelsOwner ?? acquireChannelsRuntimeOwner)(
    resolveChannelsHome()
  );
  try {
    const plugins = options.plugins ?? [];
    const services = createDeskServices(host.httpServer);
    const disposers = createDisposerRegistry();
    installDeskRuntime({ host, services, plugins, disposers, channelsOwner });

    for (const plugin of plugins) {
      for (const middleware of plugin.middleware ?? []) {
        host.middlewares.use(middleware);
      }
    }

    const routes: DeskRoute[] = [
      (req, res, url) => handleFsRequest(req, res, url, { fileOperationCoordinator: services.lspFileOperationCoordinator }),
      handleGitRequest,
      handleProjectsRequest,
      (req, res, url) => handleAgentSessionInjectRequest(req, res, url, { broker: services.agentSurfaceBroker }),
      handleChannelsRequest,
      createLspRoutes({ httpEndpoint: services.lspHttpEndpoint, languageDetector: services.lspLanguageDetector }),
      createSettingsRoutes(),
      createSystemRoutes(services.managedAgentLsp),
      createSessionsRoutes({
        managedAgentLsp: services.managedAgentLsp,
        nativeAgentLaunch: services.nativeAgentLaunch,
        agentSurfaceBroker: services.agentSurfaceBroker
      }),
      createTerminalRoutes(),
      createProfileRoutes(),
      ...plugins.flatMap((plugin) => plugin.routes ?? [])
    ];
    host.middlewares.use(createDeskApiMiddleware(routes));
  } catch (error) {
    channelsOwner.release();
    throw error;
  }
}

export function deskApiPlugin(options: InstallDeskApiOptions = {}): Plugin {
  const toHost = (server: ViteDevServer | PreviewServer): DeskApiHost => ({
    httpServer: server.httpServer as NodeHttpServer | null,
    middlewares: server.middlewares
  });
  const resolvePlugins = async (): Promise<DeskPlugin[]> =>
    options.plugins ?? (await loadPluginsFromEnv());
  return {
    name: 'desk-api',
    configureServer: async (server) => installDeskApi(toHost(server), {
      plugins: await resolvePlugins(),
      acquireChannelsOwner: options.acquireChannelsOwner
    }),
    configurePreviewServer: async (server) => installDeskApi(toHost(server), {
      plugins: await resolvePlugins(),
      acquireChannelsOwner: options.acquireChannelsOwner
    })
  };
}
