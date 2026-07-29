import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../server/fsOps.js';
import { withFileLockSync } from '../shared/fileLock.js';

export interface PendingResumeCapture {
  sessionId: string;
  agent: 'codex' | 'opencode';
  cwd: string;
  sinceMs: number;
  deadlineMs: number;
  launchResumeId?: string;
}

/** The pre-migration store shape (tmuxSession-keyed) — the transform's input. */
export interface LegacyPendingResumeCapture {
  tmuxSession: string;
  agent: 'codex' | 'opencode';
  cwd: string;
  sinceMs: number;
  deadlineMs: number;
  launchResumeId?: string;
}

export interface ResumeCaptureStateOptions {
  path?: string;
  homeDir?: string;
}

export function resolveResumeCaptureStatePath(options: ResumeCaptureStateOptions = {}): string {
  if (options.path) {
    return options.path;
  }
  if (process.env.DESK_RESUME_CAPTURE_STATE_PATH) {
    return process.env.DESK_RESUME_CAPTURE_STATE_PATH;
  }
  return join(options.homeDir ?? homedir(), '.config', 'desk', 'resume-captures.json');
}

export function readPendingResumeCaptures(options: ResumeCaptureStateOptions = {}): PendingResumeCapture[] {
  const path = resolveResumeCaptureStatePath(options);
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const captures = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { captures?: unknown }).captures)
        ? (parsed as { captures: unknown[] }).captures
        : [];
    return captures.filter(isPendingResumeCapture);
  } catch {
    return [];
  }
}

export function upsertPendingResumeCapture(
  capture: PendingResumeCapture,
  options: ResumeCaptureStateOptions = {}
): void {
  updatePendingResumeCaptures((captures) => {
    const updated = captures.filter((entry) => entry.sessionId !== capture.sessionId);
    updated.push(capture);
    return updated;
  }, options);
}

export function removePendingResumeCapture(sessionId: string, options: ResumeCaptureStateOptions = {}): void {
  updatePendingResumeCaptures(
    (captures) => captures.filter((entry) => entry.sessionId !== sessionId),
    options
  );
}

/**
 * Serialize a read-modify-write on the resume-capture file across processes.
 * The CLI (`desk up`) and server startup both mutate this state, so an atomic
 * write alone cannot prevent one process from overwriting another's update.
 */
export function updatePendingResumeCaptures(
  update: (captures: PendingResumeCapture[]) => PendingResumeCapture[],
  options: ResumeCaptureStateOptions = {}
): PendingResumeCapture[] {
  return withFileLockWithParent(options, () => {
    const captures = update(readPendingResumeCaptures(options));
    writePendingResumeCaptures(captures, options);
    return captures;
  });
}

/** Serialize a read-modify-write on the resume-capture file across processes.
 *  Ensures the parent dir exists first so the lock can be acquired on first use. */
function withFileLockWithParent<T>(options: ResumeCaptureStateOptions, action: () => T): T {
  const path = resolveResumeCaptureStatePath(options);
  mkdirSync(dirname(path), { recursive: true });
  // Lock a SEPARATE `.lock` path (proper-lockfile materializes the lock as a
  // directory at lockfilePath) — locking the data file itself would turn it into
  // a directory. Mirrors withManifestFileLockSync.
  return withFileLockSync(`${path}.lock`, action);
}

export function findPendingResumeCapture(
  sessionId: string,
  options: ResumeCaptureStateOptions = {}
): PendingResumeCapture | undefined {
  return readPendingResumeCaptures(options).find((entry) => entry.sessionId === sessionId);
}

export function writePendingResumeCaptures(
  captures: PendingResumeCapture[],
  options: ResumeCaptureStateOptions = {}
): void {
  const path = resolveResumeCaptureStatePath(options);
  writeFileAtomic(path, `${JSON.stringify({ captures }, null, 2)}\n`);
}

export function clearPendingResumeCaptures(options: ResumeCaptureStateOptions = {}): void {
  try {
    unlinkSync(resolveResumeCaptureStatePath(options));
  } catch {
    // missing or raced delete: already clear
  }
}

/**
 * §10 store transform (cutover 3a): the post-cutover pending-capture record,
 * keyed by the durable sessionId. ADDITIVE — the runtime keeps reading the
 * legacy shape until the migration gate has committed (3b flips the readers).
 */
/** @deprecated the migrated shape IS the canonical PendingResumeCapture. */
export type MigratedPendingResumeCapture = PendingResumeCapture;

export interface ResumeCaptureStoreMigration {
  items: PendingResumeCapture[];
  /** Entries whose tmuxSession has no sessionId (session gone from the manifest) — reported, never silently lost. */
  dropped: LegacyPendingResumeCapture[];
}

/** Re-key the pending-capture store via the canonical tmuxSession→sessionId map. Pure. */
export function migrateResumeCaptureStore(
  items: readonly LegacyPendingResumeCapture[],
  tmuxToSessionId: ReadonlyMap<string, string>
): ResumeCaptureStoreMigration {
  const migrated: PendingResumeCapture[] = [];
  const dropped: LegacyPendingResumeCapture[] = [];
  for (const item of items) {
    const sessionId = tmuxToSessionId.get(item.tmuxSession);
    if (sessionId === undefined) {
      dropped.push(item);
      continue;
    }
    const out: PendingResumeCapture = {
      sessionId,
      agent: item.agent,
      cwd: item.cwd,
      sinceMs: item.sinceMs,
      deadlineMs: item.deadlineMs
    };
    if (item.launchResumeId !== undefined) {
      out.launchResumeId = item.launchResumeId;
    }
    migrated.push(out);
  }
  return { items: migrated, dropped };
}

function isPendingResumeCapture(value: unknown): value is PendingResumeCapture {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === 'string' &&
    (record.agent === 'codex' || record.agent === 'opencode') &&
    typeof record.cwd === 'string' &&
    typeof record.sinceMs === 'number' &&
    Number.isFinite(record.sinceMs) &&
    typeof record.deadlineMs === 'number' &&
    Number.isFinite(record.deadlineMs) &&
    (record.launchResumeId === undefined || typeof record.launchResumeId === 'string')
  );
}
