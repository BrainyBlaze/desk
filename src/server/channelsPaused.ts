import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PreCutoverStoreError } from '../shared/supportFloor.js';
import { writeFileAtomic } from './fsOps.js';

/**
 * Channels operator-pause store. Engine-internal (NOT user-workspace):
 * lives at `<home>/_engine/paused.json` next to the server ownership lease and
 * queue dir. Mirrors the channelsFeatured pattern (versioned JSON, atomic
 * writes, server-only writer).
 *
 * Each entry records a manual operator pause on a session. The engine
 * reads this on restore (alongside restoreQueues) and applies
 * `runtime.pausedByOperator` per session; the drain gate (engine lane) checks
 * the flag — manual hold never masquerades as busy/stuck, and the drain holds
 * without counting hold cycles.
 *
 * Persistence ensures a manual pause survives `desk serve` restart (HMR or
 * operator bounce); otherwise the operator's intent is silently lost and the
 * paused agent auto-resumes mid-sensitive-work.
 *
 * CONCURRENCY INVARIANT: the read-modify-write path (readStore → mutate →
 * writeStore) is FULLY SYNCHRONOUS — no `await` between read and write, and
 * writeFileAtomic uses writeFileSync + renameSync. JavaScript's single event
 * loop serializes sync blocks, so two pauseSession/resumeSession calls CANNOT
 * interleave — the second waits at the event-loop level until the first
 * returns. Combined with the server-only-writer constraint (no CLI/external
 * caller touches this store), the classic lost-update RMW race is
 * architecturally precluded. Do NOT add a home-level lock — it adds complexity
 * for a scenario that cannot occur here. If you ever introduce an `await`
 * inside the RMW path, the invariant breaks → add a lock THEN.
 */

const PAUSED_FILE = 'paused.json';
const PAUSED_VERSION = 2;
/** The store version Desk v0.3.1 wrote: items keyed by the retired per-session identity, not by sessionId. */
const PRE_CUTOVER_PAUSED_VERSION = 1;
const SESSION_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface PausedSession {
  sessionId: string;
  pausedAt: string;
  reason?: string;
}

interface PausedStore {
  version: number;
  items: PausedSession[];
}

function pausedDir(home: string): string {
  return join(home, '_engine');
}

function pausedPath(home: string): string {
  return join(pausedDir(home), PAUSED_FILE);
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStore(raw: string, path: string): PausedStore {
  const parsed: unknown = JSON.parse(raw);
  // Version 1 is not corruption: it is the store an older Desk wrote, whose
  // entries this version cannot attribute (they name sessions by the retired
  // identity). The migration that rewrote it is gone; say what remains.
  if (isRecord(parsed) && parsed.version === PRE_CUTOVER_PAUSED_VERSION) {
    throw new PreCutoverStoreError(
      `Channels paused store at ${path} is version ${PRE_CUTOVER_PAUSED_VERSION}, written by Desk v0.3.1 or older`
    );
  }
  if (!isRecord(parsed) || parsed.version !== PAUSED_VERSION || !Array.isArray(parsed.items)) {
    throw new Error(`expected version ${PAUSED_VERSION} with an items array`);
  }
  const seen = new Set<string>();
  const items = parsed.items.map((item, index): PausedSession => {
    if (
      !isRecord(item) ||
      typeof item.sessionId !== 'string' ||
      !SESSION_KEY.test(item.sessionId) ||
      typeof item.pausedAt !== 'string' ||
      !Number.isFinite(Date.parse(item.pausedAt)) ||
      (item.reason !== undefined && typeof item.reason !== 'string')
    ) {
      throw new Error(`invalid paused record at items[${index}]`);
    }
    if (seen.has(item.sessionId)) {
      throw new Error(`duplicate paused session ${item.sessionId}`);
    }
    seen.add(item.sessionId);
    return {
      sessionId: item.sessionId,
      pausedAt: item.pausedAt,
      reason: normalizeOptional(item.reason)
    };
  });
  return { version: PAUSED_VERSION, items };
}

function readStore(home: string): PausedStore {
  const path = pausedPath(home);
  if (!existsSync(path)) {
    return { version: PAUSED_VERSION, items: [] };
  }
  try {
    return parseStore(readFileSync(path, 'utf8'), path);
  } catch (error) {
    if (error instanceof PreCutoverStoreError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid Channels paused store at ${path}: ${detail}`);
  }
}

function writeStore(home: string, store: PausedStore): void {
  mkdirSync(pausedDir(home), { recursive: true });
  writeFileAtomic(pausedPath(home), `${JSON.stringify({ version: PAUSED_VERSION, items: store.items }, null, 2)}\n`);
}

/** Lists every currently-paused session (engine consumes on restore + on demand). */
export function listPausedSessions(home: string): PausedSession[] {
  return readStore(home).items;
}

/** True if the session is currently paused (engine drain gate consumer). */
export function isSessionPaused(home: string, sessionId: string): boolean {
  return readStore(home).items.some((item) => item.sessionId === sessionId);
}

/** Looks up the paused-session record (for reason + pausedAt surface). */
export function getPausedSession(home: string, sessionId: string): PausedSession | undefined {
  return readStore(home).items.find((item) => item.sessionId === sessionId);
}

/** Pauses a session (idempotent — re-pausing updates reason + pausedAt). */
export function pauseSession(home: string, sessionId: string, reason?: string, now = new Date()): PausedSession {
  if (!SESSION_KEY.test(sessionId)) {
    throw new Error(`invalid session id: ${sessionId}`);
  }
  const next: PausedSession = {
    sessionId,
    pausedAt: now.toISOString(),
    reason: normalizeOptional(reason)
  };
  const store = readStore(home);
  const existing = store.items.findIndex((item) => item.sessionId === sessionId);
  if (existing === -1) {
    store.items.push(next);
  } else {
    store.items[existing] = next;
  }
  writeStore(home, store);
  return next;
}

/** Resumes a session (idempotent — resuming a non-paused session is a no-op). */
export function resumeSession(home: string, sessionId: string): boolean {
  if (!SESSION_KEY.test(sessionId)) {
    throw new Error(`invalid session id: ${sessionId}`);
  }
  const store = readStore(home);
  const before = store.items.length;
  store.items = store.items.filter((item) => item.sessionId !== sessionId);
  if (store.items.length === before) {
    return false;
  }
  writeStore(home, store);
  return true;
}
