import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidChannelName, type ReactionKind } from './channelsProtocol.js';
import { writeFileAtomic } from './fsOps.js';

/**
 * Channels reactions store — operator-authored lightweight reactions / ack
 *. Mirrors the channelsFeatured pattern: single global JSON file under
 * the channels home, atomic writes via writeFileAtomic, server-only writer
 * (no flock needed beyond atomic-rename).
 *
 * kind is the frozen ReactionKind enum ('ack' | 'seen' | 'done' | 'thumbs-up');
 * adding a kind requires a channelsProtocol.ts change so the UI label map
 * stays exhaustive (Theme C single-source).
 *
 * CONCURRENCY INVARIANT: the read-modify-write path (readStore → mutate →
 * writeStore) is FULLY SYNCHRONOUS — no `await` between read and write, and
 * writeFileAtomic uses writeFileSync + renameSync. JavaScript's single event
 * loop serializes sync blocks, so two addReaction/removeReaction calls CANNOT
 * interleave — the second waits at the event-loop level until the first
 * returns. Combined with the server-only-writer constraint (no CLI/external
 * caller touches this store), the classic lost-update RMW race is
 * architecturally precluded. Do NOT add a home-level lock — it adds complexity
 * for a scenario that cannot occur here. If you ever introduce an `await`
 * inside the RMW path, the invariant breaks → add a lock THEN.
 */

const REACTIONS_FILE = 'reactions.json';
const REACTIONS_VERSION = 1;
const MESSAGE_ID = /^msg-[A-Za-z0-9-]+$/;
const REACTIONS_SOURCE_FILE = /^(root|thread-msg-[A-Za-z0-9-]+)\.md$/;

export interface ReactionRef {
  channel: string;
  file: string;
  id: string;
  kind: ReactionKind;
  author?: string;
  createdAt: string;
}

export interface ReactionInput {
  channel: string;
  file: string;
  id: string;
  kind: ReactionKind;
  author?: string;
}

interface ReactionStore {
  version: number;
  items: ReactionRef[];
}

function reactionsPath(home: string): string {
  return join(home, REACTIONS_FILE);
}

function identityOf(item: Pick<ReactionRef, 'channel' | 'file' | 'id' | 'kind'>): string {
  return `${item.channel}/${item.file}:${item.id}:${item.kind}`;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireReactionInput(input: ReactionInput): ReactionInput {
  if (!isValidChannelName(input.channel)) {
    throw new Error(`invalid channel name: ${input.channel}`);
  }
  if (!REACTIONS_SOURCE_FILE.test(input.file)) {
    throw new Error(`invalid reaction source file: ${input.file}`);
  }
  if (!MESSAGE_ID.test(input.id)) {
    throw new Error(`invalid message id: ${input.id}`);
  }
  return {
    channel: input.channel,
    file: input.file,
    id: input.id,
    kind: input.kind,
    author: normalizeOptional(input.author)
  };
}

function parseStore(raw: string): ReactionStore {
  const parsed = JSON.parse(raw) as Partial<ReactionStore>;
  const items = Array.isArray(parsed.items)
    ? parsed.items.flatMap((item) => {
        if (
          item &&
          typeof item.channel === 'string' &&
          typeof item.file === 'string' &&
          typeof item.id === 'string' &&
          typeof item.kind === 'string' &&
          typeof item.createdAt === 'string'
        ) {
          try {
            const input = requireReactionInput({
              channel: item.channel,
              file: item.file,
              id: item.id,
              kind: item.kind as ReactionKind,
              author: typeof item.author === 'string' ? item.author : undefined
            });
            return [{ ...input, createdAt: item.createdAt }];
          } catch {
            return [];
          }
        }
        return [];
      })
    : [];
  return { version: REACTIONS_VERSION, items };
}

function readStore(home: string): ReactionStore {
  const path = reactionsPath(home);
  if (!existsSync(path)) {
    return { version: REACTIONS_VERSION, items: [] };
  }
  try {
    return parseStore(readFileSync(path, 'utf8'));
  } catch {
    return { version: REACTIONS_VERSION, items: [] };
  }
}

function writeStore(home: string, store: ReactionStore): void {
  writeFileAtomic(reactionsPath(home), `${JSON.stringify({ version: REACTIONS_VERSION, items: store.items }, null, 2)}\n`);
}

/** Lists every reaction across all channels (cross-channel aggregation). */
export function listReactions(home: string): ReactionRef[] {
  return readStore(home).items;
}

/**
 * Adds a reaction (idempotent per (channel, file, id, kind) — re-adding the
 * same kind updates `author` + `createdAt`). Multiple distinct kinds on the
 * same message coexist (e.g., one operator ack + another operator thumbs-up).
 */
export function addReaction(home: string, input: ReactionInput, now = new Date()): ReactionRef {
  const normalized = requireReactionInput(input);
  const next: ReactionRef = { ...normalized, createdAt: now.toISOString() };
  const store = readStore(home);
  const existing = store.items.findIndex((item) => identityOf(item) === identityOf(next));
  if (existing === -1) {
    store.items.push(next);
  } else {
    store.items[existing] = next;
  }
  writeStore(home, store);
  return next;
}

/** Removes a single reaction by its full identity (channel/file/id/kind). */
export function removeReaction(home: string, input: Pick<ReactionRef, 'channel' | 'file' | 'id' | 'kind'>): boolean {
  const normalized = requireReactionInput(input);
  const store = readStore(home);
  const before = store.items.length;
  store.items = store.items.filter((item) => identityOf(item) !== identityOf(normalized));
  if (store.items.length === before) {
    return false;
  }
  writeStore(home, store);
  return true;
}

/** Removes every reaction on a message (any kind) — used when a message is deleted. */
export function clearReactionsForMessage(home: string, channel: string, file: string, id: string): number {
  const store = readStore(home);
  const before = store.items.length;
  store.items = store.items.filter(
    (item) => !(item.channel === channel && item.file === file && item.id === id)
  );
  const removed = before - store.items.length;
  if (removed > 0) {
    writeStore(home, store);
  }
  return removed;
}
