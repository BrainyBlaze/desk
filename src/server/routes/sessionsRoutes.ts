import { statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
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
  updateManifestFile,
  withManifestFileLock,
  writeManifestFile,
  type MoveProjectSessionOptions
} from '../../core/config.js';
import { buildSessionSpecs, expandHome, sessionSupportsNativeUiMode } from '../../core/manifest.js';
import {
  killSession,
  loadDesk,
  planDeskUp,
  runningSessionSet,
  runPlan
} from '../../core/runner.js';
import {
  restartSessionNativeAware,
  retireNativeSession,
  retireStaleIdentityForEdit,
  startSessionNativeAware
} from '../runtime/nativeSessionControl.js';
import type {
  DeskGroupLayout,
  DeskLayoutKind,
  DeskLayoutSizes,
  DeskManifest,
  DeskSessionDraft,
  DeskSettings,
  SessionSpec,
  SessionPlanAction
} from '../../core/types.js';
import { ApiValidationError, readBoundedInteger, readOptionalString, readRequiredString, readStringArray } from '../apiValidation.js';
import type { AgentSurfaceBroker } from '../agentSurfaceBroker.js';
import { deleteToolJournal } from '../agents/host/toolJournal.js';
import { shouldRespawnAfterEdit } from '../editRespawn.js';
import { readJsonBody, sendJson } from '../httpUtil.js';
import type { DeskRoute } from '../plugin.js';
import { scheduleCodexResumeCapture, scheduleOpencodeResumeCapture } from '../resumeCapture.js';
import { buildDeskSnapshot } from '../snapshot.js';
import { createInFlightGuard, performUiModeSwitch, validateUiModeSwitch } from '../uiModeSwitch.js';

type ManagedAgentLsp = ReturnType<typeof import('../lsp/managedAgentLspWiring.js').createManagedAgentLspWiring>;

interface SessionsRoutesOptions {
  managedAgentLsp: ManagedAgentLsp;
  nativeAgentLaunch(spec: SessionSpec, lspEnvFilePath?: string): SessionSpec;
  agentSurfaceBroker: Pick<AgentSurfaceBroker, 'disposeSession'>;
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

const uiModeSwitchGuard = createInFlightGuard();

function scheduleAgentResumeCapture(session: SessionSpec): void {
  scheduleCodexResumeCapture(session);
  scheduleOpencodeResumeCapture(session);
}

export function readDeskSessionBody(value: unknown, options: { cwdRequired?: boolean } = {}): DeskSessionDraft {
  if (!value || typeof value !== 'object') {
    throw new ApiValidationError('session body is required');
  }
  const record = value as Record<string, unknown>;
  const command = readOptionalString(record.command);
  const cwd = options.cwdRequired === false ? readOptionalString(record.cwd) : readRequiredString(record.cwd, 'session.cwd');
  // A DRAFT, deliberately without identity: the API body never carries a
  // sessionId — config is the single allocator/preserver of durable identity.
  const session: DeskSessionDraft = {
    name: readRequiredString(record.name, 'session.name')
  };
  if (cwd) {
    session.cwd = cwd;
  }

  const agent = readOptionalString(record.agent);
  if (agent) {
    session.agent = agent;
  }
  const resume = readOptionalString(record.resume);
  if (resume) {
    session.resume = resume;
  }
  if (record.bypassPermissions !== undefined) {
    session.bypassPermissions = Boolean(record.bypassPermissions);
  }

  if (command) {
    if (record.uiMode === 'native') {
      throw new ApiValidationError('session.uiMode native is not supported for custom-command sessions');
    }
    session.command = command;
    return session;
  }

  session.agent ??= 'codex';
  session.bypassPermissions = Boolean(record.bypassPermissions);
  const uiMode = readOptionalString(record.uiMode);
  if (uiMode !== undefined) {
    if (uiMode !== 'terminal' && uiMode !== 'native') {
      throw new ApiValidationError('session.uiMode must be terminal or native');
    }
    if (uiMode === 'native' && !sessionSupportsNativeUiMode({ agent: session.agent })) {
      throw new ApiValidationError(`session.uiMode native is not supported for agent ${session.agent}`);
    }
    session.uiMode = uiMode;
  }
  const model = readOptionalString(record.model);
  if (model) {
    session.model = model;
  }
  return session;
}

export function findSessionForStart(manifest: DeskManifest, options: FindSessionForStartOptions): SessionSpec {
  const sessions = buildSessionSpecs(manifest, { homeDir: options.homeDir ?? homedir() });
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

export async function killSessionTargets(targets: Array<SessionSpec | string>): Promise<{ ok: boolean; error?: string }> {
  // A session's atch master is keyed by sessionId; retire via the daemon so a
  // delete leaves no orphan master. A bare-string target retires best-effort;
  // retire is idempotent, so an unknown session is a harmless no-op.
  const ids = [...new Set(targets.map((target) => (typeof target === 'string' ? target : target.sessionId)))];
  for (const sessionId of ids) {
    const retired = await retireNativeSession(sessionId);
    if (!retired.ok) {
      return retired;
    }
  }
  return { ok: true };
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
    throw new ApiValidationError('layout.kind must be 1x1, 2x2, 3x3, 4x4, custom, or linear');
  }
  return {
    kind: kind as DeskLayoutKind,
    cells: typeof record.cells === 'number' ? readBoundedInteger(record.cells, 'layout.cells', 1, 16) : undefined,
    sizes: readLayoutSizesBody(record.sizes)
  };
}

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

export interface ManagedPlanResult {
  exitCode: number;
  error?: string;
}

export async function runManagedPlan(
  plan: SessionPlanAction[],
  settings: DeskSettings | undefined,
  managedAgentLsp: ManagedAgentLsp,
  nativeAgentLaunch: (spec: SessionSpec, lspEnvFilePath?: string) => SessionSpec,
  start: (session: SessionSpec) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }> = startSessionNativeAware
): Promise<ManagedPlanResult> {
  for (const action of plan) {
    if (action.type === 'preserve') {
      continue;
    }
    const launch = managedAgentLsp.prepare(action.session, settings);
    const started = await start(nativeAgentLaunch(launch?.session ?? action.session, launch?.envFilePath));
    if (!started.ok) {
      launch?.cleanup();
      return { exitCode: 1, error: started.error ?? `start failed for ${action.session.sessionId}` };
    }
  }
  return { exitCode: 0 };
}

