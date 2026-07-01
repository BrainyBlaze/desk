import { constants, readdirSync, openSync, readSync, closeSync, statSync, accessSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readManifestFile, resolveManifestPath, writeManifestFile } from '../core/config.js';
import { buildSessionSpecs } from '../core/manifest.js';
import {
  findPendingResumeCapture,
  readPendingResumeCaptures,
  removePendingResumeCapture,
  type PendingResumeCapture,
  type ResumeCaptureStateOptions,
  upsertPendingResumeCapture,
  writePendingResumeCaptures
} from '../core/resumeCaptureState.js';
import type { DeskAgent, DeskManifest, SessionSpec } from '../core/types.js';
import { listOpencodeSessions, pickOpencodeCaptureResumeSession } from './opencodeSession.js';

/**
 * Resume-id capture.
 *
 * A session created WITHOUT a resume id starts a fresh agent conversation; the
 * CLI mints its own id which Desk must harvest into the manifest, otherwise a
 * restart spawns yet another fresh conversation.
 *
 *  - codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` at
 *    TUI startup; line 1 is `{"type":"session_meta","payload":{"id","cwd",..}}`.
 *  - claude reports `session_id` on hook stdin; the injected Stop hook forwards
 *    it to /api/agent-event as `sessionId`.
 *  - opencode records sessions in its SQLite store after the first user message;
 *    Desk queries `opencode session list --format json` from the session cwd.
 *
 * Persisting MUST also pin the current tmux session name: the derived name
 * depends on the resume id, so adding one later would otherwise re-derive a
 * different name and orphan the running session.
 */

export function parseRolloutMeta(firstLine: string): { id: string; cwd: string } | null {
  try {
    const parsed = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; cwd?: string } };
    if (parsed.type === 'session_meta' && typeof parsed.payload?.id === 'string' && typeof parsed.payload?.cwd === 'string') {
      return { id: parsed.payload.id, cwd: parsed.payload.cwd };
    }
  } catch {
    // not JSON — ignore
  }
  return null;
}

/** claude session ids and codex thread ids are both UUIDs. */
const UUID_RESUME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** OpenCode session ids are CLI-safe ses_ identifiers, not UUIDs. */
const OPENCODE_RESUME_ID_PATTERN = /^ses_[A-Za-z0-9]{20,80}$/;

export function isValidResumeId(value: string): boolean {
  return UUID_RESUME_ID_PATTERN.test(value);
}

export function isValidResumeIdForAgent(agent: DeskAgent | undefined, value: string): boolean {
  if (agent === 'opencode') {
    return OPENCODE_RESUME_ID_PATTERN.test(value);
  }
  return isValidResumeId(value);
}

/**
 * Applies a captured resume id to the manifest entry whose derived spec matches
 * the tmux session name. Pure: returns the updated manifest (or null when no
 * matching, resume-less session exists).
 */
export function applyResumeToManifest(
  manifest: DeskManifest,
  tmuxSession: string,
  resume: string,
  homeDir: string
): DeskManifest | null {
  const specs = buildSessionSpecs(manifest, { homeDir });
  const spec = specs.find((candidate) => candidate.tmuxSession === tmuxSession);
  if (!spec || spec.resume) {
    return null;
  }
  // Single chokepoint for every capture path: reject anything not matching the
  // target agent's safe resume-id grammar before it can reach a shell command.
  if (!isValidResumeIdForAgent(spec.agent, resume)) {
    return null;
  }
  // Refuse ids already claimed by another session.
  if (specs.some((candidate) => candidate.resume === resume)) {
    return null;
  }

  const updateSessions = (sessions: DeskManifest['groups'][number]['sessions']): boolean => {
    for (const session of sessions) {
      if (session.name === spec.name && !session.resume) {
        session.resume = resume;
        session.tmuxSession = tmuxSession; // pin: keep the running session linked
        return true;
      }
    }
    return false;
  };

  const next = structuredClone(manifest);
  for (const project of next.projects ?? []) {
    if (project.id !== spec.projectId) {
      continue;
    }
    for (const group of project.groups) {
      if (group.id === spec.groupId && updateSessions(group.sessions)) {
        return next;
      }
    }
  }
  for (const group of next.groups) {
    if (group.id === spec.groupId && updateSessions(group.sessions)) {
      return next;
    }
  }
  return null;
}

