import { spawnSync } from 'node:child_process';
import { statSync, type Stats } from 'node:fs';
import type { Server as NodeHttpServer } from 'node:http';
import { readJsonBody, sendJson } from './httpUtil.js';
import type { DeskPlugin, DeskRoute } from './plugin.js';
import { loadPluginsFromEnv } from './pluginLoader.js';
import { handleFsRequest } from './fsApi.js';
import { handleGitRequest } from './gitApi.js';
import { handleProjectsRequest } from './projectsApi.js';
import { handleAgentSessionInjectRequest } from './agentSessionsApi.js';
import { disposeChannelsRuntime, handleChannelsRequest, initChannelsRuntime } from './channelsApi.js';
import { installFsWatchBridge } from './fsWatchBridge.js';
import { installLspWebSocketBridge } from './lspWebSocketBridge.js';
import { createLspCapabilityTokenRegistry } from './lsp/capabilityTokenRegistry.js';
import { createCodeActionService } from './lsp/codeActionService.js';
import { createCompletionService } from './lsp/completionService.js';
import { LspDiagnosticsStore } from './lsp/diagnosticsStore.js';
import { createDiagnosticsService } from './lsp/diagnosticsService.js';
import { createDocumentHighlightService } from './lsp/documentHighlightService.js';
import { createDocumentSymbolService } from './lsp/documentSymbolService.js';
import { createEditorSharedSessionFactory } from './lsp/editorSharedSessionFactory.js';
import { createFormattingService } from './lsp/formattingService.js';
import { createFoldingRangeService } from './lsp/foldingRangeService.js';
import { createHoverService } from './lsp/hoverService.js';
import { createLspHttpEndpoint } from './lsp/lspHttpEndpoint.js';
import { createLspFileOperationCoordinator } from './lsp/lspFileOperationCoordinator.js';
import { createLspLanguageDetector } from './lsp/languageDetection.js';
import { createLspWarmSessionCoordinator } from './lsp/warmSessionCoordinator.js';
import { createLocationService } from './lsp/locationService.js';
import { LspManager } from './lsp/manager.js';
import { createManagedAgentLspWiring } from './lsp/managedAgentLspWiring.js';
import { createRenameService } from './lsp/renameService.js';
import { createLspRequestApi } from './lsp/requestApi.js';
import { createSelectionRangeService } from './lsp/selectionRangeService.js';
import { createSemanticTokensService } from './lsp/semanticTokensService.js';
import { planLspRequest } from './lsp/requestPlanner.js';
import { normalizeLspSettings, type NormalizedLspSettings } from './lsp/settings.js';
import { createSignatureHelpService } from './lsp/signatureHelpService.js';
import { forceKillActiveStdioVirtualSessionChildren } from './lsp/stdioVirtualSession.js';
import { homedir } from 'node:os';
import type { Connect, Plugin, PreviewServer, ViteDevServer } from 'vite';

/**
 * The minimal host the Desk backend needs: a Node http server (for the
 * terminal/fs WebSocket bridges) and a connect-style middleware stack (for the
 * `/api` router). Both `ViteDevServer` and `PreviewServer` satisfy this, and so
 * does a hand-rolled `connect()` app — which is how the standalone production
 * server (`src/server/standalone.ts`) reuses the exact same backend without Vite
 * in the runtime.
 */
export interface DeskApiHost {
  httpServer: NodeHttpServer | null;
  middlewares: Connect.Server;
}

/** Options for {@link installDeskApi}. */
export interface InstallDeskApiOptions {
  /** Extension plugins contributing middleware, routes, and upgrade guards. */
  plugins?: DeskPlugin[];
}
import {
  addGroupToProjectManifest,
  addGroupToManifest,
  addProjectToManifest,
  addSessionToProjectManifest,
  addSessionToManifest,
  deleteGroupFromManifest,
  deleteProjectFromManifest,
  deleteSessionFromManifest,
  editGroupInManifest,
  editProjectInManifest,
  editSessionInManifest,
  moveSessionInManifest,
  readManifestFile,
  reorderGroupsInManifest,
  reorderProjectsInManifest,
  reorderSessionsInManifest,
  resolveManifestPath,
  setGroupLayoutSizesInManifest,
  writeManifestFile,
  type MoveProjectSessionOptions
} from '../core/config.js';
import { applyLspUiSettingsPatch, toClientSettings } from '../core/lspSettings.js';
import { buildSessionSpecs, expandHome, sessionSupportsNativeUiMode } from '../core/manifest.js';
import { createInFlightGuard, performUiModeSwitch, validateUiModeSwitch } from './uiModeSwitch.js';
import { rewriteNativeLaunchCommand } from './agentHostLaunch.js';
import { deriveAgentHostToken, getOrCreateAgentHostSecret } from './agentHostToken.js';
import { killSession, listTmuxSessions, listTmuxSessionsCached, loadDesk, planDeskUp, restartSession, runPlan, startSession } from '../core/runner.js';
import { attentionTracker, notifyAgentSignal, setRaiseListener, startAttentionPolling, type AgentEventKind } from './attention.js';
import {
  attemptResumeCaptureForSession,
  isValidResumeId,
  persistSessionResume,
  restorePendingResumeCaptures,
  scheduleCodexResumeCapture,
  scheduleOpencodeResumeCapture
} from './resumeCapture.js';
import { executeKillSwitch } from './killSwitch.js';
import { buildDeskSnapshot } from './snapshot.js';
import { getSystemSnapshot, startSystemSampling } from './systemSampler.js';
import { createDefaultTerminalBroker, installTerminalBroker } from './terminalBroker.js';
import { AgentSurfaceBroker, installAgentSurfaceBroker } from './agentSurfaceBroker.js';
import {
  captureTmuxPane,
  installTerminalBridge,
  repaintTmuxWindow,
  repairTinyTmuxWindows,
  resizeAttachedTerminals,
  resizeTmuxWindow,
  scrollTmuxPane
} from './terminalBridge.js';
import type {
  DeskGroupLayout,
  DeskLayoutKind,
  DeskLayoutSizes,
  DeskManifest,
  DeskSession,
  DeskSettings,
  SessionSpec,
  TmuxPlanAction
} from '../core/types.js';
import { normalizeAgentEventForApi } from './agentEvents.js';

