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
  /** Text prefix of the anchor message — id-independent fallback for agents whose
   * live ids are synthetic (codex: live 'codex-user-N' vs history real item ids). */
  anchorText?: string;
  event: DriverEvent;
}

export interface ToolJournal {
  append(anchorId: string | null, event: DriverEvent, anchorText?: string): void;
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
    append(anchorId, event, anchorText) {
      const record: ToolJournalRecord = { anchorId, event, ...(anchorText ? { anchorText } : {}) };
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
      const seenJournalToolEvents = new Set<string>();
      const pending = records.filter((record) => {
        if (!record.anchorId && !record.anchorText) return false;
        if ((record.event.kind === 'tool-start' || record.event.kind === 'tool-end') && present.has(record.event.toolUseId)) {
          return false;
        }
        if (record.event.kind === 'tool-start' || record.event.kind === 'tool-end') {
          const key = `${record.event.kind}:${record.event.toolUseId}`;
          if (seenJournalToolEvents.has(key)) return false;
          seenJournalToolEvents.add(key);
        }
        return true;
      });
      if (pending.length === 0) {
        return history;
      }
      const groups: Array<{ anchorId: string | null; anchorText?: string; records: ToolJournalRecord[] }> = [];
      for (const record of pending) {
        const previous = groups.at(-1);
        if (previous && previous.anchorId === record.anchorId && previous.anchorText === record.anchorText) {
          previous.records.push(record);
        } else {
          groups.push({ anchorId: record.anchorId, ...(record.anchorText ? { anchorText: record.anchorText } : {}), records: [record] });
        }
      }
      const merged: DriverEvent[] = [];
      const used = new Set<(typeof groups)[number]>();
      const appendGroup = (group: (typeof groups)[number]): void => {
        used.add(group);
        for (const record of group.records) {
          merged.push(record.event);
        }
      };
      for (const event of history) {
        merged.push(event);
        const id = 'id' in event ? (event as { id?: string }).id : undefined;
        const text =
          event.kind === 'user-message' ? event.text.slice(0, 200) : event.kind === 'assistant-message' ? event.markdown.slice(0, 200) : undefined;
        let matchedById = false;
        if (id) {
          for (const group of groups) {
            if (!used.has(group) && group.anchorId === id) {
              appendGroup(group);
              matchedById = true;
            }
          }
        }
        if (!matchedById && text !== undefined) {
          const group = groups.find((candidate) => !used.has(candidate) && candidate.anchorText !== undefined && candidate.anchorText === text);
          if (group) {
            appendGroup(group);
          }
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
