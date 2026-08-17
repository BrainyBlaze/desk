// The inverse of the export: applying a message that already has an identity.
//
// appendMessage mints id and timestamp, which is right for a live post and
// wrong for everything that re-enters the store — a restore from an export, a
// transfer between homes, a replay of externally produced blocks. These tests
// pin the ingest contract: identity preserved verbatim, idempotence by id,
// loud mismatch on a dedupe hit, no orphaned thread replies, and a quiet mode
// that applies without prompting a single agent.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileChannelStore, IngestParentNotFoundError } from '../src/server/channels/ports.js';
import {
  appendMessage,
  createChannel,
  readChannelMessage,
  type IncomingChannelMessage
} from '../src/server/channels/store/fileStore.js';

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ChannelStore.ingest', () => {
  let home: string;
  let store: FileChannelStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-ingest-'));
    store = new FileChannelStore(home);
    createChannel(home, 'ops', 'goal');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  const foreign = (id: string, body = 'restored body') => ({
    id,
    author: 'scribe',
    timestamp: '2026-08-01 09:15:00',
    body
  });

  it('preserves id, author and timestamp verbatim', async () => {
    const result = await store.ingest('ops', foreign('msg-20260801-091500-aaaa0001'));
    expect(result).toEqual({ applied: true, file: 'root.md' });
    const stored = readChannelMessage(home, 'ops', 'msg-20260801-091500-aaaa0001');
    expect(stored.author).toBe('scribe');
    expect(stored.timestamp).toBe('2026-08-01 09:15:00');
    expect(stored.body).toBe('restored body');
    expect(stored.hasEndTurn).toBe(true);
  });

  it('is idempotent by id: a repeat is a no-op, not a duplicate', async () => {
    await store.ingest('ops', foreign('msg-20260801-091500-aaaa0002'));
    const repeat = await store.ingest('ops', foreign('msg-20260801-091500-aaaa0002'));
    expect(repeat).toEqual({ applied: false, file: 'root.md' });
    const detail = await store.readChannel('ops');
    expect(detail.messages.filter((m) => m.id === 'msg-20260801-091500-aaaa0002')).toHaveLength(1);
  });

  it('warns loudly when a dedupe hit carries different content — the one symptom of an id collision', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.ingest('ops', foreign('msg-20260801-091500-aaaa0003', 'first body'));
    const repeat = await store.ingest('ops', foreign('msg-20260801-091500-aaaa0003', 'DIFFERENT body'));
    expect(repeat.applied).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('id collision');
    // The existing message wins; nothing was overwritten.
    expect(readChannelMessage(home, 'ops', 'msg-20260801-091500-aaaa0003').body).toBe('first body');
  });

  it('finds the dedupe hit inside a thread too, not only in root', async () => {
    const parent = await appendMessage(home, 'ops', { author: 'human', body: 'parent' });
    await store.ingest('ops', { ...foreign('msg-20260801-091500-aaaa0004', 'reply'), threadParentId: parent.message.id });
    const repeat = await store.ingest('ops', { ...foreign('msg-20260801-091500-aaaa0004', 'reply'), threadParentId: parent.message.id });
    expect(repeat.applied).toBe(false);
    expect(repeat.file).toBe(`thread-${parent.message.id}.md`);
  });

  it('refuses to orphan a thread reply, with a parkable error code', async () => {
    const attempt = store.ingest('ops', { ...foreign('msg-20260801-091500-aaaa0005'), threadParentId: 'msg-20260801-090000-dead0000' });
    await expect(attempt).rejects.toBeInstanceOf(IngestParentNotFoundError);
    await expect(attempt).rejects.toMatchObject({ code: 'parent-not-found' });
  });

  it('creates the thread lazily and keeps the parent reply count converging', async () => {
    const parent = await appendMessage(home, 'ops', { author: 'human', body: 'parent' });
    await store.ingest('ops', { ...foreign('msg-20260801-091500-aaaa0006', 'reply one'), threadParentId: parent.message.id });
    await store.ingest('ops', { ...foreign('msg-20260801-091600-aaaa0007', 'reply two'), threadParentId: parent.message.id });
    const detail = await store.readChannel('ops');
    const root = detail.messages.find((m) => m.id === parent.message.id);
    expect(root?.threadFile).toBe(`thread-${parent.message.id}.md`);
    expect(root?.threadReplies).toBe(2);
    expect((await store.readThread('ops', parent.message.id)).map((m) => m.body)).toEqual(['reply one', 'reply two']);
  });

  it('reaches subscribers through onFinalized exactly once, like any externally written block', async () => {
    const incoming: IncomingChannelMessage[] = [];
    const unsubscribe = store.onFinalized((event) => {
      incoming.push(event);
    });
    try {
      // Let the change-feed watcher finish standing up before the write lands;
      // events fired mid-initialisation are best-effort (the 30s sweep is the
      // production backstop, too slow for a test).
      await settle(300);
      await store.ingest('ops', foreign('msg-20260801-091500-aaaa0008'));
      await vi.waitFor(
        () => {
          expect(incoming.map((event) => event.message.id)).toEqual(['msg-20260801-091500-aaaa0008']);
        },
        { timeout: 3000 }
      );
      await settle();
      expect(incoming).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('quiet: applies without dispatching, even with the watcher already running', async () => {
    const incoming: string[] = [];
    const unsubscribe = store.onFinalized((event) => {
      incoming.push(event.message.id);
    });
    try {
      await settle(300);
      await store.ingest('ops', foreign('msg-20260801-091500-aaaa0009', 'a month of history'), { quiet: true });
      await settle();
      expect(incoming).toEqual([]);
      // The message is there — it just never prompted anyone.
      expect(readChannelMessage(home, 'ops', 'msg-20260801-091500-aaaa0009').body).toBe('a month of history');
      // A live ingest afterwards still dispatches: quiet muted one message, not the feed.
      await store.ingest('ops', foreign('msg-20260801-091600-aaaa0010', 'live again'));
      await vi.waitFor(() => {
        expect(incoming).toEqual(['msg-20260801-091600-aaaa0010']);
      });
    } finally {
      unsubscribe();
    }
  });

  it('rejects malformed identity instead of writing an unparsable block', async () => {
    await expect(store.ingest('ops', { ...foreign('not-a-message-id') })).rejects.toThrow('invalid message id');
    await expect(store.ingest('ops', { ...foreign('msg-20260801-091500-aaaa0011'), author: 'bad author' })).rejects.toThrow('invalid author');
    await expect(store.ingest('ops', { ...foreign('msg-20260801-091500-aaaa0012'), author: '**bold**' })).rejects.toThrow('invalid author');
    await expect(store.ingest('ops', { ...foreign('msg-20260801-091500-aaaa0013'), timestamp: 'two\nlines' })).rejects.toThrow('invalid timestamp');
    await expect(store.ingest('ops', { ...foreign('msg-20260801-091500-aaaa0014'), timestamp: 'has ** inside' })).rejects.toThrow('invalid timestamp');
    await expect(store.ingest('ops', { ...foreign('msg-20260801-091500-aaaa0015'), body: '   ' })).rejects.toThrow('empty');
    await expect(store.ingest('ops', { ...foreign('msg-20260801-091500-aaaa0016'), body: 'x'.repeat(17 * 1024) })).rejects.toThrow('exceeds');
    await expect(store.ingest('missing', foreign('msg-20260801-091500-aaaa0017'))).rejects.toThrow("channel 'missing' not found");
  });
});
