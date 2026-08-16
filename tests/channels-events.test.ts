// delivery-history events-ring tests: append / read / filter / prune /
// corrupt-line fallback / ring-bound enforcement.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendDeliveryEvent,
  latestEventSeq,
  pruneDeliveryEvents,
  readDeliveryEvents,
  resetDeliveryEventSeqCache
} from '../src/server/channelsEvents.js';

describe('channelsEvents', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-events-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('appends events with monotonic seq and reads them back in order', () => {
    appendDeliveryEvent(home, { kind: 'queued', sessionId: 'tmux-a', channel: 'ops', messageId: 'msg-1' });
    appendDeliveryEvent(home, { kind: 'delivering', sessionId: 'tmux-a', messageId: 'msg-1' });
    appendDeliveryEvent(home, { kind: 'submitted', sessionId: 'tmux-a', messageId: 'msg-1' });

    const events = readDeliveryEvents(home);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ seq: 1, kind: 'queued' });
    expect(events[1]).toMatchObject({ seq: 2, kind: 'delivering' });
    expect(events[2]).toMatchObject({ seq: 3, kind: 'submitted' });
    expect(events[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('latestEventSeq returns the last seq (0 if empty)', () => {
    expect(latestEventSeq(home)).toBe(0);
    appendDeliveryEvent(home, { kind: 'queued' });
    appendDeliveryEvent(home, { kind: 'delivering' });
    expect(latestEventSeq(home)).toBe(2);
  });

  it('filters by sessionId', () => {
    appendDeliveryEvent(home, { kind: 'queued', sessionId: 'tmux-a' });
    appendDeliveryEvent(home, { kind: 'queued', sessionId: 'tmux-b' });
    appendDeliveryEvent(home, { kind: 'delivering', sessionId: 'tmux-a' });

    const aEvents = readDeliveryEvents(home, { sessionId: 'tmux-a' });
    expect(aEvents).toHaveLength(2);
    expect(aEvents.every((e) => e.sessionId === 'tmux-a')).toBe(true);
  });

  it('filters by kind', () => {
    appendDeliveryEvent(home, { kind: 'queued' });
    appendDeliveryEvent(home, { kind: 'delivering' });
    appendDeliveryEvent(home, { kind: 'submitted' });
    appendDeliveryEvent(home, { kind: 'queued' });

    const queued = readDeliveryEvents(home, { kind: 'queued' });
    expect(queued).toHaveLength(2);
    expect(queued.every((e) => e.kind === 'queued')).toBe(true);
  });

  it('filters by sinceSeq (exclusive — returns events AFTER the cursor)', () => {
    appendDeliveryEvent(home, { kind: 'queued' });
    appendDeliveryEvent(home, { kind: 'delivering' });
    appendDeliveryEvent(home, { kind: 'submitted' });

    const since1 = readDeliveryEvents(home, { sinceSeq: 1 });
    expect(since1).toHaveLength(2);
    expect(since1[0]!.seq).toBe(2);
  });

  it('limits to the last N events (newest)', () => {
    for (let i = 0; i < 10; i += 1) {
      appendDeliveryEvent(home, { kind: 'queued' });
    }
    const last3 = readDeliveryEvents(home, { limit: 3 });
    expect(last3).toHaveLength(3);
    expect(last3[0]!.seq).toBe(8);
    expect(last3[2]!.seq).toBe(10);
  });

  it('prunes to maxEvents keeping the newest', () => {
    for (let i = 0; i < 20; i += 1) {
      appendDeliveryEvent(home, { kind: 'queued' });
    }
    expect(readDeliveryEvents(home)).toHaveLength(20);
    const pruned = pruneDeliveryEvents(home, 10);
    expect(pruned).toBe(10);
    const remaining = readDeliveryEvents(home);
    expect(remaining).toHaveLength(10);
    expect(remaining[0]!.seq).toBe(11);
    expect(remaining[9]!.seq).toBe(20);
  });

  it('periodically enforces the default ring bound while appending', () => {
    for (let i = 0; i < 11_000; i += 1) {
      appendDeliveryEvent(home, { kind: 'queued' });
    }

    const path = join(home, '_engine', 'events.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(10_000);
    expect(JSON.parse(lines[0]!)).toMatchObject({ seq: 1001 });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ seq: 11_000 });
  });

  it('prune is a no-op when under the cap', () => {
    appendDeliveryEvent(home, { kind: 'queued' });
    appendDeliveryEvent(home, { kind: 'delivering' });
    const pruned = pruneDeliveryEvents(home, 100);
    expect(pruned).toBe(0);
    expect(readDeliveryEvents(home)).toHaveLength(2);
  });

  it('skips corrupt lines (partial JSON) without losing other events', () => {
    appendDeliveryEvent(home, { kind: 'queued' });
    appendDeliveryEvent(home, { kind: 'delivering' });
    // Manually inject a corrupt line between valid entries.
    const path = join(home, '_engine', 'events.jsonl');
    const content = readFileSync(path, 'utf8');
    writeFileSync(path, content.slice(0, -1) + '\n{ corrupt line\n{"seq":99,"at":"x","kind":"submitted"}\n');
    const events = readDeliveryEvents(home);
    // The corrupt line is skipped; the valid events (including the manually-added one) survive.
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.some((e) => e.seq === 99 && e.kind === 'submitted')).toBe(true);
  });

  it('a torn last line does not reset the seq authority: the next append continues after the last VALID seq', () => {
    // A crash mid-append leaves a partial JSON tail. Reading "1" from that and
    // stamping the next event seq 1 after thousands of real events corrupts
    // ring order and latestEventSeq. The authority is the last line that
    // parses, scanning backwards.
    appendDeliveryEvent(home, { kind: 'queued', sessionId: 'tmux-a' });
    appendDeliveryEvent(home, { kind: 'delivering', sessionId: 'tmux-a' });
    appendDeliveryEvent(home, { kind: 'submitted', sessionId: 'tmux-a' });
    const path = join(home, '_engine', 'events.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8') + '{"seq":4,"at":"x","ki');
    resetDeliveryEventSeqCache();
    const next = appendDeliveryEvent(home, { kind: 'released', sessionId: 'tmux-a' });
    expect(next.seq).toBe(4);
    expect(latestEventSeq(home)).toBe(4);
  });

  it('refuses to append when no line of a nonempty ring parses', () => {
    // Nothing valid to continue from is not "start over at 1": that would
    // silently restart the numbering of a ring an operator is still reading.
    mkdirSync(join(home, '_engine'), { recursive: true });
    const path = join(home, '_engine', 'events.jsonl');
    writeFileSync(path, '{ corrupt\n{ also corrupt\n');
    resetDeliveryEventSeqCache();
    expect(() => appendDeliveryEvent(home, { kind: 'queued' })).toThrow(/events ring/);
    // The evidence is untouched.
    expect(readFileSync(path, 'utf8')).toBe('{ corrupt\n{ also corrupt\n');
  });

  it('prune refuses to rewrite a ring it could not read completely', () => {
    // A rewrite from a lossy read would silently drop the lines it skipped.
    // Prune must either keep every byte it did not understand or refuse.
    for (let index = 0; index < 5; index += 1) {
      appendDeliveryEvent(home, { kind: 'queued', messageId: `msg-${index}` });
    }
    const path = join(home, '_engine', 'events.jsonl');
    const before = readFileSync(path, 'utf8');
    writeFileSync(path, before.replace('"msg-2"', '"msg-2"}}}garbage'));
    const corrupt = readFileSync(path, 'utf8');
    expect(() => pruneDeliveryEvents(home, 2)).toThrow(/events ring/);
    expect(readFileSync(path, 'utf8')).toBe(corrupt);
  });

  it('returns [] when the events file does not exist', () => {
    expect(readDeliveryEvents(home)).toEqual([]);
    expect(latestEventSeq(home)).toBe(0);
  });

  describe('a ring Desk v0.3.1 wrote (records keyed by the retired per-session identity)', () => {
    // A real v0.3.1 record, values shortened: session-scoped, keyed by
    // `tmuxSession`, no `sessionId`. The v0.3.2 migration kept in place every
    // record whose session no longer existed, so a correctly migrated ring can
    // still hold one — refusing the whole ring here would assert "pre-cutover
    // store" about a store that was already migrated and name a remedy already
    // applied. What the reader knows is only that this record cannot be
    // attributed: it carries the retired identity under `preCutoverSession`,
    // gives it no `sessionId`, and drops neither the record nor the fact.
    const V031_LINE = JSON.stringify({
      kind: 'delivering',
      tmuxSession: 'agentdesk-desk-channels-super-2e997e43',
      channel: 'channels',
      messageId: 'msg-20260618-221813-5077',
      preview: '[#channels] New message from @desk-channels-codex',
      seq: 1,
      at: '2026-06-18T22:30:28.506Z'
    });

    it('reads such a record, carrying the retired identity and refusing to invent a sessionId', () => {
      mkdirSync(join(home, '_engine'), { recursive: true });
      const path = join(home, '_engine', 'events.jsonl');
      writeFileSync(path, `${V031_LINE}\n${V031_LINE.replace('"seq":1', '"seq":2')}\n`);

      const events = readDeliveryEvents(home);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        seq: 1,
        kind: 'delivering',
        channel: 'channels',
        preCutoverSession: 'agentdesk-desk-channels-super-2e997e43'
      });
      // The record is not attributed to any live session, and the retired key
      // is gone from the object — carried only under the named field.
      expect(events[0]).not.toHaveProperty('sessionId');
      expect(events[0]).not.toHaveProperty('tmuxSession');
      // The seq authority reads it like any other record.
      expect(latestEventSeq(home)).toBe(2);
    });

    it('never matches a per-session filter, because the record cannot be attributed to that session', () => {
      mkdirSync(join(home, '_engine'), { recursive: true });
      writeFileSync(
        join(home, '_engine', 'events.jsonl'),
        `${V031_LINE}\n{"seq":2,"at":"2026-08-16T00:00:00.000Z","kind":"queued","sessionId":"alpha"}\n`
      );
      // Filtering for the live session returns only the live record — the
      // pre-cutover one is neither dropped from an unfiltered read nor
      // smuggled into a session it never belonged to.
      const filtered = readDeliveryEvents(home, { sessionId: 'alpha' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toMatchObject({ seq: 2, sessionId: 'alpha' });
      expect(readDeliveryEvents(home)).toHaveLength(2);
    });

    it('keeps a live sessionId when a record carries both it and the retired key', () => {
      // A record the migration DID map keeps its sessionId; a stray retired key
      // must not erase that knowledge. The reader carries both facts.
      mkdirSync(join(home, '_engine'), { recursive: true });
      writeFileSync(
        join(home, '_engine', 'events.jsonl'),
        `${JSON.stringify({ seq: 1, at: '2026-08-16T00:00:00.000Z', kind: 'queued', sessionId: 'beta', tmuxSession: 'legacy-beta' })}\n`
      );
      const [event] = readDeliveryEvents(home);
      expect(event).toMatchObject({ sessionId: 'beta', preCutoverSession: 'legacy-beta' });
      expect(readDeliveryEvents(home, { sessionId: 'beta' })).toHaveLength(1);
    });

    it('does not mistake a current record that merely lacks a sessionId for a pre-cutover one', () => {
      appendDeliveryEvent(home, { kind: 'queued' });
      const [event] = readDeliveryEvents(home);
      expect(event).not.toHaveProperty('preCutoverSession');
    });

    it('prune keeps such records byte-for-byte while they are among the newest, and lets them age out otherwise', () => {
      mkdirSync(join(home, '_engine'), { recursive: true });
      const path = join(home, '_engine', 'events.jsonl');
      const current = (seq: number) => JSON.stringify({ seq, at: '2026-08-16T00:00:00.000Z', kind: 'queued', sessionId: 'alpha' });
      writeFileSync(path, `${V031_LINE}\n${current(2)}\n${current(3)}\n`);
      // Under the cap: nothing rewritten, the old record is left as it is.
      expect(pruneDeliveryEvents(home, 3)).toBe(0);
      expect(readFileSync(path, 'utf8')).toBe(`${V031_LINE}\n${current(2)}\n${current(3)}\n`);
      // Over the cap: the oldest goes, and the oldest is the pre-cutover one —
      // that is how a migrated ring sheds the residue v0.3.2 could not map.
      expect(pruneDeliveryEvents(home, 2)).toBe(1);
      expect(readFileSync(path, 'utf8')).toBe(`${current(2)}\n${current(3)}\n`);
      expect(readDeliveryEvents(home)).toHaveLength(2);
    });

    it('prune rewrites a surviving pre-cutover record with its retired key intact — it re-keys nothing', () => {
      // A prune that actually rewrites (over the cap) and whose surviving set
      // still contains a pre-cutover record must leave that record on disk in
      // the shape it found it: prune is a bounded rewrite, not a migration, and
      // has no map to "promote" the retired key into `preCutoverSession`. The
      // read-time carry is a projection; laundering it into the file would make
      // prune assert an attribution it does not have. Here the pre-cutover
      // record is NOT the oldest, so it survives the prune.
      mkdirSync(join(home, '_engine'), { recursive: true });
      const path = join(home, '_engine', 'events.jsonl');
      const current = (seq: number) => JSON.stringify({ seq, at: '2026-08-16T00:00:00.000Z', kind: 'queued', sessionId: 'alpha' });
      const survivingLegacy = V031_LINE.replace('"seq":1', '"seq":2');
      writeFileSync(path, `${current(1)}\n${survivingLegacy}\n${current(3)}\n`);

      expect(pruneDeliveryEvents(home, 2)).toBe(1);
      const onDisk = readFileSync(path, 'utf8');
      // The surviving legacy record is byte-for-byte its original line: retired
      // key present, no invented `preCutoverSession` written to the file.
      expect(onDisk).toBe(`${survivingLegacy}\n${current(3)}\n`);
      expect(onDisk).toContain('tmuxSession');
      expect(onDisk).not.toContain('preCutoverSession');
      // And the read still projects it — the carry lives at the reader, not the file.
      const carried = readDeliveryEvents(home).find((event) => event.seq === 2);
      expect(carried).toMatchObject({ preCutoverSession: 'agentdesk-desk-channels-super-2e997e43' });
      expect(carried).not.toHaveProperty('sessionId');
    });
  });

  it('persists across re-reads (engine restore reads the same file)', () => {
    appendDeliveryEvent(home, { kind: 'paused', sessionId: 'tmux-a', reason: 'sensitive' });
    appendDeliveryEvent(home, { kind: 'resumed', sessionId: 'tmux-a' });
    // Simulate engine restart: read fresh.
    const events = readDeliveryEvents(home);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'paused', reason: 'sensitive' });
    expect(events[1]).toMatchObject({ kind: 'resumed' });
  });
});
