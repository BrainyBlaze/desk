import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DriverEvent } from './driver.js';

/**
 * Desk-owned tool-event journal — the fix for agents whose APIs cannot return
 * tool items on resume (codex app-server 0.142.5: rollout persists
 * function_call records but no read surface exposes them as thread items).
 *
 * The host runner SEES every committed tool-start/tool-end live; this journal
 * remembers them in desk's OWN format (never parsing agent-internal stores),
 * anchored to the id of the message event they followed. On backfill, merge()
 * splices them back into the API-provided history at their anchors. toolUseId
 * dedupe keeps agents whose APIs DO return tools (claude/opencode) unaffected —
 * the journal only fills what the API cannot provide.
 */

export interface ToolJournalRecord {
  /** Id of the last committed user/assistant message before this tool event. */
  anchorId: string | null;
  event: DriverEvent;
}

export interface ToolJournal {
  append(anchorId: string | null, event: DriverEvent): void;
  /** Splice journaled tool events into API history at their anchor messages. */
  merge(history: DriverEvent[]): DriverEvent[];
  /** Number of records currently held (post-load, post-rotation). */
  size(): number;
}

const DEFAULT_CAP = 500;

export function toolJournalPath(tmuxSession: string, homeDir: string = homedir()): string {
  return join(homeDir, '.config', 'desk', 'tool-journal', `${tmuxSession}.jsonl`);
}

/** Delete a session's journal — same hygiene as broker.disposeSession (BUG-7 class). */
export function deleteToolJournal(tmuxSession: string, homeDir: string = homedir()): void {
  rmSync(toolJournalPath(tmuxSession, homeDir), { force: true });
}

export function createToolJournal(opts: { path: string; cap?: number }): ToolJournal {
  const cap = opts.cap ?? DEFAULT_CAP;
  let records: ToolJournalRecord[] = [];
  try {
    const lines = readFileSync(opts.path, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ToolJournalRecord;
        if (parsed && typeof parsed === 'object' && parsed.event && typeof parsed.event.kind === 'string') {
          records.push(parsed);
        }
      } catch {
        console.error(`tool-journal: dropping malformed line in ${opts.path}: ${line.slice(0, 120)}`);
      }
    }
  } catch {
    // No journal yet — fresh session.
  }
  if (records.length > cap) {
    records = records.slice(-cap);
    rewrite();
  }

  function rewrite(): void {
    mkdirSync(dirname(opts.path), { recursive: true });
    writeFileSync(opts.path, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  }

  return {
    append(anchorId, event) {
      const record: ToolJournalRecord = { anchorId, event };
      records.push(record);
      if (records.length > cap) {
        records = records.slice(-cap);
        rewrite();
        return;
      }
      try {
        mkdirSync(dirname(opts.path), { recursive: true });
        appendFileSync(opts.path, JSON.stringify(record) + '\n');
      } catch (err) {
        console.error(`tool-journal: append failed for ${opts.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    merge(history) {
      if (records.length === 0) {
        return history;
      }
      // Tool ids the API already returned — journal must not duplicate them.
      const present = new Set<string>();
      for (const event of history) {
        if (event.kind === 'tool-start' || event.kind === 'tool-end') {
          present.add(event.toolUseId);
        }
      }
      const byAnchor = new Map<string, ToolJournalRecord[]>();
      for (const record of records) {
        if (!record.anchorId) continue;
        if ((record.event.kind === 'tool-start' || record.event.kind === 'tool-end') && present.has(record.event.toolUseId)) {
          continue;
        }
        const group = byAnchor.get(record.anchorId) ?? [];
        group.push(record);
        byAnchor.set(record.anchorId, group);
      }
      if (byAnchor.size === 0) {
        return history;
      }
      const merged: DriverEvent[] = [];
      for (const event of history) {
        merged.push(event);
        const id = 'id' in event ? (event as { id?: string }).id : undefined;
        if (id && byAnchor.has(id)) {
          for (const record of byAnchor.get(id)!) {
            merged.push(record.event);
          }
          byAnchor.delete(id);
        }
      }
      // Anchors no longer present in history (pruned/compacted upstream) — their
      // context is gone; dropping beats floating orphan rows at the top.
      return merged;
    },

    size() {
      return records.length;
    }
  };
}
