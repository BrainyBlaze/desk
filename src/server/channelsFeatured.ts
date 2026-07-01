/*
 * CONCURRENCY INVARIANT: the read-modify-write path here is FULLY SYNCHRONOUS
 * (readFileSync -> mutate -> writeFileAtomic, which is writeFileSync + renameSync),
 * and the writer is server-only. JavaScript's single event loop serializes sync
 * blocks, so a classic read-modify-write lost-update race is architecturally
 * precluded. Do NOT add a home-level lock — it would be dead weight. If you ever
 * introduce an `await` inside the RMW path, the invariant breaks → add a lock THEN.
 * (Shared paragraph across the four stores: channelsFeatured / channelsReactions /
 * channelsViews / channelsPaused — single-source consistency.)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidChannelName, parseConversation } from './channelsProtocol.js';
import { writeFileAtomic } from './fsOps.js';

const FEATURED_FILE = 'featured.json';
const FEATURED_VERSION = 1;
const MESSAGE_ID = /^msg-[A-Za-z0-9-]+$/;
const FEATURED_SOURCE_FILE = /^(root|thread-msg-[A-Za-z0-9-]+)\.md$/;

export interface FeaturedRef {
  channel: string;
  file: string;
  id: string;
  savedAt: string;
  note?: string;
  tag?: string;
}

export interface FeaturedInput {
  channel: string;
  file: string;
  id: string;
  note?: string;
  tag?: string;
}

export interface FeaturedItem extends FeaturedRef {
  threadParent?: string;
  author?: string;
  timestamp?: string;
  snippet?: string;
  missing: boolean;
}

interface FeaturedStore {
  version: number;
  items: FeaturedRef[];
}

function featuredPath(home: string): string {
  return join(home, FEATURED_FILE);
}

function identityOf(item: Pick<FeaturedRef, 'channel' | 'file' | 'id'>): string {
  return `${item.channel}/${item.file}:${item.id}`;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireFeaturedInput(input: FeaturedInput): FeaturedInput {
  if (!isValidChannelName(input.channel)) {
    throw new Error(`invalid channel name: ${input.channel}`);
  }
  if (!FEATURED_SOURCE_FILE.test(input.file)) {
    throw new Error(`invalid featured source file: ${input.file}`);
  }
  if (!MESSAGE_ID.test(input.id)) {
    throw new Error(`invalid message id: ${input.id}`);
  }
  return {
    channel: input.channel,
    file: input.file,
    id: input.id,
    note: normalizeOptional(input.note),
    tag: normalizeOptional(input.tag)
  };
}

function parseStore(raw: string): FeaturedStore {
  const parsed = JSON.parse(raw) as Partial<FeaturedStore>;
  const items = Array.isArray(parsed.items)
    ? parsed.items.flatMap((item) => {
        if (
          item &&
          typeof item.channel === 'string' &&
          typeof item.file === 'string' &&
          typeof item.id === 'string' &&
          typeof item.savedAt === 'string'
        ) {
          const input = requireFeaturedInput(item);
          return [{ ...input, savedAt: item.savedAt }];
        }
        return [];
      })
    : [];
  return { version: FEATURED_VERSION, items };
}

function readStore(home: string): FeaturedStore {
  const path = featuredPath(home);
  if (!existsSync(path)) {
    return { version: FEATURED_VERSION, items: [] };
  }
  return parseStore(readFileSync(path, 'utf8'));
}

function writeStore(home: string, store: FeaturedStore): void {
  writeFileAtomic(featuredPath(home), `${JSON.stringify({ version: FEATURED_VERSION, items: store.items }, null, 2)}\n`);
}

export function listFeaturedRefs(home: string): FeaturedRef[] {
  return readStore(home).items;
}

export function addFeatured(home: string, input: FeaturedInput, now = new Date()): FeaturedRef {
  const normalized = requireFeaturedInput(input);
  const next: FeaturedRef = { ...normalized, savedAt: now.toISOString() };
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

export function removeFeatured(home: string, input: Pick<FeaturedRef, 'channel' | 'file' | 'id'>): boolean {
  const normalized = requireFeaturedInput(input);
  const store = readStore(home);
  const before = store.items.length;
  store.items = store.items.filter((item) => identityOf(item) !== identityOf(normalized));
  if (store.items.length === before) {
    return false;
  }
  writeStore(home, store);
  return true;
}

export function threadParentFromFeaturedFile(file: string): string | undefined {
  const match = /^thread-(msg-[A-Za-z0-9-]+)\.md$/.exec(file);
  return match?.[1];
}

function snippetOf(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function listFeaturedItems(home: string): FeaturedItem[] {
  return listFeaturedRefs(home).map((ref) => {
    const file = join(home, ref.channel, ref.file);
    const threadParent = threadParentFromFeaturedFile(ref.file);
    if (!existsSync(file)) {
      return { ...ref, threadParent, missing: true };
    }
    let message;
    try {
      message = parseConversation(readFileSync(file, 'utf8')).messages.find((candidate) => candidate.id === ref.id);
    } catch {
      return { ...ref, threadParent, missing: true };
    }
    if (!message) {
      return { ...ref, threadParent, missing: true };
    }
    return {
      ...ref,
      threadParent,
      author: message.author,
      timestamp: message.timestamp,
      snippet: snippetOf(message.body),
      missing: false
    };
  });
}
