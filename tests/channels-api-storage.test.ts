import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleChannelsRequest,
  initChannelsRuntime,
  resetChannelsRuntime
} from '../src/server/channelsApi.js';
import { listPausedSessions } from '../src/server/channelsPaused.js';
import { appendMessage, createChannel, editMessage } from '../src/server/channelsStore.js';
import { startChannelsOwner } from './helpers/channels-owner-process.js';

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
    vi.stubEnv('HOME', home);
    const manifestDir = join(home, '.config', 'desk');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'desk.yml'), 'groups: []\n');
    initChannelsRuntime({ home });
  });

  afterEach(() => {
    resetChannelsRuntime();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
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

  it('exposes the same content revision from state summaries and channel details', async () => {
    createChannel(home, 'ops', 'goal');
    const first = await appendMessage(home, 'ops', { author: 'human', body: 'first' });

    const state = await callChannelsApi('GET', '/api/channels/state');
    const detail = await callChannelsApi('GET', '/api/channels/channel?name=ops');
    const revision = state.body.channels[0].contentRevision;
    expect(revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(detail.body.contentRevision).toBe(revision);

    await editMessage(home, 'ops', 'root.md', first.message.id, 'changed');
    const changedState = await callChannelsApi('GET', '/api/channels/state');
    const changedDetail = await callChannelsApi('GET', '/api/channels/channel?name=ops');
    expect(changedState.body.channels[0].contentRevision).not.toBe(revision);
    expect(changedDetail.body.contentRevision).toBe(changedState.body.channels[0].contentRevision);
  });

  it.runIf(process.platform === 'linux')(
    'exposes a bounded identity diagnostic while the engine remains active',
    async () => {
      resetChannelsRuntime();
      rmSync(join(home, '_engine', 'engine.pid'), { force: true });
      const originalReadFileSync = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation(((path, options) => {
        if (path === `/proc/${process.pid}/stat`) {
          throw Object.assign(new Error('sensitive proc failure'), { code: 'EIO' });
        }
        return originalReadFileSync(path, options as never);
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();
      initChannelsRuntime({ home });

      const state = await callChannelsApi('GET', '/api/channels/state');
      const diagnostics = await callChannelsApi('GET', '/api/channels/engine');
      expect(state.body).toMatchObject({
        passive: false,
        lockError: 'channels engine ownership: process identity read failed (EIO)'
      });
      expect(diagnostics.body).toMatchObject({
        passive: false,
        lockError: 'channels engine ownership: process identity read failed (EIO)'
      });
    }
  );

  it.runIf(process.platform === 'linux')(
    'refuses a post before append when another live process owns delivery',
    async () => {
      resetChannelsRuntime();
      rmSync(join(home, '_engine', 'engine.pid'), { force: true });
      createChannel(home, 'ops', 'goal');
      const owner = startChannelsOwner(home);
      try {
        const witness = await owner.ready;
        const runtime = initChannelsRuntime({ home });
        expect(runtime.engine.passive).toBe(true);
        expect(runtime.engine.passiveOwnerPid).toBe(witness.pid);

        const posted = await callChannelsApi('POST', '/api/channels/post', {
          channel: 'ops',
          body: 'must not be acknowledged without a delivery owner'
        });
        expect(posted.status).toBe(503);
        expect(posted.body).toMatchObject({
          ok: false,
          passive: true,
          passiveOwner: witness.pid
        });
        expect(posted.body.error).toMatch(/passive/i);

        const detail = await callChannelsApi('GET', '/api/channels/channel?name=ops');
        expect(detail.body.messages).toEqual([]);
      } finally {
        await owner.release();
      }
    },
    20_000
  );

  it('persists pause/resume actions through both the paused endpoint and engine action endpoint', async () => {
    const paused = await callChannelsApi('POST', '/api/channels/paused', {
      action: 'pause',
      sessionId: 'tmux-a',
      reason: ' operator hold '
    });
    expect(paused.status).toBe(200);
    expect(paused.body.items).toHaveLength(1);
    expect(paused.body.items[0]).toMatchObject({ sessionId: 'tmux-a', reason: 'operator hold' });
    expect(listPausedSessions(home).map((item) => item.sessionId)).toEqual(['tmux-a']);

    const listed = await callChannelsApi('GET', '/api/channels/paused');
    expect(listed.body.items.map((item: { sessionId: string }) => item.sessionId)).toEqual(['tmux-a']);

    const resumed = await callChannelsApi('POST', '/api/channels/engine/action', {
      action: 'resume-session',
      sessionId: 'tmux-a'
    });
    expect(resumed.status).toBe(200);
    expect(listPausedSessions(home)).toEqual([]);

    const pausedViaEngine = await callChannelsApi('POST', '/api/channels/engine/action', {
      action: 'pause-session',
      sessionId: 'tmux-b',
      reason: 'api action'
    });
    expect(pausedViaEngine.status).toBe(200);
    expect(listPausedSessions(home).map((item) => item.sessionId)).toEqual(['tmux-b']);

    await callChannelsApi('POST', '/api/channels/paused', { action: 'resume', sessionId: 'tmux-b' });
    expect(listPausedSessions(home)).toEqual([]);
  });
});