function codexHome(): string {
  return process.env.DESK_CODEX_HOME ?? join(homedir(), '.codex');
}

function codexSessionsDir(): string {
  return join(codexHome(), 'sessions');
}

/** Pure: a single distinct uuid among fresh snapshot filenames identifies the new session. */
export function pickUniqueSnapshotUuid(entries: Array<{ name: string; mtimeMs: number }>, sinceMs: number): string | null {
  const uuids = new Set<string>();
  for (const entry of entries) {
    if (entry.mtimeMs < sinceMs) {
      continue;
    }
    const match = entry.name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./);
    if (match) {
      uuids.add(match[1]!);
    }
  }
  return uuids.size === 1 ? [...uuids][0]! : null;
}

/**
 * codex names its startup shell snapshot with the freshly minted thread id —
 * available BEFORE the first turn (the rollout only appears at first turn).
 */
export function findCodexSnapshotUuid(sinceMs: number): string | null {
  const dir = join(codexHome(), 'shell_snapshots');
  try {
    const entries = readdirSync(dir).map((name) => {
      try {
        return { name, mtimeMs: statSync(join(dir, name)).mtimeMs };
      } catch {
        return { name, mtimeMs: 0 };
      }
    });
    return pickUniqueSnapshotUuid(entries, sinceMs);
  } catch {
    return null;
  }
}

function dayDir(base: string, date: Date): string {
  const y = String(date.getUTCFullYear());
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return join(base, y, m, d);
}