// Install the full Desk backend — the `/api` router and the terminal /
// terminal-broker / fs-watch / lsp WebSocket bridges — onto any DeskApiHost.
// Used by the Vite plugin (dev + preview) AND by the standalone production
// server (src/server/standalone.ts), so all three run byte-identical request
// handling. Optional `plugins` contribute middleware, routes, and a single
// central WebSocket upgrade guard (see ./plugin.ts).
// One switch per tmux session at a time; safe as an in-process guard because a
// single desk server process owns tmux lifecycle for a manifest (spec §7).
const uiModeSwitchGuard = createInFlightGuard();

export function installDeskApi(server: DeskApiHost, options: InstallDeskApiOptions = {}): void {
  const plugins = options.plugins ?? [];
  const pluginRoutes: DeskRoute[] = plugins.flatMap((plugin) => plugin.routes ?? []);
  const upgradeGuards = plugins
    .map((plugin) => plugin.upgradeGuard)
    .filter((guard): guard is NonNullable<typeof guard> => typeof guard === 'function');
  const terminalBroker = createDefaultTerminalBroker();
  const agentSurfaceBroker = new AgentSurfaceBroker();
  const lspDiagnosticsStore = new LspDiagnosticsStore();
  const lspManager = new LspManager(undefined, { diagnosticsStore: lspDiagnosticsStore });
  const lspRequestPlanner = {
    planLspRequest(input: {
      settings: unknown;
      uri?: string;
      languageId?: string;
      workspaceRoot: string;
      feature: string;
    }) {
      return planLspRequest({ ...input, settings: input.settings as NormalizedLspSettings });
    }
  };
  const lspRequestApi = createLspRequestApi({
    getSettings: () => normalizeLspSettings(readManifestFile(resolveManifestPath()).settings?.lsp),
    hoverService: createHoverService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    formattingService: createFormattingService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    foldingRangeService: createFoldingRangeService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    documentSymbolService: createDocumentSymbolService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    completionService: createCompletionService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    signatureHelpService: createSignatureHelpService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    renameService: createRenameService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    documentHighlightService: createDocumentHighlightService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    locationService: createLocationService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    diagnosticsService: createDiagnosticsService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    codeActionService: createCodeActionService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    selectionRangeService: createSelectionRangeService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    semanticTokensService: createSemanticTokensService({ requestPlanner: lspRequestPlanner, manager: lspManager })
  });
  const rawLspCapabilityTokens = createLspCapabilityTokenRegistry();
  const activeLspCapabilityTokens = new Set<string>();
  const lspCapabilityTokens: ReturnType<typeof createLspCapabilityTokenRegistry> = {
    mint(workspaceRoot) {
      const minted = rawLspCapabilityTokens.mint(workspaceRoot);
      activeLspCapabilityTokens.add(minted.token);
      return minted;
    },
    resolve(token) {
      return rawLspCapabilityTokens.resolve(token);
    },
    revoke(token) {
      activeLspCapabilityTokens.delete(token);
      rawLspCapabilityTokens.revoke(token);
    },
    dispose() {
      activeLspCapabilityTokens.clear();
      rawLspCapabilityTokens.dispose();
    }
  };
  const lspHttpEndpoint = createLspHttpEndpoint({ tokenRegistry: lspCapabilityTokens, requestApi: lspRequestApi });
  const lspLanguageDetector = createLspLanguageDetector({
    readManifest: () => readManifestFile(resolveManifestPath())
  });
  const lspWarmSessions = createLspWarmSessionCoordinator({
    manager: lspManager,
    languageDetector: lspLanguageDetector,
    readManifest: () => readManifestFile(resolveManifestPath())
  });
  const lspFileOperationCoordinator = createLspFileOperationCoordinator({
    manager: lspManager,
    responseSecrets: () => [...activeLspCapabilityTokens]
  });
  const managedAgentLsp = createManagedAgentLspWiring({
    tokenRegistry: lspCapabilityTokens,
    getApiBaseUrl: () => canonicalLocalApiBaseUrl(server.httpServer)
  });
  // Native-mode launch enrichment (spec §5): applied LAST at every spawn site
  // so the agent-host command wins over any earlier spec rewrite. Without a
  // resolvable server URL the spec passes through unenriched and the host
  // fails visibly in its pane.
  const nativeAgentLaunch = (spec: SessionSpec): SessionSpec => {
    if (spec.uiMode !== 'native') {
      return spec;
    }
    const serverUrl = canonicalLocalApiBaseUrl(server.httpServer);
    if (!serverUrl) {
      return spec;
    }
    const secret = getOrCreateAgentHostSecret();
    return rewriteNativeLaunchCommand(spec, {
      serverUrl,
      token: deriveAgentHostToken(secret, spec.tmuxSession, spec.agent ?? '')
    });
  };
      if (server.httpServer) {
        // Single, central WebSocket upgrade guard. Registered BEFORE the bridges
        // so it runs first: any plugin guard that rejects closes the socket, and
        // the bridges (which keep their own per-path 'upgrade' listeners) bail on
        // an already-destroyed socket. This is the one place WS auth is decided —
        // bridges stay auth-agnostic.
        if (upgradeGuards.length > 0) {
          server.httpServer.on('upgrade', (request, socket) => {
            if (!upgradeGuards.every((guard) => guard(request))) {
              socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
              socket.destroy();
            }
          });
        }
        installTerminalBridge(server.httpServer);
        const disposeTerminalBroker = installTerminalBroker(server.httpServer, terminalBroker);
        server.httpServer.once('close', disposeTerminalBroker);
        // Native UI mode broker — Phase 2 server core. Two WS endpoints:
        // /ws/agent-host (adapter hosts) and /ws/agent-ui (browser surfaces).
        const disposeAgentSurfaceBroker = installAgentSurfaceBroker(server.httpServer, agentSurfaceBroker);
        server.httpServer.once('close', disposeAgentSurfaceBroker);
        // installFsWatchBridge only listens for 'upgrade'; vite's union type
        // includes Http2SecureServer which is structurally fine for that.
        installFsWatchBridge(server.httpServer as NodeHttpServer);
        const disposeLspBridge = installLspWebSocketBridge(server.httpServer as NodeHttpServer, {
          createSession: createEditorSharedSessionFactory({
            manager: lspManager,
            warmSessions: lspWarmSessions,
            readManifest: () => readManifestFile(resolveManifestPath())
          })
        });
        lspWarmSessions.scheduleBootWarmup();
        server.httpServer.once('close', () => {
          disposeLspBridge();
          lspWarmSessions.dispose();
          forceKillActiveStdioVirtualSessionChildren();
        });
        server.httpServer.once('close', () => {
          managedAgentLsp.cleanupAll();
          lspCapabilityTokens.dispose();
          void lspManager.stopAll();
        });
      }
      // Plugin lifecycle: setup() runs once; an optional returned fn runs on close.
      for (const plugin of plugins) {
        const dispose = plugin.setup?.({
          httpServer: server.httpServer,
          onClose: (fn) => server.httpServer?.once('close', fn)
        });
        if (dispose) {
          server.httpServer?.once('close', dispose);
        }
      }
      startAttentionPolling();
      startSystemSampling();
      // Channels engine: watcher + per-agent delivery queues (gated on agent signals).
      initChannelsRuntime({ agentSurfaceBroker });
      restorePendingResumeCaptures(loadDesk({}).sessions);
      // Editing src/server/* restarts the vite server inside the SAME Node
      // process: the replacement plugin instance builds a fresh runtime, so
      // the outgoing one must stop acting or every message double-delivers.
      server.httpServer?.once('close', () => disposeChannelsRuntime());
      // First notification of a resume-less codex session: harvest its thread id.
      setRaiseListener((tmuxSession) => {
        attemptResumeCaptureForSession(tmuxSession, () =>
          loadDesk({}).sessions.find((candidate) => candidate.tmuxSession === tmuxSession)
        );
      });
      // OSC 9 notifications (codex tui.notification_method=osc9) must traverse tmux.
      spawnSync('tmux', ['set-option', '-g', 'allow-passthrough', 'on'], { encoding: 'utf8' });
      repairConfiguredTinyWindows();

      // Plugin middlewares, mounted first so they run before the API router and
      // Vite's own static/transform middlewares — every request (UI, assets and
      // /api alike) flows through them. With no plugins this is a no-op and Desk
      // stays open (local-trust), behavior unchanged.
      for (const plugin of plugins) {
        for (const middleware of plugin.middleware ?? []) {
          server.middlewares.use(middleware);
        }
      }

      server.middlewares.use(async (req, res, next) => {
        try {
          if (!req.url?.startsWith('/api/')) {
            next();
            return;
          }

          const url = new URL(req.url, 'http://desk.local');

          if (await handleFsRequest(req, res, url, { fileOperationCoordinator: lspFileOperationCoordinator })) {
            return;
          }

          if (await handleGitRequest(req, res, url)) {
            return;
          }

          if (await handleProjectsRequest(req, res, url)) {
            return;
          }

          if (await handleAgentSessionInjectRequest(req, res, url, { broker: agentSurfaceBroker })) {
            return;
          }

          if (await handleChannelsRequest(req, res, url)) {
            return;
          }

          if (await lspHttpEndpoint.handleNodeRequest(req, res, url)) {
            return;
          }

          if (req.method === 'GET' && url.pathname === '/api/lsp/detected-languages') {
            try {
              const result = await lspLanguageDetector.detect({
                root: url.searchParams.get('root') ?? '',
                refresh: url.searchParams.get('refresh') === '1'
              });
              sendJson(res, 200, result);
            } catch {
              sendJson(res, 400, { error: 'invalid root' });
            }
            return;
          }

          if (req.method === 'GET' && url.pathname === '/api/desk') {
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'GET' && url.pathname === '/api/system') {
            sendJson(res, 200, getSystemSnapshot());
            return;
          }

          if (req.method === 'GET' && url.pathname === '/api/settings') {
            const manifest = readManifestFile(resolveManifestPath());
            sendJson(res, 200, toClientSettings(manifest.settings));
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/settings') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const settings = applySettingsPatch(manifest.settings, body);
            writeManifestFile(manifestPath, { ...manifest, settings });
            sendJson(res, 200, toClientSettings(settings));
            return;
          }

          if (req.method === 'GET' && url.pathname === '/api/pulse') {
            // One request per client tick instead of two (/api/system +
            // /api/attention), carrying the live tmux session set so run
            // states self-heal without a full snapshot fetch. Attention is
            // reconciled here: dead sessions never show "needs input".
            // Everything served here is non-blocking: the system snapshot comes
            // from the background sampler's cache and the tmux list is TTL-cached,
            // so the pulse no longer stalls the loop carrying terminal output.
            const running = listTmuxSessionsCached();
            managedAgentLsp.reconcile(running);
            attentionTracker.dropDead(running);
            sendJson(res, 200, {
              system: getSystemSnapshot(),
              attention: {
                sessions: attentionTracker.snapshot(),
                events: attentionTracker.listEvents(),
                unread: attentionTracker.unreadCount()
              },
              running: [...running]
            });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/api/attention') {
            sendJson(res, 200, {
              sessions: attentionTracker.snapshot(),
              events: attentionTracker.listEvents(),
              unread: attentionTracker.unreadCount()
            });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/attention-clear') {
            const body = await readJsonBody(req);
            attentionTracker.clear(readRequiredString(body.session, 'session'));
            sendJson(res, 200, { ok: true });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/attention-read') {
            const body = await readJsonBody(req);
            if (body.clear === true) {
              attentionTracker.clearEvents();
              sendJson(res, 200, { ok: true, unread: 0 });
              return;
            }
            attentionTracker.markEventsRead({
              all: body.all === true,
              ids: Array.isArray(body.ids) ? body.ids.map(String) : undefined,
              kinds: Array.isArray(body.kinds)
                ? (body.kinds.filter((kind: unknown) =>
                    kind === 'turn-complete' ||
                      kind === 'approval-requested' ||
                      kind === 'input-requested' ||
                      kind === 'bell' ||
                      kind === 'channel'
                  ) as AgentEventKind[])
                : undefined
            });
            sendJson(res, 200, { ok: true, unread: attentionTracker.unreadCount() });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/agent-event') {
            // Precision channel for external senders (agent hooks/plugins).
            const body = await readJsonBody(req);
            const normalized = normalizeAgentEventForApi(body);
            const session = normalized.event.session;
            if (normalized.attentionKind) {
              attentionTracker.raise(session);
              attentionTracker.pushEvent(
                session,
                normalized.attentionKind,
                typeof normalized.event.message === 'string' ? normalized.event.message.slice(0, 300) : undefined
              );
            }
            if (normalized.signalKind) {
              notifyAgentSignal(session, normalized.signalKind);
            }
            initChannelsRuntime().engine.handleAgentEvent(normalized.event);
            attemptResumeCaptureForSession(session, () =>
              loadDesk({}).sessions.find((candidate) => candidate.tmuxSession === session)
            );
            if (typeof normalized.resumeSessionId === 'string' && isValidResumeId(normalized.resumeSessionId)) {
              // First turn of a fresh claude session: harvest its id for resume.
              persistSessionResume(session, normalized.resumeSessionId);
            }
            sendJson(res, 200, { ok: true, kind: normalized.event.kind });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/kill-all') {
            const result = executeKillSwitch();
            managedAgentLsp.cleanupAll();
            sendJson(res, 200, result);
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/up') {
            const body = await readJsonBody(req);
            const dryRun = Boolean(body.dryRun);
            const desk = loadDesk({});
            const plan = planDeskUp(desk.sessions);
            const settings = readManifestFile(resolveManifestPath()).settings;
            const exitCode = dryRun ? runPlan(plan, true) : runManagedPlan(plan, settings, managedAgentLsp, nativeAgentLaunch);
            if (!dryRun && exitCode === 0) {
              for (const action of plan) {
                if (action.type === 'start') {
                  scheduleAgentResumeCapture(action.session);
                }
              }
            }
            sendJson(res, exitCode === 0 ? 200 : 500, {
              exitCode,
              actions: plan.map((action) => ({
                type: action.type,
                session: action.session.name,
                tmuxSession: action.session.tmuxSession
              }))
            });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/add') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const groupId = readRequiredString(body.groupId, 'groupId');
            const session = readDeskSessionBody(body.session);
            const updated = addSessionToManifest(manifest, {
              groupId,
              groupLabel: readOptionalString(body.groupLabel),
              session
            });
            const nextSession = findSessionForStart(updated, { groupId, sessionName: session.name });
            const cwdValidation = validateSessionCwd(nextSession);
            if (!cwdValidation.ok) {
              sendJson(res, 500, { error: cwdValidation.error });
              return;
            }
            const launch = managedAgentLsp.prepare(nextSession, updated.settings);
            const sessionToStart = nativeAgentLaunch(launch?.session ?? nextSession);
            const started = startSession(sessionToStart);
            if (!started.ok) {
              launch?.cleanup();
              sendJson(res, 500, { error: started.error });
              return;
            }
            writeManifestFile(manifestPath, updated);
            scheduleAgentResumeCapture(nextSession);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/add-group') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const updated = addGroupToManifest(manifest, {
              groupId: readRequiredString(body.groupId, 'groupId'),
              groupLabel: readOptionalString(body.groupLabel),
              layout: readLayoutBody(body.layout)
            });
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/add-project') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const updated = addProjectToManifest(manifest, {
              projectId: readRequiredString(body.projectId, 'projectId'),
              projectLabel: readOptionalString(body.projectLabel),
              cwd: readRequiredString(body.cwd, 'cwd')
            });
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/add-project-group') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const updated = addGroupToProjectManifest(manifest, {
              projectId: readRequiredString(body.projectId, 'projectId'),
              groupId: readRequiredString(body.groupId, 'groupId'),
              groupLabel: readOptionalString(body.groupLabel),
              layout: readLayoutBody(body.layout)
            });
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/add-project-session') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const session = readDeskSessionBody(body.session, { cwdRequired: false });
            const projectId = readRequiredString(body.projectId, 'projectId');
            const groupId = readRequiredString(body.groupId, 'groupId');
            const updated = addSessionToProjectManifest(manifest, {
              projectId,
              groupId,
              session
            });
            const nextSession = findSessionForStart(updated, { groupId, sessionName: session.name, projectId });
            const cwdValidation = validateSessionCwd(nextSession);
            if (!cwdValidation.ok) {
              sendJson(res, 500, { error: cwdValidation.error });
              return;
            }
            const launch = managedAgentLsp.prepare(nextSession, updated.settings);
            const sessionToStart = nativeAgentLaunch(launch?.session ?? nextSession);
            const started = startSession(sessionToStart);
            if (!started.ok) {
              launch?.cleanup();
              sendJson(res, 500, { error: started.error });
              return;
            }
            writeManifestFile(manifestPath, updated);
            scheduleAgentResumeCapture(nextSession);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/edit-project') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const updated = editProjectInManifest(manifest, {
              projectId: readRequiredString(body.projectId, 'projectId'),
              projectLabel: readOptionalString(body.projectLabel),
              cwd: readRequiredString(body.cwd, 'cwd'),
              currentCwd: readOptionalString(body.currentCwd)
            });
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/delete-project') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const projectId = readRequiredString(body.projectId, 'projectId');
            const cwd = readOptionalString(body.cwd);
            const killed = killSessionTargets(
              collectProjectDeleteSessions(manifest, {
                projectId,
                cwd
              })
            );
            if (!killed.ok) {
              sendJson(res, 500, { error: killed.error });
              return;
            }
            for (const target of collectProjectDeleteSessions(manifest, { projectId, cwd })) {
              managedAgentLsp.cleanup(target.tmuxSession);
            }
            const updated = deleteProjectFromManifest(manifest, {
              projectId,
              cwd
            });
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/edit-project-group') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const updated = editGroupInManifest(manifest, {
              projectId: readRequiredString(body.projectId, 'projectId'),
              currentGroupId: readOptionalString(body.currentGroupId),
              groupId: readRequiredString(body.groupId, 'groupId'),
              groupLabel: readOptionalString(body.groupLabel),
              layout: readLayoutBody(body.layout),
              projectCwd: readOptionalString(body.projectCwd)
            });
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/delete-project-group') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const projectId = readRequiredString(body.projectId, 'projectId');
            const groupId = readRequiredString(body.groupId, 'groupId');
            const projectCwd = readOptionalString(body.projectCwd);
            const killed = killSessionTargets(
              collectGroupDeleteSessions(manifest, {
                projectId,
                groupId,
                projectCwd
              })
            );
            if (!killed.ok) {
              sendJson(res, 500, { error: killed.error });
              return;
            }
            for (const target of collectGroupDeleteSessions(manifest, { projectId, groupId, projectCwd })) {
              managedAgentLsp.cleanup(target.tmuxSession);
            }
            const updated = deleteGroupFromManifest(manifest, {
              projectId,
              groupId,
              projectCwd
            });
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/edit-project-session') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const session = readDeskSessionBody(body.session, { cwdRequired: false });
            const updated = editSessionInManifest(manifest, {
              projectId: readRequiredString(body.projectId, 'projectId'),
              groupId: readRequiredString(body.groupId, 'groupId'),
              currentName: readRequiredString(body.currentName, 'currentName'),
              projectCwd: readOptionalString(body.projectCwd),
              session
            });
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/delete-project-session') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const projectId = readRequiredString(body.projectId, 'projectId');
            const groupId = readRequiredString(body.groupId, 'groupId');
            const sessionName = readRequiredString(body.sessionName, 'sessionName');
            const projectCwd = readOptionalString(body.projectCwd);
            const tmuxSession = readOptionalString(body.tmuxSession);
            const targets = collectSessionDeleteTargets(manifest, {
              projectId,
              groupId,
              sessionName,
              projectCwd
            }).map((session) => session.tmuxSession);
            if (tmuxSession && !targets.includes(tmuxSession)) {
              targets.push(tmuxSession);
            }
            const killed = killSessionTargets(targets);
            if (!killed.ok) {
              sendJson(res, 500, { error: killed.error });
              return;
            }
            for (const target of targets) {
              managedAgentLsp.cleanup(target);
            }
            const updated = deleteSessionFromManifest(manifest, {
              projectId,
              groupId,
              sessionName,
              projectCwd
            });
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/restart-project-session') {
            const body = await readJsonBody(req);
            const tmuxSession = readRequiredString(body.tmuxSession, 'tmuxSession');
            const session = loadDesk({}).sessions.find((candidate) => candidate.tmuxSession === tmuxSession);
            if (!session) {
              sendJson(res, 404, { error: `session ${tmuxSession} does not exist in config` });
              return;
            }
            managedAgentLsp.cleanup(session.tmuxSession);
            const launch = managedAgentLsp.prepare(session, readManifestFile(resolveManifestPath()).settings);
            const restarted = restartSession(nativeAgentLaunch(launch?.session ?? session));
            if (!restarted.ok) {
              launch?.cleanup();
              sendJson(res, 500, { error: restarted.error });
              return;
            }
            scheduleAgentResumeCapture(session);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/set-session-ui-mode') {
            const body = await readJsonBody(req);
            const tmuxSession = readRequiredString(body.tmuxSession, 'tmuxSession');
            const uiMode = readRequiredString(body.uiMode, 'uiMode');
            if (uiMode !== 'terminal' && uiMode !== 'native') {
              sendJson(res, 400, { error: 'uiMode must be terminal or native', code: 'ui-mode-invalid' });
              return;
            }
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const validated = validateUiModeSwitch(manifest, {
              tmuxSession,
              uiMode,
              confirmDiscard: body.confirmDiscard === true,
              homeDir: homedir()
            });
            if (!validated.ok) {
              sendJson(res, validated.status, { error: validated.error, code: validated.code });
              return;
            }
            if (validated.noop) {
              sendJson(res, 200, buildDeskSnapshot());
              return;
            }
            if (!uiModeSwitchGuard.begin(tmuxSession)) {
              sendJson(res, 409, { error: `ui-mode switch already in progress for ${tmuxSession}`, code: 'switch-in-progress' });
              return;
            }
            try {
              let launch: ReturnType<typeof managedAgentLsp.prepare> | undefined;
              const result = await performUiModeSwitch(
                { manifest, validated, homeDir: homedir() },
                {
                  write: (next) => writeManifestFile(manifestPath, next),
                  prepare: (spec) => {
                    managedAgentLsp.cleanup(spec.tmuxSession);
                    launch = managedAgentLsp.prepare(spec, readManifestFile(manifestPath).settings);
                    return nativeAgentLaunch(launch?.session ?? spec);
                  },
                  restart: (spec) => restartSession(spec),
                  scheduleCapture: (spec) => scheduleAgentResumeCapture(spec)
                }
              );
              if (!result.ok) {
                launch?.cleanup();
                sendJson(res, result.status, { error: result.error });
                return;
              }
              sendJson(res, 200, buildDeskSnapshot());
            } finally {
              uiModeSwitchGuard.end(tmuxSession);
            }
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/move-project-session') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const updated = moveSessionInManifest(manifest, {
              sourceProjectId: readRequiredString(body.sourceProjectId, 'sourceProjectId'),
              sourceGroupId: readRequiredString(body.sourceGroupId, 'sourceGroupId'),
              sourceSessionName: readRequiredString(body.sourceSessionName, 'sourceSessionName'),
              sourceProjectCwd: readOptionalString(body.sourceProjectCwd),
              targetProjectId: readRequiredString(body.targetProjectId, 'targetProjectId'),
              targetGroupId: readRequiredString(body.targetGroupId, 'targetGroupId'),
              targetProjectCwd: readOptionalString(body.targetProjectCwd)
            });
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/group-layout-sizes') {
            // Persist drag-resized terminal split sizes for one group. Merges
            // into layout.sizes without touching kind/cells; fires on every
            // resize gesture (the client debounces). 204 = saved, no snapshot
            // needed (the client already holds the live sizes).
            const body = await readJsonBody(req);
            const sizes = readLayoutSizesBody(body.sizes);
            if (!sizes) {
              sendJson(res, 400, { error: 'sizes must contain rows[] and/or cols[][] of percentages' });
              return;
            }
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const updated = setGroupLayoutSizesInManifest(manifest, {
              projectId: readRequiredString(body.projectId, 'projectId'),
              groupId: readRequiredString(body.groupId, 'groupId'),
              projectCwd: readOptionalString(body.projectCwd),
              sizes
            });
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, { ok: true });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/reorder-projects') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const updated = reorderProjectsInManifest(manifest, readStringArray(body.orderedProjectIds, 'orderedProjectIds'));
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/reorder-groups') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const updated = reorderGroupsInManifest(manifest, {
              projectId: readRequiredString(body.projectId, 'projectId'),
              orderedGroupIds: readStringArray(body.orderedGroupIds, 'orderedGroupIds')
            });
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/reorder-sessions') {
            const body = await readJsonBody(req);
            const manifestPath = resolveManifestPath();
            const manifest = readManifestFile(manifestPath);
            const updated = reorderSessionsInManifest(manifest, {
              projectId: readRequiredString(body.projectId, 'projectId'),
              groupId: readRequiredString(body.groupId, 'groupId'),
              projectCwd: readOptionalString(body.projectCwd),
              orderedSessionNames: readStringArray(body.orderedSessionNames, 'orderedSessionNames')
            });
            writeManifestFile(manifestPath, updated);
            sendJson(res, 200, buildDeskSnapshot());
            return;
          }

          if (req.method === 'GET' && url.pathname === '/api/terminal-broker-metrics') {
            sendJson(res, 200, terminalBroker.metrics());
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/terminal-resize') {
            const body = await readJsonBody(req);
            const session = readRequiredString(body.session, 'session');
            const cols = readPositiveInteger(body.cols, 'cols');
            const rows = readPositiveInteger(body.rows, 'rows');
            const result = resizeTmuxWindow(session, cols, rows);
            if (!result.ok) {
              sendJson(res, 500, { error: result.error });
              return;
            }
            if (!('skipped' in result)) {
              resizeAttachedTerminals(session, result.cols, result.rows);
            }
            sendJson(res, 200, result);
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/terminal-repaint') {
            // Atomic replacement for the client-side stabilize dance (resize
            // to rows-1 then back, forcing tmux to repaint the full window at
            // its true size). One request instead of two, deduped per session
            // so several clients attaching at once repaint tmux once.
            const body = await readJsonBody(req);
            const session = readRequiredString(body.session, 'session');
            const result = repaintTmuxWindow(session);
            sendJson(res, result.ok ? 200 : 500, result.ok ? { ok: true, skipped: result.skipped ?? false } : { error: result.error });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/terminal-scroll') {
            const body = await readJsonBody(req);
            const session = readRequiredString(body.session, 'session');
            const lines = readBoundedInteger(body.lines, 'lines', -1000, 1000);
            const result = scrollTmuxPane(session, lines, { exitCopyMode: Boolean(body.exitCopyMode) });
            sendJson(res, result.ok ? 200 : 500, result.ok ? { ok: true } : { error: result.error });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/terminal-capture') {
            const body = await readJsonBody(req);
            const session = readRequiredString(body.session, 'session');
            const rows = readBoundedInteger(body.rows, 'rows', 1, 2000);
            const offset = readBoundedInteger(body.offset, 'offset', 0, 5000);
            const result = captureTmuxPane(session, rows, offset);
            sendJson(res, result.ok ? 200 : 500, result.ok ? { lines: result.lines } : { error: result.error });
            return;
          }

          // Plugin-contributed routes, tried after the core routes, before 404.
          for (const route of pluginRoutes) {
            if (await route(req, res, url)) {
              return;
            }
          }

          sendJson(res, 404, { error: `unknown API route ${url.pathname}` });
        } catch {
          sendJson(res, 500, { error: 'request failed' });
        }
      });
}

