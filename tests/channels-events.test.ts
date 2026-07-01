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
  readDeliveryEvents
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
    appendDeliveryEvent(home, { kind: 'queued', tmuxSession: 'tmux-a', channel: 'ops', messageId: 'msg-1' });
    appendDeliveryEvent(home, { kind: 'delivering', tmuxSession: 'tmux-a', messageId: 'msg-1' });
    appendDeliveryEvent(home, { kind: 'submitted', tmuxSession: 'tmux-a', messageId: 'msg-1' });

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

  it('filters by tmuxSession', () => {
    appendDeliveryEvent(home, { kind: 'queued', tmuxSession: 'tmux-a' });
    appendDeliveryEvent(home, { kind: 'queued', tmuxSession: 'tmux-b' });
    appendDeliveryEvent(home, { kind: 'delivering', tmuxSession: 'tmux-a' });

    const aEvents = readDeliveryEvents(home, { tmuxSession: 'tmux-a' });
    expect(aEvents).toHaveLength(2);
    expect(aEvents.every((e) => e.tmuxSession === 'tmux-a')).toBe(true);
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

  it('returns [] when the events file does not exist', () => {
    expect(readDeliveryEvents(home)).toEqual([]);
    expect(latestEventSeq(home)).toBe(0);
  });

  it('persists across re-reads (engine restore reads the same file)', () => {
    appendDeliveryEvent(home, { kind: 'paused', tmuxSession: 'tmux-a', reason: 'sensitive' });
    appendDeliveryEvent(home, { kind: 'resumed', tmuxSession: 'tmux-a' });
    // Simulate engine restart: read fresh.
    const events = readDeliveryEvents(home);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'paused', reason: 'sensitive' });
    expect(events[1]).toMatchObject({ kind: 'resumed' });
  });
});