function readFirstLine(path: string): string {
  // session_meta embeds the agent's full base instructions — the first line
  // can be tens of KB. Read chunks until the newline (cap 1 MiB).
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(65536);
    let text = '';
    let position = 0;
    while (position < 1_048_576) {
      const bytes = readSync(fd, chunk, 0, chunk.length, position);
      if (bytes <= 0) {
        break;
      }
      text += chunk.subarray(0, bytes).toString('utf8');
      const newline = text.indexOf('\n');
      if (newline >= 0) {
        return text.slice(0, newline);
      }
      position += bytes;
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

/** Newest codex rollout for `cwd` created after `sinceMs` (today/yesterday UTC dirs). */
export function findCodexResume(cwd: string, sinceMs: number): string | null {
  const base = codexSessionsDir();
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const offset of [0, 1]) {
    const dir = dayDir(base, new Date(Date.now() - offset * 86_400_000));
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) {
        continue;
      }
      const path = join(dir, entry);
      try {
        const stat = statSync(path);
        if (stat.mtimeMs >= sinceMs) {
          candidates.push({ path, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // raced with writer — skip
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    const meta = parseRolloutMeta(readFirstLine(candidate.path));
    if (meta && meta.cwd === cwd) {
      return meta.id;
    }
  }
  return null;
}

function findExecutableOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

function resolveOpencodeBinary(): string | null {
  const override = process.env.DESK_OPENCODE_BIN;
  if (override) {
    try {
      accessSync(override, constants.X_OK);
      return override;
    } catch {
      return null;
    }
  }
  const fromPath = findExecutableOnPath('opencode');
  if (fromPath) {
    return fromPath;
  }
  const fallback = join(homedir(), '.opencode', 'bin', 'opencode');
  try {
    accessSync(fallback, constants.X_OK);
    return fallback;
  } catch {
    return null;
  }
}

export interface FindOpencodeResumeOptions {
  sinceMs?: number;
  launchResumeId?: string;
}

export async function findOpencodeResume(
  cwd: string,
  options: number | FindOpencodeResumeOptions = {}
): Promise<string | null> {
  const captureOptions: FindOpencodeResumeOptions = typeof options === 'number' ? { sinceMs: options } : options;
  if (captureOptions.launchResumeId) {
    return isValidResumeIdForAgent('opencode', captureOptions.launchResumeId) ? captureOptions.launchResumeId : null;
  }
  if (captureOptions.sinceMs === undefined) {
    return null;
  }
  const bin = resolveOpencodeBinary();
  if (!bin) {
    return null;
  }
  const sessions = await listOpencodeSessions(cwd, bin);
  return pickOpencodeCaptureResumeSession(sessions, {
    directory: cwd,
    sinceMs: captureOptions.sinceMs
  })?.id ?? null;
}

/** Reads, applies, writes. Returns true when the manifest was updated. */
export function persistSessionResume(tmuxSession: string, resume: string): boolean {
  const manifestPath = resolveManifestPath();
  const manifest = readManifestFile(manifestPath);
  const updated = applyResumeToManifest(manifest, tmuxSession, resume, homedir());
  if (!updated) {
    return false;
  }
  writeManifestFile(manifestPath, updated);
  return true;
}

const pendingCaptures = new Map<string, PendingResumeCapture>();

function pendingStateOptions(options: { statePath?: string } = {}): ResumeCaptureStateOptions {
  return options.statePath ? { path: options.statePath } : {};
}

/**
 * Fast path for a freshly started resume-less codex session: the startup shell
 * snapshot carries the thread id within seconds — well before the first turn.
 */
export function scheduleCodexResumeCapture(
  spec: SessionSpec,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): void {
  if (spec.agent !== 'codex' || spec.resume || pendingCaptures.has(spec.tmuxSession)) {
    return;
  }
  const since = Date.now() - 3_000;
  const deadline = Date.now() + (options.timeoutMs ?? 45_000);
  pendingCaptures.set(spec.tmuxSession, {
    tmuxSession: spec.tmuxSession,
    agent: 'codex',
    cwd: spec.cwd,
    sinceMs: since,
    deadlineMs: deadline
  });
  const interval = options.intervalMs ?? 2_000;

  const tick = (): void => {
    if (!pendingCaptures.has(spec.tmuxSession)) {
      return;
    }
    try {
      const resume = findCodexSnapshotUuid(since) ?? findCodexResume(spec.cwd, since);
      if (resume && persistSessionResume(spec.tmuxSession, resume)) {
        pendingCaptures.delete(spec.tmuxSession);
        return;
      }
    } catch {
      // best-effort: try again next tick
    }
    if (Date.now() < deadline) {
      setTimeout(tick, interval).unref?.();
    }
    // past deadline the pending entry stays: the first-notification path takes over
  };
  setTimeout(tick, interval).unref?.();
}

/**
 * OpenCode creates the persistent session only after the first user message.
 * Poll briefly after launch, then keep the pending entry so the first attention
 * signal can do another cwd/time-scoped query.
 */
export function scheduleOpencodeResumeCapture(
  spec: SessionSpec,
  options: { timeoutMs?: number; intervalMs?: number; statePath?: string } = {}
): void {
  if (spec.agent !== 'opencode' || spec.resume || pendingCaptures.has(spec.tmuxSession)) {
    return;
  }
  const stored = findPendingResumeCapture(spec.tmuxSession, pendingStateOptions(options));
  const now = Date.now();
  const pending: PendingResumeCapture =
    stored && stored.agent === 'opencode' && stored.cwd === spec.cwd
      ? stored
      : {
          tmuxSession: spec.tmuxSession,
          agent: 'opencode',
          cwd: spec.cwd,
          sinceMs: now - 3_000,
          deadlineMs: now + (options.timeoutMs ?? 45_000)
        };
  pendingCaptures.set(spec.tmuxSession, pending);
  upsertPendingResumeCapture(pending, pendingStateOptions(options));
  const interval = options.intervalMs ?? 2_000;
  pollOpencodeResumeCapture(spec, pending, interval, pendingStateOptions(options));
}

function pollOpencodeResumeCapture(
  spec: SessionSpec,
  pending: PendingResumeCapture,
  interval: number,
  stateOptions: ResumeCaptureStateOptions = {}
): void {
  const tick = (): void => {
    if (!pendingCaptures.has(spec.tmuxSession)) {
      return;
    }
    void findOpencodeResume(spec.cwd, {
      sinceMs: pending.sinceMs,
      launchResumeId: pending.launchResumeId
    })
      .then((resume) => {
        if (resume && persistSessionResume(spec.tmuxSession, resume)) {
          pendingCaptures.delete(spec.tmuxSession);
          removePendingResumeCapture(spec.tmuxSession, stateOptions);
          return;
        }
        if (Date.now() < pending.deadlineMs) {
          setTimeout(tick, interval).unref?.();
        }
        // past deadline the pending entry stays: the first-notification path takes over
      })
      .catch(() => {
        if (Date.now() < pending.deadlineMs) {
          setTimeout(tick, interval).unref?.();
        }
      });
  };
  if (Date.now() < pending.deadlineMs) {
    setTimeout(tick, interval).unref?.();
  }
}

/**
 * Deadline-free path, fired on a session's first notification (a completed
 * turn guarantees the rollout exists). Also covers sessions created before a
 * server restart: any resume-less codex session gets a cwd-matched scan.
 */
export function attemptResumeCaptureForSession(tmuxSession: string, lookupSpec: () => SessionSpec | undefined): void {
  try {
    const spec = lookupSpec();
    if (!spec || spec.resume) {
      return;
    }
    const pending = pendingCaptures.get(tmuxSession) ?? findPendingResumeCapture(tmuxSession);
    if (pending) {
      pendingCaptures.set(tmuxSession, pending);
    }
    if (spec.agent === 'codex') {
      const since = pending?.sinceMs ?? 0;
      const resume = findCodexResume(spec.cwd, since) ?? (pending ? findCodexSnapshotUuid(pending.sinceMs) : null);
      if (resume && persistSessionResume(tmuxSession, resume)) {
        pendingCaptures.delete(tmuxSession);
      }
      return;
    }
    if (spec.agent === 'opencode') {
      if (!pending || pending.agent !== 'opencode' || pending.cwd !== spec.cwd) {
        return;
      }
      void findOpencodeResume(spec.cwd, {
        sinceMs: pending.sinceMs,
        launchResumeId: pending.launchResumeId
      })
        .then((resume) => {
          if (resume && persistSessionResume(tmuxSession, resume)) {
            pendingCaptures.delete(tmuxSession);
            removePendingResumeCapture(tmuxSession);
          }
        })
        .catch(() => {
          // best-effort
        });
    }
  } catch {
    // best-effort
  }
}

export function restorePendingResumeCaptures(
  sessions: SessionSpec[],
  options: { intervalMs?: number; statePath?: string } = {}
): void {
  const stateOptions = pendingStateOptions(options);
  const keep: PendingResumeCapture[] = [];
  for (const pending of readPendingResumeCaptures(stateOptions)) {
    const spec = sessions.find((candidate) => candidate.tmuxSession === pending.tmuxSession);
    if (!spec || spec.resume || spec.agent !== pending.agent || spec.cwd !== pending.cwd) {
      continue;
    }
    pendingCaptures.set(pending.tmuxSession, pending);
    keep.push(pending);
    if (pending.agent === 'opencode') {
      pollOpencodeResumeCapture(spec, pending, options.intervalMs ?? 2_000, stateOptions);
    }
  }
  writePendingResumeCaptures(keep, stateOptions);
}