export function deskApiPlugin(options: InstallDeskApiOptions = {}): Plugin {
  // ViteDevServer / PreviewServer both expose a Node httpServer + a connect
  // middleware stack — adapt them to DeskApiHost and install the shared backend.
  const toHost = (server: ViteDevServer | PreviewServer): DeskApiHost => ({
    httpServer: server.httpServer as NodeHttpServer | null,
    middlewares: server.middlewares
  });
  // Plugins passed explicitly win; otherwise discover them from DESK_PLUGINS.
  const resolvePlugins = async (): Promise<DeskPlugin[]> =>
    options.plugins ?? (await loadPluginsFromEnv());
  return {
    name: 'desk-api',
    configureServer: async (server) => installDeskApi(toHost(server), { plugins: await resolvePlugins() }),
    configurePreviewServer: async (server) => installDeskApi(toHost(server), { plugins: await resolvePlugins() })
  };
}

function scheduleAgentResumeCapture(session: SessionSpec): void {
  scheduleCodexResumeCapture(session);
  scheduleOpencodeResumeCapture(session);
}


function readDeskSessionBody(value: unknown, options: { cwdRequired?: boolean } = {}): DeskSession {
  if (!value || typeof value !== 'object') {
    throw new Error('session body is required');
  }
  const record = value as Record<string, unknown>;
  const command = readOptionalString(record.command);
  const cwd = options.cwdRequired === false ? readOptionalString(record.cwd) : readRequiredString(record.cwd, 'session.cwd');
  const session: DeskSession = {
    name: readRequiredString(record.name, 'session.name')
  };
  if (cwd) {
    session.cwd = cwd;
  }

  if (command) {
    // Custom-command sessions are terminal-only; a native uiMode here is a client bug.
    if (record.uiMode === 'native') {
      throw new Error('session.uiMode native is not supported for custom-command sessions');
    }
    session.command = command;
    return session;
  }

  session.agent = readOptionalString(record.agent) ?? 'codex';
  session.resume = readOptionalString(record.resume);
  session.bypassPermissions = Boolean(record.bypassPermissions);
  const uiMode = readOptionalString(record.uiMode);
  if (uiMode !== undefined) {
    if (uiMode !== 'terminal' && uiMode !== 'native') {
      throw new Error('session.uiMode must be terminal or native');
    }
    if (uiMode === 'native') {
      if (!sessionSupportsNativeUiMode({ agent: session.agent })) {
        throw new Error(`session.uiMode native is not supported for agent ${session.agent}`);
      }
      session.uiMode = 'native';
    }
  }
  return session;
}

