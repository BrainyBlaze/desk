import { describe, expect, it } from 'vitest';
import { sliceMessages } from '../src/server/channels/store/fileStore.js';
import type { ChannelMessage } from '../src/server/channels/protocol/format.js';
import { WINDOW_CAP, applyWindow } from '../src/web/channels/channelsModel.js';
import type { ChannelDetail } from '../src/web/channels/channelsClient.js';

const message = (index: number): ChannelMessage => ({
  id: `msg-${index}`,
  author: 'codex',
  timestamp: `2026-06-21 09:${String(index % 60).padStart(2, '0')}:00`,
  body: `message ${index}`,
  hasEndTurn: true
});

const detail = (ids: number[], overrides: Partial<ChannelDetail> = {}): ChannelDetail => ({
  name: 'a',
  goal: '',
  members: [],
  files: [],
  contentRevision: 'r1',
  messages: ids.map(message),
  hasOlder: false,
  hasNewer: false,
  total: ids.length,
  startIndex: 0,
  ...overrides
});

describe('stage 1: server unread resolution', () => {
  it('reports firstUnreadId and unreadCount for a since window', () => {
    const messages = Array.from({ length: 10 }, (_, index) => message(index));
    const window = sliceMessages(messages, { since: 'msg-6', limit: 5 });
    expect(window.firstUnreadId).toBe('msg-7');
    expect(window.unreadCount).toBe(3);
    expect(window.sinceResolved).toBe(true);
  });

  it('treats an unknown since id as fully unread with no anchor target', () => {
    const messages = Array.from({ length: 4 }, (_, index) => message(index));
    const window = sliceMessages(messages, { since: 'msg-gone', limit: 5 });
    expect(window.firstUnreadId).toBeNull();
    expect(window.unreadCount).toBe(4);
    expect(window.sinceResolved).toBe(false);
  });

  it('reports zero unread when since is the tail', () => {
    const messages = Array.from({ length: 4 }, (_, index) => message(index));
    const window = sliceMessages(messages, { since: 'msg-3', limit: 5 });
    expect(window.firstUnreadId).toBeNull();
    expect(window.unreadCount).toBe(0);
    expect(window.sinceResolved).toBe(true);
  });
});

describe('stage 1: applyWindow', () => {
  it('never wipes a loaded window with an empty fetched page', () => {
    const current = detail([1, 2, 3]);
    const merged = applyWindow(current, detail([], { total: 3, hasNewer: true }), 'poll');
    expect(merged.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(merged.total).toBe(3);
  });

  it('caps the window on prepend by trimming the newest edge and keeping startIndex honest', () => {
    const ids = Array.from({ length: WINDOW_CAP + 40 }, (_, index) => index);
    const older = ids.slice(0, 40);
    const current = detail(ids.slice(40), { startIndex: 40, hasOlder: true, total: ids.length });
    const page = detail(older, { total: ids.length, hasOlder: false, startIndex: 0 });
    const merged = applyWindow(current, page, 'older');
    expect(merged.messages.length).toBe(WINDOW_CAP);
    expect(merged.messages[0].id).toBe('msg-0');
    expect(merged.startIndex).toBe(0);
    expect(merged.hasNewer).toBe(true);
    expect(older.every((id) => merged.messages.some((m) => m.id === `msg-${id}`))).toBe(true);
  });

  it('caps the window on append by trimming the oldest edge', () => {
    const ids = Array.from({ length: WINDOW_CAP + 20 }, (_, index) => index);
    const current = detail(ids.slice(0, WINDOW_CAP), { total: ids.length, hasNewer: true });
    const page = detail(ids.slice(WINDOW_CAP), { total: ids.length, startIndex: WINDOW_CAP });
    const merged = applyWindow(current, page, 'newer');
    expect(merged.messages.length).toBe(WINDOW_CAP);
    expect(merged.messages[merged.messages.length - 1].id).toBe(`msg-${WINDOW_CAP + 19}`);
    expect(merged.startIndex).toBe(20);
    expect(merged.hasOlder).toBe(true);
  });

  it('keeps merge-by-id identity adoption on poll reconcile', () => {
    const current = detail([1, 2, 3]);
    const merged = applyWindow(current, detail([1, 2, 3, 4], { total: 4 }), 'poll');
    expect(merged.messages[0]).toBe(current.messages[0]);
    expect(merged.messages.length).toBe(4);
  });
});
