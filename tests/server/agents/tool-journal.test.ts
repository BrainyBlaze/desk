import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolJournal, deleteToolJournal, toolJournalPath } from '../../../src/server/agents/host/toolJournal';
import type { DriverEvent } from '../../../src/server/agents/host/driver';

const dirs: string[] = [];
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tool-journal-'));
  dirs.push(dir);
  return join(dir, 'sess.jsonl');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const toolStart = (id: string): DriverEvent => ({ kind: 'tool-start', toolUseId: id, name: 'Bash', summary: 'pwd' });
const toolEnd = (id: string): DriverEvent => ({ kind: 'tool-end', toolUseId: id, status: 'ok' });
const user = (id: string, text = 'run it'): DriverEvent => ({ kind: 'user-message', id, text, source: 'ui' });
const assistant = (id: string): DriverEvent => ({ kind: 'assistant-message', id, turnId: 't1', markdown: 'done' });

describe('toolJournal merge (codex reload: API returns messages only)', () => {
  it('splices journaled tool events after their anchor message', () => {
    const j = createToolJournal({ path: tempPath() });
    j.append('u1', toolStart('tool-1'));
    j.append('u1', toolEnd('tool-1'));
    const merged = j.merge([user('u1'), assistant('a1')]);
    expect(merged.map((e) => e.kind)).toEqual(['user-message', 'tool-start', 'tool-end', 'assistant-message']);
  });

  it('does not duplicate tools the API already returned (claude/opencode unaffected)', () => {
    const j = createToolJournal({ path: tempPath() });
    j.append('u1', toolStart('tool-1'));
    j.append('u1', toolEnd('tool-1'));
    const merged = j.merge([user('u1'), toolStart('tool-1'), toolEnd('tool-1'), assistant('a1')]);
    expect(merged.filter((e) => e.kind === 'tool-start')).toHaveLength(1);
    expect(merged.filter((e) => e.kind === 'tool-end')).toHaveLength(1);
  });

  it('heals duplicate tool records already present inside the journal', () => {
    const j = createToolJournal({ path: tempPath() });
    j.append('u1', toolStart('tool-1'));
    j.append('u1', toolEnd('tool-1'));
    j.append('u1', toolStart('tool-1'));
    j.append('u1', toolEnd('tool-1'));

    const merged = j.merge([user('u1'), assistant('a1')]);

    expect(merged.filter((e) => e.kind === 'tool-start')).toHaveLength(1);
    expect(merged.filter((e) => e.kind === 'tool-end')).toHaveLength(1);
  });

  it('drops journaled events whose anchor is gone from history', () => {
    const j = createToolJournal({ path: tempPath() });
    j.append('u-pruned', toolStart('tool-9'));
    const merged = j.merge([user('u1')]);
    expect(merged.map((e) => e.kind)).toEqual(['user-message']);
  });

  it('merge is idempotent across repeated backfills (delayed re-backfill)', () => {
    const j = createToolJournal({ path: tempPath() });
    j.append('u1', toolStart('tool-1'));
    const first = j.merge([user('u1')]);
    const second = j.merge([user('u1')]);
    expect(second).toEqual(first);
  });

  it('text-anchor fallback consumes one live anchor group per repeated matching history message', () => {
    const j = createToolJournal({ path: tempPath() });
    j.append('live-u1', toolStart('tool-1'), 'same prompt');
    j.append('live-u1', toolEnd('tool-1'), 'same prompt');
    j.append('live-u2', toolStart('tool-2'), 'same prompt');
    j.append('live-u2', toolEnd('tool-2'), 'same prompt');

    const merged = j.merge([user('history-u1', 'same prompt'), assistant('a1'), user('history-u2', 'same prompt')]);

    expect(merged.map((event) => (event.kind === 'tool-start' || event.kind === 'tool-end' ? event.toolUseId : event.kind))).toEqual([
      'user-message',
      'tool-1',
      'tool-1',
      'assistant-message',
      'user-message',
      'tool-2',
      'tool-2'
    ]);
  });

  it('persists across instances (host restart) and caps records', () => {
    const path = tempPath();
    const j1 = createToolJournal({ path, cap: 3 });
    for (let i = 0; i < 5; i += 1) j1.append('u1', toolStart(`t-${i}`));
    const j2 = createToolJournal({ path, cap: 3 });
    expect(j2.size()).toBe(3);
    const merged = j2.merge([user('u1')]);
    expect(merged.filter((e) => e.kind === 'tool-start').map((e) => (e as { toolUseId: string }).toolUseId)).toEqual([
      't-2',
      't-3',
      't-4'
    ]);
  });

  it('survives malformed journal lines without dying', () => {
    const path = tempPath();
    const j1 = createToolJournal({ path });
    j1.append('u1', toolStart('tool-1'));
    // Corrupt the file with a garbage line then reload.
    const raw = readFileSync(path, 'utf8');
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(path, raw + 'NOT JSON\n');
    const j2 = createToolJournal({ path });
    expect(j2.size()).toBe(1);
  });
});

describe('toolJournal lifecycle', () => {
  it('deleteToolJournal removes the session file (delete-session hygiene)', () => {
    const home = mkdtempSync(join(tmpdir(), 'tj-home-'));
    dirs.push(home);
    const path = toolJournalPath('agentdesk-x-y-z', home);
    const j = createToolJournal({ path });
    j.append('u1', toolStart('tool-1'));
    deleteToolJournal('agentdesk-x-y-z', home);
    const j2 = createToolJournal({ path });
    expect(j2.size()).toBe(0);
  });
});
