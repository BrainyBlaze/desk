// Regression tests for channel storage stores: channelsReactions + channelsViews + channelsPaused.
// Mirrors the channelsFeatured test shape: add/remove/list/idempotency + corrupt-JSON fallback.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addReaction,
  clearReactionsForMessage,
  listReactions,
  removeReaction
} from '../src/server/channelsReactions.js';
import {
  addView,
  getView,
  listViews,
  removeView
} from '../src/server/channelsViews.js';
import {
  getPausedSession,
  isSessionPaused,
  listPausedSessions,
  pauseSession,
  resumeSession
} from '../src/server/channelsPaused.js';

describe('channelsReactions', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-reactions-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('adds a reaction and lists it back', () => {
    addReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-1-aaaa', kind: 'ack' });
    addReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-2-bbbb', kind: 'thumbs-up', author: 'human' });
    const reactions = listReactions(home);
    expect(reactions).toHaveLength(2);
    expect(reactions[0]).toMatchObject({ channel: 'ops', id: 'msg-1-aaaa', kind: 'ack' });
    expect(reactions[1]).toMatchObject({ channel: 'ops', id: 'msg-2-bbbb', kind: 'thumbs-up', author: 'human' });
  });

  it('coalesces by (channel/file/id/kind) — re-adding the same kind updates author + createdAt', () => {
    const first = addReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-1-aaaa', kind: 'ack' }, new Date('2026-06-18T10:00:00.000Z'));
    const second = addReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-1-aaaa', kind: 'ack', author: 'human' }, new Date('2026-06-18T10:00:01.000Z'));
    const reactions = listReactions(home);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]!.createdAt).toBe(second.createdAt);
    expect(reactions[0]!.author).toBe('human');
    expect(first.createdAt).not.toBe(second.createdAt);
  });

  it('allows multiple distinct kinds on the same message', () => {
    addReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-1-aaaa', kind: 'ack' });
    addReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-1-aaaa', kind: 'thumbs-up' });
    addReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-1-aaaa', kind: 'done' });
    expect(listReactions(home)).toHaveLength(3);
  });

  it('removes a single reaction by full identity (channel/file/id/kind)', () => {
    addReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-1-aaaa', kind: 'ack' });
    addReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-1-aaaa', kind: 'thumbs-up' });
    expect(removeReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-1-aaaa', kind: 'ack' })).toBe(true);
    expect(listReactions(home)).toHaveLength(1);
    expect(listReactions(home)[0]!.kind).toBe('thumbs-up');
  });

  it('returns false when removing a reaction that does not exist', () => {
    expect(removeReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-nope', kind: 'ack' })).toBe(false);
  });

  it('clearReactionsForMessage removes every kind on a message and returns the count', () => {
    addReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-1-aaaa', kind: 'ack' });
    addReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-1-aaaa', kind: 'thumbs-up' });
    addReaction(home, { channel: 'ops', file: 'root.md', id: 'msg-2-bbbb', kind: 'ack' });
    expect(clearReactionsForMessage(home, 'ops', 'root.md', 'msg-1-aaaa')).toBe(2);
    expect(listReactions(home)).toHaveLength(1);
    expect(listReactions(home)[0]!.id).toBe('msg-2-bbbb');
  });

  it('rejects invalid channel / file / id / kind inputs', () => {
    expect(() => addReaction(home, { channel: 'BAD!', file: 'root.md', id: 'msg-1', kind: 'ack' })).toThrow();
    expect(() => addReaction(home, { channel: 'ops', file: 'weird.md', id: 'msg-1', kind: 'ack' })).toThrow();
    expect(() => addReaction(home, { channel: 'ops', file: 'root.md', id: 'not-a-msg-id', kind: 'ack' })).toThrow();
  });

  it('falls back to empty list when the store file is corrupt', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'reactions.json'), '{ not valid json');
    expect(listReactions(home)).toEqual([]);
  });
});