interface FindSessionForStartOptions {
  groupId: string;
  sessionName: string;
  projectId?: string;
  homeDir?: string;
}

interface DeleteTargetsOptions {
  projectId: string;
  groupId?: string;
  sessionName?: string;
  cwd?: string;
  projectCwd?: string;
  homeDir?: string;
}

type StatReader = (path: string) => Stats | undefined;

export function findSessionForStart(manifest: DeskManifest, options: FindSessionForStartOptions): SessionSpec {
  const sessions = buildSessionSpecs(manifest, {
    homeDir: options.homeDir ?? homedir()
  });
  const session = sessions.find(
    (candidate) =>
      candidate.groupId === options.groupId &&
      candidate.name === options.sessionName &&
      (options.projectId ? candidate.projectId === options.projectId : !candidate.projectId)
  );
  if (session) {
    return session;
  }
  throw new Error(`session ${options.sessionName} does not exist in config`);
}

export function validateSessionCwd(
  session: SessionSpec,
  stat: StatReader = (path) => {
    try {
      return statSync(path);
    } catch {
      return undefined;
    }
  }
): { ok: true } | { ok: false; error: string } {
  if (stat(session.cwd)?.isDirectory()) {
    return { ok: true };
  }
  return { ok: false, error: `cwd does not exist for ${session.name}: ${session.cwd}` };
}

