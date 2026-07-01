import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsOps.js';

/**
 * Channels operator-pause store. Engine-internal (NOT user-workspace):
 * lives at `<home>/_engine/paused.json` next to the engine.pid lock + queue
 * dir. Mirrors the channelsFeatured pattern (versioned JSON, atomic writes,
 * server-only writer).
 *
 * Each entry records a manual operator pause on a tmux session. The engine
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
const PAUSED_VERSION = 1;
const TMUX_SESSION = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface PausedSession {
  tmuxSession: string;
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

function parseStore(raw: string): PausedStore {
  const parsed = JSON.parse(raw) as Partial<PausedStore>;
  const items = Array.isArray(parsed.items)
    ? parsed.items.flatMap((item) => {
        if (
          item &&
          typeof item.tmuxSession === 'string' &&
          typeof item.pausedAt === 'string' &&
          TMUX_SESSION.test(item.tmuxSession)
        ) {
          return [{
            tmuxSession: item.tmuxSession,
            pausedAt: item.pausedAt,
            reason: normalizeOptional(item.reason)
          }];
        }
        return [];
      })
    : [];
  return { version: PAUSED_VERSION, items };
}

function readStore(home: string): PausedStore {
  const path = pausedPath(home);
  if (!existsSync(path)) {
    return { version: PAUSED_VERSION, items: [] };
  }
  try {
    return parseStore(readFileSync(path, 'utf8'));
  } catch {
    return { version: PAUSED_VERSION, items: [] };
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
export function isSessionPaused(home: string, tmuxSession: string): boolean {
  return readStore(home).items.some((item) => item.tmuxSession === tmuxSession);
}

/** Looks up the paused-session record (for reason + pausedAt surface). */
export function getPausedSession(home: string, tmuxSession: string): PausedSession | undefined {
  return readStore(home).items.find((item) => item.tmuxSession === tmuxSession);
}

/** Pauses a session (idempotent — re-pausing updates reason + pausedAt). */
export function pauseSession(home: string, tmuxSession: string, reason?: string, now = new Date()): PausedSession {
  if (!TMUX_SESSION.test(tmuxSession)) {
    throw new Error(`invalid tmux session name: ${tmuxSession}`);
  }
  const next: PausedSession = {
    tmuxSession,
    pausedAt: now.toISOString(),
    reason: normalizeOptional(reason)
  };
  const store = readStore(home);
  const existing = store.items.findIndex((item) => item.tmuxSession === tmuxSession);
  if (existing === -1) {
    store.items.push(next);
  } else {
    store.items[existing] = next;
  }
  writeStore(home, store);
  return next;
}

/** Resumes a session (idempotent — resuming a non-paused session is a no-op). */
export function resumeSession(home: string, tmuxSession: string): boolean {
  if (!TMUX_SESSION.test(tmuxSession)) {
    throw new Error(`invalid tmux session name: ${tmuxSession}`);
  }
  const store = readStore(home);
  const before = store.items.length;
  store.items = store.items.filter((item) => item.tmuxSession !== tmuxSession);
  if (store.items.length === before) {
    return false;
  }
  writeStore(home, store);
  return true;
}
