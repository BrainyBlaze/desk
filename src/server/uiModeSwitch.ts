import { buildSessionSpecs, sessionSupportsNativeUiMode } from '../core/manifest.js';
import { editSessionInManifest } from '../core/config.js';
import type { DeskManifest, DeskSession, DeskSessionUiMode, SessionSpec } from '../core/types.js';

/**
 * Atomic UI-mode switch (spec: docs/native-ui-mode-spec.md §7).
 *
 * validateUiModeSwitch answers every reject with a typed code BEFORE any
 * mutation; performUiModeSwitch runs manifest-write-then-respawn through
 * injected dependencies so the sequencing is unit-testable without a live transport.
 */

export type UiModeSwitchErrorCode = 'unknown-session' | 'ui-mode-unsupported' | 'resume-not-captured';

export interface UiModeSwitchEdit {
  projectId?: string;
  groupId: string;
  currentName: string;
  projectCwd?: string;
  session: DeskSession;
}

export type UiModeSwitchValidation =
  | { ok: true; noop: boolean; spec: SessionSpec; edit: UiModeSwitchEdit }
  | { ok: false; status: 400 | 404 | 409; code: UiModeSwitchErrorCode; error: string };

export interface ValidateUiModeSwitchOptions {
  sessionId: string;
  uiMode: DeskSessionUiMode;
  confirmDiscard?: boolean;
  homeDir: string;
}

export function validateUiModeSwitch(manifest: DeskManifest, options: ValidateUiModeSwitchOptions): UiModeSwitchValidation {
  const specs = buildSessionSpecs(manifest, { homeDir: options.homeDir });
  const spec = specs.find((candidate) => candidate.sessionId === options.sessionId);
  if (!spec) {
    return {
      ok: false,
      status: 404,
      code: 'unknown-session',
      error: `session ${options.sessionId} does not exist in config`
    };
  }
  const record = findSessionRecord(manifest, spec);
  if (!record) {
    return {
      ok: false,
      status: 404,
      code: 'unknown-session',
      error: `session ${options.sessionId} has no manifest record`
    };
  }
  if (options.uiMode === 'native' && !sessionSupportsNativeUiMode(record)) {
    return {
      ok: false,
      status: 400,
      code: 'ui-mode-unsupported',
      error: `session ${spec.name} cannot use native uiMode; only codex/claude/opencode agent sessions support it`
    };
  }
  if (spec.uiMode === options.uiMode) {
    return { ok: true, noop: true, spec, edit: buildEdit(spec, record, options.uiMode) };
  }
  // Without a captured resume id the respawned process cannot rejoin the
  // conversation, so the switch would silently discard it in either direction.
  if (!record.resume && options.confirmDiscard !== true) {
    return {
      ok: false,
      status: 409,
      code: 'resume-not-captured',
      error: `session ${spec.name} has no captured resume id yet; switching now starts a fresh conversation (retry with confirmDiscard to proceed)`
    };
  }
  return { ok: true, noop: false, spec, edit: buildEdit(spec, record, options.uiMode) };
}

export interface PerformUiModeSwitchInput {
  manifest: DeskManifest;
  validated: Extract<UiModeSwitchValidation, { ok: true }>;
  homeDir: string;
}

export interface PerformUiModeSwitchDeps {
  write: (next: DeskManifest) => void;
  restart: (spec: SessionSpec) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  /** Optional launch rewrite hook (LSP/MCP wiring); receives the post-edit spec. */
  prepare?: (spec: SessionSpec) => SessionSpec;
  scheduleCapture?: (spec: SessionSpec) => void;
}

export type PerformUiModeSwitchResult =
  | { ok: true; spec: SessionSpec }
  | { ok: false; status: 500; error: string };

export async function performUiModeSwitch(
  input: PerformUiModeSwitchInput,
  deps: PerformUiModeSwitchDeps
): Promise<PerformUiModeSwitchResult> {
  const { validated } = input;
  const updated = editSessionInManifest(input.manifest, {
    projectId: validated.edit.projectId ?? '',
    groupId: validated.edit.groupId,
    currentName: validated.edit.currentName,
    projectCwd: validated.edit.projectCwd,
    session: validated.edit.session
  });
  deps.write(updated);

  const nextSpec = buildSessionSpecs(updated, { homeDir: input.homeDir }).find(
    (candidate) => candidate.sessionId === validated.spec.sessionId
  );
  if (!nextSpec) {
    return { ok: false, status: 500, error: `session ${validated.spec.sessionId} disappeared during ui-mode switch` };
  }
  const launchSpec = deps.prepare ? deps.prepare(nextSpec) : nextSpec;
  const restarted = await deps.restart(launchSpec);
  if (!restarted.ok) {
    return { ok: false, status: 500, error: restarted.error ?? 'session restart failed' };
  }
  deps.scheduleCapture?.(nextSpec);
  return { ok: true, spec: nextSpec };
}

export function createInFlightGuard(): { begin: (key: string) => boolean; end: (key: string) => void } {
  const inflight = new Set<string>();
  return {
    begin: (key) => {
      if (inflight.has(key)) {
        return false;
      }
      inflight.add(key);
      return true;
    },
    end: (key) => {
      inflight.delete(key);
    }
  };
}

function buildEdit(spec: SessionSpec, record: DeskSession, uiMode: DeskSessionUiMode): UiModeSwitchEdit {
  // Durable sessionId already pins identity across the switch — no name pin.
  const session: DeskSession = { ...record };
  // Always pin the mode explicitly: an absent field resolves to native for
  // SDK-backed agents, so deleting it would silently undo a terminal switch.
  session.uiMode = uiMode;
  return {
    projectId: spec.projectId,
    groupId: spec.groupId,
    currentName: spec.name,
    projectCwd: spec.projectCwd,
    session
  };
}

function findSessionRecord(manifest: DeskManifest, spec: SessionSpec): DeskSession | undefined {
  if (spec.projectId) {
    const project = (manifest.projects ?? []).find((candidate) => candidate.id === spec.projectId);
    const group = project?.groups.find((candidate) => candidate.id === spec.groupId);
    return group?.sessions.find((session) => session.name === spec.name);
  }
  const group = manifest.groups.find((candidate) => candidate.id === spec.groupId);
  return group?.sessions.find((session) => session.name === spec.name);
}