export function collectProjectDeleteSessions(manifest: DeskManifest, options: DeleteTargetsOptions): SessionSpec[] {
  const cwd = normalizeOptionalCwd(options.cwd, options.homeDir);
  return buildManifestSessions(manifest, options.homeDir).filter(
    (session) =>
      session.projectId === options.projectId ||
      (!session.projectId && Boolean(cwd) && cwdMatchesResolved(session.cwd, cwd!))
  );
}

export function collectGroupDeleteSessions(manifest: DeskManifest, options: DeleteTargetsOptions): SessionSpec[] {
  const cwd = normalizeOptionalCwd(options.projectCwd, options.homeDir);
  return buildManifestSessions(manifest, options.homeDir).filter(
    (session) =>
      session.groupId === options.groupId &&
      (session.projectId === options.projectId ||
        (!session.projectId && Boolean(cwd) && cwdMatchesResolved(session.cwd, cwd!)))
  );
}

export function collectSessionDeleteTargets(manifest: DeskManifest, options: DeleteTargetsOptions): SessionSpec[] {
  const cwd = normalizeOptionalCwd(options.projectCwd, options.homeDir);
  return buildManifestSessions(manifest, options.homeDir).filter(
    (session) =>
      session.groupId === options.groupId &&
      session.name === options.sessionName &&
      (session.projectId === options.projectId ||
        (!session.projectId && Boolean(cwd) && cwdMatchesResolved(session.cwd, cwd!)))
  );
}