describe('channelsViews', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-views-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('adds a view and lists it back', () => {
    addView(home, { name: 'mentions', filter: { mentionsMe: true } });
    addView(home, { name: 'claude-threads', filter: { author: 'claude', hasThread: true } });
    const views = listViews(home);
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ name: 'mentions', filter: { mentionsMe: true } });
    expect(views[1]).toMatchObject({ name: 'claude-threads', filter: { author: 'claude', hasThread: true } });
  });

  it('normalizes filter — trims text/author, omits empty strings, drops falsy booleans', () => {
    addView(home, { name: 'wide', filter: { text: '  deploy  ', author: '  ', mentionsMe: false, hasThread: undefined } });
    const view = getView(home, 'wide');
    expect(view?.filter).toEqual({ text: 'deploy' });
  });

  it('coalesces by name — re-adding the same name replaces the filter', () => {
    addView(home, { name: 'mentions', filter: { mentionsMe: true } });
    addView(home, { name: 'mentions', filter: { author: 'claude' } });
    const views = listViews(home);
    expect(views).toHaveLength(1);
    expect(views[0]!.filter).toEqual({ author: 'claude' });
  });

  it('removes a view by name', () => {
    addView(home, { name: 'mentions', filter: { mentionsMe: true } });
    expect(removeView(home, 'mentions')).toBe(true);
    expect(listViews(home)).toEqual([]);
  });

  it('returns false when removing a view that does not exist', () => {
    expect(removeView(home, 'never')).toBe(false);
  });

  it('rejects empty / overlong view names', () => {
    expect(() => addView(home, { name: '   ', filter: {} })).toThrow(/empty/);
    expect(() => addView(home, { name: 'x'.repeat(81), filter: {} })).toThrow(/exceeds/);
  });

  it('falls back to empty list when the store file is corrupt', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'views.json'), '<not json>');
    expect(listViews(home)).toEqual([]);
  });
});

describe('channelsPaused', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-paused-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('pauses a session and reports paused state', () => {
    expect(isSessionPaused(home, 'tmux-a')).toBe(false);
    pauseSession(home, 'tmux-a', 'sensitive ops');
    expect(isSessionPaused(home, 'tmux-a')).toBe(true);
    const sessions = listPausedSessions(home);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ tmuxSession: 'tmux-a', reason: 'sensitive ops' });
  });

  it('getPausedSession returns the record with reason + pausedAt', () => {
    pauseSession(home, 'tmux-a', 'sensitive ops');
    const record = getPausedSession(home, 'tmux-a');
    expect(record).toBeDefined();
    expect(record!.reason).toBe('sensitive ops');
    expect(record!.pausedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('re-pausing updates reason + pausedAt (idempotent per session)', () => {
    const first = pauseSession(home, 'tmux-a', 'reason-1', new Date('2026-06-18T10:00:00.000Z'));
    const second = pauseSession(home, 'tmux-a', 'reason-2', new Date('2026-06-18T10:00:01.000Z'));
    expect(listPausedSessions(home)).toHaveLength(1);
    expect(getPausedSession(home, 'tmux-a')!.reason).toBe('reason-2');
    expect(second.pausedAt).not.toBe(first.pausedAt);
  });

  it('resumes a session (idempotent on non-paused)', () => {
    pauseSession(home, 'tmux-a');
    expect(resumeSession(home, 'tmux-a')).toBe(true);
    expect(isSessionPaused(home, 'tmux-a')).toBe(false);
    expect(resumeSession(home, 'tmux-a')).toBe(false);
  });

  it('reason is optional and trimmed', () => {
    pauseSession(home, 'tmux-a', '   ');
    expect(getPausedSession(home, 'tmux-a')!.reason).toBeUndefined();
    pauseSession(home, 'tmux-b', '  explicit reason  ');
    expect(getPausedSession(home, 'tmux-b')!.reason).toBe('explicit reason');
  });

  it('persists across re-reads (engine restore reads the same file)', () => {
    pauseSession(home, 'tmux-a', 'long-running');
    pauseSession(home, 'tmux-b');
    // Simulate an engine restore: read the file fresh.
    expect(listPausedSessions(home)).toHaveLength(2);
    expect(isSessionPaused(home, 'tmux-a')).toBe(true);
    expect(isSessionPaused(home, 'tmux-b')).toBe(true);
    expect(isSessionPaused(home, 'tmux-c')).toBe(false);
  });

  it('rejects invalid tmux session names', () => {
    expect(() => pauseSession(home, '1bad', 'reason')).toThrow();
    expect(() => pauseSession(home, 'has space', 'reason')).toThrow();
  });

  it('falls back to empty list when the store file is corrupt', () => {
    mkdirSync(join(home, '_engine'), { recursive: true });
    writeFileSync(join(home, '_engine', 'paused.json'), 'garbage');
    expect(listPausedSessions(home)).toEqual([]);
    expect(isSessionPaused(home, 'tmux-a')).toBe(false);
  });
});