export function createSessionsRoutes(options: SessionsRoutesOptions): DeskRoute {
  const { managedAgentLsp, nativeAgentLaunch, agentSurfaceBroker } = options;
  return async (req, res, url) => {
    if (req.method === 'POST' && url.pathname === '/api/up') {
      const body = await readJsonBody(req);
      const dryRun = Boolean(body.dryRun);
      const desk = loadDesk({});
      const plan = planDeskUp(desk.sessions);
      const settings = readManifestFile(resolveManifestPath()).settings;
      const result = dryRun
        ? { exitCode: await runPlan(plan, true) }
        : await runManagedPlan(plan, settings, managedAgentLsp, nativeAgentLaunch);
      const { exitCode } = result;
      if (!dryRun && exitCode === 0) {
        for (const action of plan) {
          if (action.type === 'start') {
            scheduleAgentResumeCapture(action.session);
          }
        }
      }
      sendJson(res, exitCode === 0 ? 200 : 500, {
        exitCode,
        ...('error' in result && result.error ? { error: result.error } : {}),
        actions: plan.map((action) => ({
          type: action.type,
          session: action.session.name,
          sessionId: action.session.sessionId
        }))
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/add') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      const groupId = readRequiredString(body.groupId, 'groupId');
      const session = readDeskSessionBody(body.session);
      let nextSession: SessionSpec | undefined;
      let addError: string | undefined;
      const updated = await updateManifestFile(manifestPath, async (manifest) => {
        const next = addSessionToManifest(manifest, {
          groupId,
          groupLabel: readOptionalString(body.groupLabel),
          session
        });
        nextSession = findSessionForStart(next, { groupId, sessionName: session.name });
        const cwdValidation = validateSessionCwd(nextSession);
        if (!cwdValidation.ok) {
          addError = cwdValidation.error;
          return null;
        }
        const launch = managedAgentLsp.prepare(nextSession, next.settings);
        const started = await startSessionNativeAware(nativeAgentLaunch(launch?.session ?? nextSession, launch?.envFilePath));
        if (!started.ok) {
          launch?.cleanup();
          addError = started.error;
          return null;
        }
        return next;
      });
      if (!updated || !nextSession) {
        sendJson(res, 500, { error: addError ?? 'session add failed' });
        return true;
      }
      scheduleAgentResumeCapture(nextSession);
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/add-group') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      await updateManifestFile(manifestPath, (manifest) => {
        return addGroupToManifest(manifest, {
          groupId: readRequiredString(body.groupId, 'groupId'),
          groupLabel: readOptionalString(body.groupLabel),
          layout: readLayoutBody(body.layout)
        });
      });
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/add-project') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      await updateManifestFile(manifestPath, (manifest) => {
        return addProjectToManifest(manifest, {
          projectId: readRequiredString(body.projectId, 'projectId'),
          projectLabel: readOptionalString(body.projectLabel),
          cwd: readRequiredString(body.cwd, 'cwd')
        });
      });
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/add-project-group') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      await updateManifestFile(manifestPath, (manifest) => {
        return addGroupToProjectManifest(manifest, {
          projectId: readRequiredString(body.projectId, 'projectId'),
          groupId: readRequiredString(body.groupId, 'groupId'),
          groupLabel: readOptionalString(body.groupLabel),
          layout: readLayoutBody(body.layout)
        });
      });
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/add-project-session') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      const session = readDeskSessionBody(body.session, { cwdRequired: false });
      const projectId = readRequiredString(body.projectId, 'projectId');
      const groupId = readRequiredString(body.groupId, 'groupId');
      let nextSession: SessionSpec | undefined;
      let addError: string | undefined;
      const updated = await updateManifestFile(manifestPath, async (manifest) => {
        const next = addSessionToProjectManifest(manifest, { projectId, groupId, session });
        nextSession = findSessionForStart(next, { groupId, sessionName: session.name, projectId });
        const cwdValidation = validateSessionCwd(nextSession);
        if (!cwdValidation.ok) {
          addError = cwdValidation.error;
          return null;
        }
        const launch = managedAgentLsp.prepare(nextSession, next.settings);
        const started = await startSessionNativeAware(nativeAgentLaunch(launch?.session ?? nextSession, launch?.envFilePath));
        if (!started.ok) {
          launch?.cleanup();
          addError = started.error;
          return null;
        }
        return next;
      });
      if (!updated || !nextSession) {
        sendJson(res, 500, { error: addError ?? 'project session add failed' });
        return true;
      }
      scheduleAgentResumeCapture(nextSession);
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/edit-project') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      await updateManifestFile(manifestPath, (manifest) => {
        return editProjectInManifest(manifest, {
          projectId: readRequiredString(body.projectId, 'projectId'),
          projectLabel: readOptionalString(body.projectLabel),
          cwd: readRequiredString(body.cwd, 'cwd'),
          currentCwd: readOptionalString(body.currentCwd)
        });
      });
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/delete-project') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      const projectId = readRequiredString(body.projectId, 'projectId');
      const cwd = readOptionalString(body.cwd);
      let deleteError: string | undefined;
      const updated = await updateManifestFile(manifestPath, async (manifest) => {
        const targets = collectProjectDeleteSessions(manifest, { projectId, cwd });
        const killed = await killSessionTargets(targets);
        if (!killed.ok) {
          deleteError = killed.error;
          return null;
        }
        for (const target of targets) {
          managedAgentLsp.cleanup(target.sessionId);
        }
        return deleteProjectFromManifest(manifest, { projectId, cwd });
      });
      if (!updated) {
        sendJson(res, 500, { error: deleteError ?? 'project deletion failed' });
        return true;
      }
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/edit-project-group') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      await updateManifestFile(manifestPath, (manifest) => {
        return editGroupInManifest(manifest, {
          projectId: readRequiredString(body.projectId, 'projectId'),
          currentGroupId: readOptionalString(body.currentGroupId),
          groupId: readRequiredString(body.groupId, 'groupId'),
          groupLabel: readOptionalString(body.groupLabel),
          layout: readLayoutBody(body.layout),
          projectCwd: readOptionalString(body.projectCwd)
        });
      });
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/delete-project-group') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      const projectId = readRequiredString(body.projectId, 'projectId');
      const groupId = readRequiredString(body.groupId, 'groupId');
      const projectCwd = readOptionalString(body.projectCwd);
      let deleteError: string | undefined;
      const updated = await updateManifestFile(manifestPath, async (manifest) => {
        const targets = collectGroupDeleteSessions(manifest, { projectId, groupId, projectCwd });
        const killed = await killSessionTargets(targets);
        if (!killed.ok) {
          deleteError = killed.error;
          return null;
        }
        for (const target of targets) {
          managedAgentLsp.cleanup(target.sessionId);
        }
        return deleteGroupFromManifest(manifest, { projectId, groupId, projectCwd });
      });
      if (!updated) {
        sendJson(res, 500, { error: deleteError ?? 'group deletion failed' });
        return true;
      }
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/edit-project-session') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      const session = readDeskSessionBody(body.session, { cwdRequired: false });
      const sessionBody = body.session as Record<string, unknown> | undefined;
      const projectId = readRequiredString(body.projectId, 'projectId');
      const groupId = readRequiredString(body.groupId, 'groupId');
      const currentName = readRequiredString(body.currentName, 'currentName');
      const findSpec = (specs: SessionSpec[], name: string): SessionSpec | undefined =>
        specs.find((candidate) => candidate.projectId === projectId && candidate.groupId === groupId && candidate.name === name);
      const result = await withManifestFileLock(manifestPath, async () => {
        const manifest = readManifestFile(manifestPath);
        const oldSpec = findSpec(buildSessionSpecs(manifest, { homeDir: homedir() }), currentName);
        const next = editSessionInManifest(manifest, {
          projectId,
          groupId,
          currentName,
          projectCwd: readOptionalString(body.projectCwd),
          clearResume: sessionBody?.clearResume === true,
          session
        });
        const newSpec = findSpec(buildSessionSpecs(next, { homeDir: homedir() }), session.name);
        // Fail closed (R2.1): a native edit that changes the session's identity
        // (possible for a legacy entry without a persisted sessionId) must retire
        // the master under its OLD identity, BEFORE the manifest edit commits. If
        // it can't be retired (e.g. daemon down), abort — neither orphan the old
        // atch master nor desync the manifest against a still-running master. The
        // user retries once the daemon is reachable.
        const staleGuard = await retireStaleIdentityForEdit(oldSpec, newSpec);
        if (!staleGuard.ok) {
          return { updated: null, respawnError: `session edit aborted: ${staleGuard.error}` };
        }
        writeManifestFile(manifestPath, next);
        if (
          shouldRespawnAfterEdit(oldSpec, newSpec, (target) =>
            runningSessionSet().has(target)
          ) &&
          newSpec
        ) {
          managedAgentLsp.cleanup(newSpec.sessionId);
          const launch = managedAgentLsp.prepare(newSpec, next.settings);
          const restarted = await restartSessionNativeAware(nativeAgentLaunch(launch?.session ?? newSpec, launch?.envFilePath));
          if (!restarted.ok) {
            launch?.cleanup();
            return { updated: next, respawnError: `session edit saved but respawn failed: ${restarted.error}` };
          }
          scheduleAgentResumeCapture(newSpec);
        }
        return { updated: next, respawnError: undefined };
      });
      if (result.respawnError) {
        sendJson(res, 500, { error: result.respawnError });
        return true;
      }
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/delete-project-session') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      const projectId = readRequiredString(body.projectId, 'projectId');
      const groupId = readRequiredString(body.groupId, 'groupId');
      const sessionName = readRequiredString(body.sessionName, 'sessionName');
      const projectCwd = readOptionalString(body.projectCwd);
      const extraTarget = readOptionalString(body.sessionId);
      let deleteError: string | undefined;
      const updated = await updateManifestFile(manifestPath, async (manifest) => {
        const specTargets = collectSessionDeleteTargets(manifest, {
          projectId,
          groupId,
          sessionName,
          projectCwd
        });
        const targets = specTargets.map((candidate) => candidate.sessionId);
        // Retire by SessionSpec; a caller-supplied extra id not among the
        // specs is retired best-effort.
        const killTargets: Array<SessionSpec | string> = [...specTargets];
        if (extraTarget && !targets.includes(extraTarget)) {
          targets.push(extraTarget);
          killTargets.push(extraTarget);
        }
        const killed = await killSessionTargets(killTargets);
        if (!killed.ok) {
          deleteError = killed.error;
          return null;
        }
        for (const target of targets) {
          // targets are raw session keys. LSP wiring keys sessionId; broker
          // rings and tool journals
          // key by the host's env identity, which is the sessionId for hosts
          // launched after the DESK_SESSION_ID rename and the legacy name for
          // ones still running from before it — dispose both (idempotent
          // no-op for whichever does not exist).
          const targetId = target;
          managedAgentLsp.cleanup(targetId);
          agentSurfaceBroker.disposeSession(target);
          deleteToolJournal(target);
          if (targetId !== target) {
            agentSurfaceBroker.disposeSession(targetId);
            deleteToolJournal(targetId);
          }
        }
        return deleteSessionFromManifest(manifest, { projectId, groupId, sessionName, projectCwd });
      });
      if (!updated) {
        sendJson(res, 500, { error: deleteError ?? 'session deletion failed' });
        return true;
      }
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/restart-project-session') {
      const body = await readJsonBody(req);
      const sessionId = readRequiredString(body.sessionId, 'sessionId');
      const session = loadDesk({}).sessions.find((candidate) => candidate.sessionId === sessionId);
      if (!session) {
        sendJson(res, 404, { error: `session ${sessionId} does not exist in config` });
        return true;
      }
      managedAgentLsp.cleanup(session.sessionId);
      const launch = managedAgentLsp.prepare(session, readManifestFile(resolveManifestPath()).settings);
      const restarted = await restartSessionNativeAware(nativeAgentLaunch(launch?.session ?? session, launch?.envFilePath));
      if (!restarted.ok) {
        launch?.cleanup();
        sendJson(res, 500, { error: restarted.error });
        return true;
      }
      scheduleAgentResumeCapture(session);
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/set-session-ui-mode') {
      const body = await readJsonBody(req);
      const sessionId = readRequiredString(body.sessionId, 'sessionId');
      const uiMode = readRequiredString(body.uiMode, 'uiMode');
      if (uiMode !== 'terminal' && uiMode !== 'native') {
        sendJson(res, 400, { error: 'uiMode must be terminal or native', code: 'ui-mode-invalid' });
        return true;
      }
      const manifestPath = resolveManifestPath();
      await withManifestFileLock(manifestPath, async () => {
        const manifest = readManifestFile(manifestPath);
        const validated = validateUiModeSwitch(manifest, {
          sessionId,
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
        if (!uiModeSwitchGuard.begin(sessionId)) {
          sendJson(res, 409, { error: `ui-mode switch already in progress for ${sessionId}`, code: 'switch-in-progress' });
          return;
        }
        try {
          let launch: ReturnType<typeof managedAgentLsp.prepare> | undefined;
          const result = await performUiModeSwitch(
            { manifest, validated, homeDir: homedir() },
            {
              write: (next) => writeManifestFile(manifestPath, next),
              prepare: (spec) => {
                managedAgentLsp.cleanup(spec.sessionId);
                launch = managedAgentLsp.prepare(spec, readManifestFile(manifestPath).settings);
                return nativeAgentLaunch(launch?.session ?? spec, launch?.envFilePath);
              },
              restart: (spec) => restartSessionNativeAware(spec),
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
          uiModeSwitchGuard.end(sessionId);
        }
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/move-project-session') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      await updateManifestFile(manifestPath, (manifest) => {
        return moveSessionInManifest(manifest, {
          sourceProjectId: readRequiredString(body.sourceProjectId, 'sourceProjectId'),
          sourceGroupId: readRequiredString(body.sourceGroupId, 'sourceGroupId'),
          sourceSessionName: readRequiredString(body.sourceSessionName, 'sourceSessionName'),
          sourceProjectCwd: readOptionalString(body.sourceProjectCwd),
          targetProjectId: readRequiredString(body.targetProjectId, 'targetProjectId'),
          targetGroupId: readRequiredString(body.targetGroupId, 'targetGroupId'),
          targetProjectCwd: readOptionalString(body.targetProjectCwd)
        });
      });
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/group-layout-sizes') {
      const body = await readJsonBody(req);
      const sizes = readLayoutSizesBody(body.sizes);
      if (!sizes) {
        sendJson(res, 400, { error: 'sizes must contain rows[] and/or cols[][] of percentages' });
        return true;
      }
      const manifestPath = resolveManifestPath();
      await updateManifestFile(manifestPath, (manifest) => {
        return setGroupLayoutSizesInManifest(manifest, {
          projectId: readRequiredString(body.projectId, 'projectId'),
          groupId: readRequiredString(body.groupId, 'groupId'),
          projectCwd: readOptionalString(body.projectCwd),
          sizes
        });
      });
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/reorder-projects') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      await updateManifestFile(manifestPath, (manifest) => {
        return reorderProjectsInManifest(manifest, readStringArray(body.orderedProjectIds, 'orderedProjectIds'));
      });
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/reorder-groups') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      await updateManifestFile(manifestPath, (manifest) => {
        return reorderGroupsInManifest(manifest, {
          projectId: readRequiredString(body.projectId, 'projectId'),
          orderedGroupIds: readStringArray(body.orderedGroupIds, 'orderedGroupIds')
        });
      });
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/reorder-sessions') {
      const body = await readJsonBody(req);
      const manifestPath = resolveManifestPath();
      await updateManifestFile(manifestPath, (manifest) => {
        return reorderSessionsInManifest(manifest, {
          projectId: readRequiredString(body.projectId, 'projectId'),
          groupId: readRequiredString(body.groupId, 'groupId'),
          projectCwd: readOptionalString(body.projectCwd),
          orderedSessionNames: readStringArray(body.orderedSessionNames, 'orderedSessionNames')
        });
      });
      sendJson(res, 200, buildDeskSnapshot());
      return true;
    }

    return false;
  };
}