export function collectMoveSourceSessions(
  manifest: DeskManifest,
  options: MoveProjectSessionOptions & { homeDir?: string }
): SessionSpec[] {
  const cwd = normalizeOptionalCwd(options.sourceProjectCwd, options.homeDir);
  return buildManifestSessions(manifest, options.homeDir).filter(
    (session) =>
      session.groupId === options.sourceGroupId &&
      session.name === options.sourceSessionName &&
      (session.projectId === options.sourceProjectId ||
        (!session.projectId && Boolean(cwd) && cwdMatchesResolved(session.cwd, cwd!)))
  );
}

function buildManifestSessions(manifest: DeskManifest, homeDir = homedir()): SessionSpec[] {
  return buildSessionSpecs(manifest, { homeDir });
}

function normalizeOptionalCwd(cwd: string | undefined, homeDir = homedir()): string | undefined {
  return cwd ? expandHome(cwd, homeDir) : undefined;
}

function cwdMatchesResolved(left: string, right: string): boolean {
  return left.replace(/\/+$/, '') === right.replace(/\/+$/, '');
}

function killSessionTargets(targets: Array<SessionSpec | string>): { ok: boolean; error?: string } {
  const tmuxSessions = targets.map((target) => (typeof target === 'string' ? target : target.tmuxSession));
  for (const tmuxSession of [...new Set(tmuxSessions)]) {
    const killed = killSession(tmuxSession);
    if (!killed.ok) {
      return killed;
    }
  }
  return { ok: true };
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

function readLayoutBody(value: unknown): DeskGroupLayout | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const kind = readOptionalString(record.kind);
  if (!kind) {
    return undefined;
  }
  if (!['1x1', '2x2', '3x3', '4x4', 'custom', 'linear'].includes(kind)) {
    throw new Error('layout.kind must be 1x1, 2x2, 3x3, 4x4, custom, or linear');
  }
  return {
    kind: kind as DeskLayoutKind,
    cells: typeof record.cells === 'number' ? readBoundedInteger(record.cells, 'layout.cells', 1, 16) : undefined,
    sizes: readLayoutSizesBody(record.sizes)
  };
}

