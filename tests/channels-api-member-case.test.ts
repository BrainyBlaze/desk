// Member-name lookups through the HTTP surface are case-insensitive, like
// mention resolution has always been. Before this, `--as Scout` for a member
// manifested as `scout` was refused as a non-member, and a member-role read
// with the wrong casing 404ed — the same casing mismatch the router layer
// already tolerates. The author line, meanwhile, must come out in the
// MANIFEST's casing, so a differently-cased `--as` cannot mint a second
// casing of the same member into the conversation.

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleChannelsRequest, initChannelsRuntime, resetChannelsRuntime } from '../src/server/channels/api.js';
import { addMemberWithUniqueHandle, createChannel, readChannelMessage } from '../src/server/channels/store/fileStore.js';

describe('member-name casing through the channels API', () => {
  let home: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'desk-api-case-'));
    createChannel(home, 'ops', 'goal');
    addMemberWithUniqueHandle(home, 'ops', 'scout', { type: 'codex-cli', sessionId: 'sess-scout' });
    initChannelsRuntime({ home });
    server = createServer((req, res) => {
      void handleChannelsRequest(req, res, new URL(req.url ?? '/', 'http://localhost')).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end('{}');
        }
      });
    });
    base = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetChannelsRuntime();
    rmSync(home, { recursive: true, force: true });
  });

  it('accepts --as in any casing and writes the author in the manifest casing', async () => {
    const response = await fetch(`${base}/api/channels/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'ops', as: 'Scout', body: 'reporting in' })
    });
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };
    expect(readChannelMessage(home, 'ops', id).author).toBe('scout');
  });

  it('finds a member role read regardless of casing', async () => {
    const response = await fetch(`${base}/api/channels/member-role?channel=ops&member=Scout`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('still refuses a genuine stranger', async () => {
    const response = await fetch(`${base}/api/channels/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'ops', as: 'nobody', body: 'should fail' })
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
