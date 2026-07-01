import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ViewFilter } from './channelsProtocol.js';
import { writeFileAtomic } from './fsOps.js';

/**
 * Channels saved-views store — operator-named filter views. Mirrors the
 * channelsFeatured pattern: single global JSON file under the channels home,
 * atomic writes via writeFileAtomic, server-only writer.
 *
 * `filter` is the frozen ViewFilter type (text? / author? / mentionsMe? /
 * hasThread?); adding a field requires a channelsProtocol.ts change so the
 * channelsModel matcher stays exhaustive (Theme C single-source).
 *
 * CONCURRENCY INVARIANT: the read-modify-write path (readStore → mutate →
 * writeStore) is FULLY SYNCHRONOUS — no `await` between read and write, and
 * writeFileAtomic uses writeFileSync + renameSync. JavaScript's single event
 * loop serializes sync blocks, so two addView/removeView calls CANNOT
 * interleave — the second waits at the event-loop level until the first
 * returns. Combined with the server-only-writer constraint (no CLI/external
 * caller touches this store), the classic lost-update RMW race is
 * architecturally precluded. Do NOT add a home-level lock — it adds complexity
 * for a scenario that cannot occur here. If you ever introduce an `await`
 * inside the RMW path, the invariant breaks → add a lock THEN.
 */

const VIEWS_FILE = 'views.json';
const VIEWS_VERSION = 1;
const VIEW_NAME_MAX = 80;

export interface SavedView {
  name: string;
  filter: ViewFilter;
  createdAt: string;
}

export interface SavedViewInput {
  name: string;
  filter: ViewFilter;
}

interface ViewStore {
  version: number;
  items: SavedView[];
}

function viewsPath(home: string): string {
  return join(home, VIEWS_FILE);
}

function normalizeFilter(filter: ViewFilter): ViewFilter {
  const normalized: ViewFilter = {};
  const text = filter.text?.trim();
  if (text) {
    normalized.text = text;
  }
  const author = filter.author?.trim();
  if (author) {
    normalized.author = author;
  }
  if (filter.mentionsMe === true) {
    normalized.mentionsMe = true;
  }
  if (filter.hasThread === true) {
    normalized.hasThread = true;
  }
  return normalized;
}

function requireViewInput(input: SavedViewInput): SavedViewInput {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new Error('view name cannot be empty');
  }
  if (name.length > VIEW_NAME_MAX) {
    throw new Error(`view name exceeds ${VIEW_NAME_MAX} characters`);
  }
  return { name, filter: normalizeFilter(input.filter) };
}

function parseStore(raw: string): ViewStore {
  const parsed = JSON.parse(raw) as Partial<ViewStore>;
  const items = Array.isArray(parsed.items)
    ? parsed.items.flatMap((item) => {
        if (
          item &&
          typeof item.name === 'string' &&
          item.filter &&
          typeof item.filter === 'object' &&
          typeof item.createdAt === 'string'
        ) {
          try {
            const input = requireViewInput({ name: item.name, filter: item.filter as ViewFilter });
            return [{ ...input, createdAt: item.createdAt }];
          } catch {
            return [];
          }
        }
        return [];
      })
    : [];
  return { version: VIEWS_VERSION, items };
}

function readStore(home: string): ViewStore {
  const path = viewsPath(home);
  if (!existsSync(path)) {
    return { version: VIEWS_VERSION, items: [] };
  }
  try {
    return parseStore(readFileSync(path, 'utf8'));
  } catch {
    return { version: VIEWS_VERSION, items: [] };
  }
}

function writeStore(home: string, store: ViewStore): void {
  writeFileAtomic(viewsPath(home), `${JSON.stringify({ version: VIEWS_VERSION, items: store.items }, null, 2)}\n`);
}

/** Lists every saved view (operator's filter library). */
export function listViews(home: string): SavedView[] {
  return readStore(home).items;
}

/**
 * Adds or replaces a saved view by name (idempotent per name — re-adding the
 * same name updates `filter` + `createdAt`).
 */
export function addView(home: string, input: SavedViewInput, now = new Date()): SavedView {
  const normalized = requireViewInput(input);
  const next: SavedView = { ...normalized, createdAt: now.toISOString() };
  const store = readStore(home);
  const existing = store.items.findIndex((item) => item.name === next.name);
  if (existing === -1) {
    store.items.push(next);
  } else {
    store.items[existing] = next;
  }
  writeStore(home, store);
  return next;
}

/** Removes a saved view by name. */
export function removeView(home: string, name: string): boolean {
  const trimmed = name.trim();
  const store = readStore(home);
  const before = store.items.length;
  store.items = store.items.filter((item) => item.name !== trimmed);
  if (store.items.length === before) {
    return false;
  }
  writeStore(home, store);
  return true;
}

/** Looks up a saved view by name (case-sensitive exact match). */
export function getView(home: string, name: string): SavedView | undefined {
  const trimmed = name.trim();
  return readStore(home).items.find((item) => item.name === trimmed);
}