/** Validates persisted panel-split sizes: rows[] and cols[][] of finite percentages. */
function readLayoutSizesBody(value: unknown): DeskLayoutSizes | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const toPctArray = (input: unknown): number[] | undefined => {
    if (!Array.isArray(input)) {
      return undefined;
    }
    const nums = input.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100);
    return nums.length === input.length && nums.length > 0 ? nums : undefined;
  };
  const rows = toPctArray(record.rows);
  const cols = Array.isArray(record.cols)
    ? record.cols.map((row) => toPctArray(row)).filter((row): row is number[] => Boolean(row))
    : undefined;
  if (!rows && (!cols || cols.length === 0)) {
    return undefined;
  }
  const sizes: DeskLayoutSizes = {};
  if (rows) {
    sizes.rows = rows;
  }
  if (cols && cols.length > 0) {
    sizes.cols = cols;
  }
  return sizes;
}

export function applySettingsPatch(current: DeskSettings | undefined, body: Record<string, unknown>): DeskSettings {
  const settings: DeskSettings = { ...(current ?? {}) };
  if (typeof body.theme === 'string') {
    settings.theme = body.theme;
  }
  if (typeof body.muted === 'boolean') {
    settings.muted = body.muted;
  }
  if (body.editor && typeof body.editor === 'object') {
    const editor = body.editor as Record<string, unknown>;
    const next = { ...(settings.editor ?? {}) };
    if (typeof editor.root === 'string') {
      next.root = editor.root;
    }
    if (Array.isArray(editor.openFiles)) {
      next.openFiles = editor.openFiles.filter((file): file is string => typeof file === 'string');
    }
    if (typeof editor.activeFile === 'string') {
      next.activeFile = editor.activeFile;
    } else if (editor.activeFile === null) {
      delete next.activeFile;
    }
    if (editor.autosave === 'off' || editor.autosave === 'after-delay' || editor.autosave === 'on-focus-change') {
      next.autosave = editor.autosave;
    }
    if (typeof editor.autosaveDelayMs === 'number' && Number.isFinite(editor.autosaveDelayMs)) {
      next.autosaveDelayMs = Math.min(30_000, Math.max(250, Math.round(editor.autosaveDelayMs)));
    }
    settings.editor = next;
  }
  if (body.sidebars && typeof body.sidebars === 'object') {
    // Per-key merge: each subsystem persists only its own width.
    const sidebars = { ...(settings.sidebars ?? {}) };
    for (const [key, value] of Object.entries(body.sidebars as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        sidebars[key] = Math.min(560, Math.max(180, Math.round(value)));
      }
    }
    settings.sidebars = sidebars;
  }
  if (body.lsp && typeof body.lsp === 'object') {
    settings.lsp = applyLspUiSettingsPatch(settings.lsp, body.lsp);
  }
  return settings;
}

function canonicalLocalApiBaseUrl(httpServer: { address(): unknown } | null | undefined): string | undefined {
  const address = httpServer?.address();
  if (
    !address ||
    typeof address === 'string' ||
    typeof address !== 'object' ||
    !('port' in address) ||
    typeof address.port !== 'number'
  ) {
    return undefined;
  }
  return `http://127.0.0.1:${address.port}`;
}

function runManagedPlan(
  plan: TmuxPlanAction[],
  settings: DeskSettings | undefined,
  managedAgentLsp: ReturnType<typeof createManagedAgentLspWiring>,
  nativeAgentLaunch: (spec: SessionSpec) => SessionSpec = (spec) => spec
): number {
  for (const action of plan) {
    if (action.type === 'preserve') {
      continue;
    }
    const launch = managedAgentLsp.prepare(action.session, settings);
    const started = startSession(nativeAgentLaunch(launch?.session ?? action.session));
    if (!started.ok) {
      launch?.cleanup();
      return 1;
    }
  }
  return 0;
}

function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function readStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value as string[];
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 1000) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function readBoundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
