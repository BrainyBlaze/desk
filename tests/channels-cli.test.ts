import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runChannelsCli } from '../src/cli/channelsCli.js';
import { addMember, appendMessage, createChannel, readChannelDetail, resolveChannelsHome } from '../src/server/channelsStore.js';

describe('desk channels CLI', () => {
  let homeRoot: string;
  let output: string[];
  let errors: string[];

  beforeEach(() => {
    homeRoot = mkdtempSync(join(tmpdir(), 'desk-channels-cli-'));
    vi.stubEnv('HOME', homeRoot);
    output = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((line = '') => output.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line = '') => errors.push(String(line)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(homeRoot, { recursive: true, force: true });
  });

  it('reads a single root message by id', async () => {
    const home = resolveChannelsHome();
    createChannel(home, 'ops', 'test channel');
    const first = await appendMessage(home, 'ops', { author: 'human', body: 'first message' });
    const second = await appendMessage(home, 'ops', { author: 'codex', body: 'second message' });

    const code = await runChannelsCli(['read', 'ops', '--message', first.message.id]);

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(output.join('\n')).toContain(`### ${first.message.id}`);
    expect(output.join('\n')).toContain('first message');
    expect(output.join('\n')).not.toContain(second.message.id);
    expect(output.join('\n')).not.toContain('second message');
  });

  it('reads a single thread reply by id', async () => {
    const home = resolveChannelsHome();
    createChannel(home, 'ops', 'test channel');
    const parent = await appendMessage(home, 'ops', { author: 'human', body: 'parent message' });
    const reply = await appendMessage(home, 'ops', { author: 'claude', body: 'thread reply', threadParentId: parent.message.id });

    const code = await runChannelsCli(['read', 'ops', '--message', reply.message.id]);

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(output.join('\n')).toContain(`### ${reply.message.id}`);
    expect(output.join('\n')).toContain('thread reply');
    expect(output.join('\n')).not.toContain(parent.message.id);
    expect(output.join('\n')).not.toContain('parent message');
  });

  it('rejects a non-member --as override when posting through the offline fallback', async () => {
    const home = resolveChannelsHome();
    createChannel(home, 'ops', 'test channel');
    addMember(home, 'ops', { name: 'alpha', type: 'codex', tmuxSession: 'tmux-alpha' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server offline');
    }));

    const code = await runChannelsCli(['post', 'ops', '--as', 'intruder', 'message']);

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('@intruder is not a member of #ops');
    expect(readChannelDetail(home, 'ops').messages).toEqual([]);
  });
});
