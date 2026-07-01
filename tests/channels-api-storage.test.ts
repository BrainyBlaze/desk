import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  handleChannelsRequest,
  initChannelsRuntime,
  resetChannelsRuntime
} from '../src/server/channelsApi.js';
import { listPausedSessions } from '../src/server/channelsPaused.js';

interface ApiResult {
  handled: boolean;
  status: number;
  body: any;
}

async function callChannelsApi(method: string, path: string, body?: Record<string, unknown>): Promise<ApiResult> {
  const req = Readable.from(body ? [JSON.stringify(body)] : []) as IncomingMessage;
  req.method = method;
  const chunks: string[] = [];
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (payload?: unknown) => {
      if (payload !== undefined) {
        chunks.push(String(payload));
      }
    }
  } as unknown as ServerResponse;

  const handled = await handleChannelsRequest(req, res, new URL(path, 'http://desk.local'));
  const raw = chunks.join('');
  return { handled, status: res.statusCode, body: raw ? JSON.parse(raw) : undefined };
}

describe('channels storage API endpoints', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-api-storage-'));
    initChannelsRuntime({ home });
  });

  afterEach(() => {
    resetChannelsRuntime();
    rmSync(home, { recursive: true, force: true });
  });

  it('adds, lists, and removes reactions through /api/channels/reactions', async () => {
    const added = await callChannelsApi('POST', '/api/channels/reactions', {
      action: 'add',
      channel: 'ops',
      file: 'root.md',
      id: 'msg-1-aaaa',
      kind: 'ack',
      author: 'human'
    });
    expect(added.status).toBe(200);
    expect(added.body.items).toHaveLength(1);
    expect(added.body.items[0]).toMatchObject({ channel: 'ops', file: 'root.md', id: 'msg-1-aaaa', kind: 'ack', author: 'human' });

    const listed = await callChannelsApi('GET', '/api/channels/reactions');
    expect(listed.body.items).toHaveLength(1);

    const removed = await callChannelsApi('POST', '/api/channels/reactions', {
      action: 'remove',
      channel: 'ops',
      file: 'root.md',
      id: 'msg-1-aaaa',
      kind: 'ack'
    });
    expect(removed.body.items).toEqual([]);
  });

  it('adds, lists, and removes saved views through /api/channels/views', async () => {
    const added = await callChannelsApi('POST', '/api/channels/views', {
      action: 'add',
      name: 'triage',
      filter: { text: '  stuck  ', author: '  ', mentionsMe: false, hasThread: true }
    });
    expect(added.status).toBe(200);
    expect(added.body.items).toHaveLength(1);
    expect(added.body.items[0]).toMatchObject({ name: 'triage', filter: { text: 'stuck', hasThread: true } });

    const listed = await callChannelsApi('GET', '/api/channels/views');
    expect(listed.body.items.map((item: { name: string }) => item.name)).toEqual(['triage']);

    const removed = await callChannelsApi('POST', '/api/channels/views', { action: 'remove', name: 'triage' });
    expect(removed.body.items).toEqual([]);
  });

  it('persists pause/resume actions through both the paused endpoint and engine action endpoint', async () => {
    const paused = await callChannelsApi('POST', '/api/channels/paused', {
      action: 'pause',
      tmuxSession: 'tmux-a',
      reason: ' operator hold '
    });
    expect(paused.status).toBe(200);
    expect(paused.body.items).toHaveLength(1);
    expect(paused.body.items[0]).toMatchObject({ tmuxSession: 'tmux-a', reason: 'operator hold' });
    expect(listPausedSessions(home).map((item) => item.tmuxSession)).toEqual(['tmux-a']);

    const listed = await callChannelsApi('GET', '/api/channels/paused');
    expect(listed.body.items.map((item: { tmuxSession: string }) => item.tmuxSession)).toEqual(['tmux-a']);

    const resumed = await callChannelsApi('POST', '/api/channels/engine/action', {
      action: 'resume-session',
      tmuxSession: 'tmux-a'
    });
    expect(resumed.status).toBe(200);
    expect(listPausedSessions(home)).toEqual([]);

    const pausedViaEngine = await callChannelsApi('POST', '/api/channels/engine/action', {
      action: 'pause-session',
      tmuxSession: 'tmux-b',
      reason: 'api action'
    });
    expect(pausedViaEngine.status).toBe(200);
    expect(listPausedSessions(home).map((item) => item.tmuxSession)).toEqual(['tmux-b']);

    await callChannelsApi('POST', '/api/channels/paused', { action: 'resume', tmuxSession: 'tmux-b' });
    expect(listPausedSessions(home)).toEqual([]);
  });
});
