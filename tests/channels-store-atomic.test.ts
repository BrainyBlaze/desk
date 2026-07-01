import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatChannelPreamble, formatMessageBlock } from '../src/server/channelsProtocol.js';

const timestamp = '2026-06-18 16:00:00';
const partial = 'PARTIAL_WRITE_BEFORE_CRASH';

describe('channels store atomic conversation writes', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-chan-atomic-'));
    vi.resetModules();
    vi.doUnmock('node:fs');
  });

  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
    rmSync(home, { recursive: true, force: true });
  });

  const seedChannel = (): { rootFile: string; rootContent: string; threadFile: string } => {
    const dir = join(home, 'ops');
    mkdirSync(join(dir, '_members'), { recursive: true });
    mkdirSync(join(dir, '_files'), { recursive: true });
    const rootFile = join(dir, 'root.md');
    const threadFile = join(dir, 'thread-msg-parent.md');
    const rootContent = [
      formatChannelPreamble('ops', 'old goal'),
      formatMessageBlock({ id: 'msg-parent', author: 'human', timestamp, body: 'original body' })
    ].join('\n');
    writeFileSync(rootFile, rootContent);
    return { rootFile, rootContent, threadFile };
  };

  const seedThread = (threadFile: string): string => {
    const threadContent = [
      '# Thread: msg-parent',
      '',
      '> Original message by **@human** in [#ops root](root.md):',
      '> original body',
      '',
      '## Messages',
      '',
      formatMessageBlock({ id: 'msg-reply', author: 'agent', timestamp, body: 'existing reply' })
    ].join('\n');
    writeFileSync(threadFile, threadContent);
    return threadContent;
  };

  const crashOnWrite = (shouldCrash: (path: string, content: string) => boolean): void => {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        writeFileSync: ((path: Parameters<typeof actual.writeFileSync>[0], data: Parameters<typeof actual.writeFileSync>[1]) => {
          const target = String(path);
          const content = typeof data === 'string' || Buffer.isBuffer(data) ? data.toString() : '';
          if (shouldCrash(target, content)) {
            actual.writeFileSync(path, partial);
            throw new Error('simulated write crash');
          }
          actual.writeFileSync(path, data);
        }) as typeof actual.writeFileSync
      };
    });
  };

  const crashOnAppend = (shouldCrash: (path: string, content: string) => boolean): void => {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      const maybeCrash = (path: Parameters<typeof actual.writeFileSync>[0], data: Parameters<typeof actual.writeFileSync>[1]): boolean => {
        const target = String(path);
        const content = typeof data === 'string' || Buffer.isBuffer(data) ? data.toString() : '';
        if (shouldCrash(target, content)) {
          return true;
        }
        return false;
      };
      return {
        ...actual,
        writeFileSync: ((path: Parameters<typeof actual.writeFileSync>[0], data: Parameters<typeof actual.writeFileSync>[1]) => {
          if (maybeCrash(path, data)) {
            actual.writeFileSync(path, partial);
            throw new Error('simulated append crash');
          }
          actual.writeFileSync(path, data);
        }) as typeof actual.writeFileSync,
        appendFileSync: ((path: Parameters<typeof actual.appendFileSync>[0], data: Parameters<typeof actual.appendFileSync>[1]) => {
          if (maybeCrash(path, data)) {
            actual.appendFileSync(path, partial);
            throw new Error('simulated append crash');
          }
          actual.appendFileSync(path, data);
        }) as typeof actual.appendFileSync
      };
    });
  };

  it('does not expose a partially-created channel when human manifest creation crashes', async () => {
    crashOnWrite((path) => path.includes('/_members/') && path.includes('human.md'));
    const { createChannel, listChannels } = await import('../src/server/channelsStore.js');

    expect(() => createChannel(home, 'ops', 'new channel')).toThrow(/simulated write crash/);

    expect(existsSync(join(home, 'ops'))).toBe(false);
    expect(listChannels(home)).toEqual([]);
  });

  it('does not leave a partial uploaded file when a binary write crashes', async () => {
    const { createChannel } = await import('../src/server/channelsStore.js');
    createChannel(home, 'ops', 'uploads');
    vi.doUnmock('node:fs');
    vi.resetModules();
    crashOnWrite((path, content) => path.includes('/_files/') && path.includes('payload.bin') && content.includes('binary payload'));
    const { saveChannelFile } = await import('../src/server/channelsStore.js');

    expect(() => saveChannelFile(home, 'ops', 'payload.bin', Buffer.from('binary payload'))).toThrow(/simulated write crash/);

    expect(existsSync(join(home, 'ops', '_files', 'payload.bin'))).toBe(false);
  });

  it('retries upload names when the chosen target appears before the atomic create', async () => {
    const { createChannel } = await import('../src/server/channelsStore.js');
    createChannel(home, 'ops', 'uploads');
    vi.doUnmock('node:fs');
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      let raced = false;
      return {
        ...actual,
        linkSync: ((existingPath: Parameters<typeof actual.linkSync>[0], newPath: Parameters<typeof actual.linkSync>[1]) => {
          const target = String(newPath);
          if (!raced && target.endsWith('/_files/race.txt')) {
            raced = true;
            actual.writeFileSync(newPath, 'other writer');
            const err = new Error('simulated concurrent create') as NodeJS.ErrnoException;
            err.code = 'EEXIST';
            throw err;
          }
          actual.linkSync(existingPath, newPath);
        }) as typeof actual.linkSync,
        writeFileSync: ((path: Parameters<typeof actual.writeFileSync>[0], data: Parameters<typeof actual.writeFileSync>[1]) => {
          const target = String(path);
          if (!raced && target.endsWith('/_files/race.txt')) {
            raced = true;
            actual.writeFileSync(path, 'other writer');
            const err = new Error('simulated concurrent create') as NodeJS.ErrnoException;
            err.code = 'EEXIST';
            throw err;
          }
          actual.writeFileSync(path, data);
        }) as typeof actual.writeFileSync
      };
    });
    const { saveChannelFile } = await import('../src/server/channelsStore.js');

    const saved = saveChannelFile(home, 'ops', 'race.txt', Buffer.from('ours'));

    expect(saved).toBe('race-1.txt');
    expect(readFileSync(join(home, 'ops', '_files', 'race.txt'), 'utf8')).toBe('other writer');
    expect(readFileSync(join(home, 'ops', '_files', 'race-1.txt'), 'utf8')).toBe('ours');
  });

  it('serializes concurrent same-base member handle allocation under the channel lock instead of throwing', async () => {
    const { createChannel, addMemberWithUniqueHandle, listChannelMembers } = await import('../src/server/channelsStore.js');
    createChannel(home, 'ops', 'members');

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => addMemberWithUniqueHandle(home, 'ops', 'agent', { type: 'claude-code', tmuxSession: 'tmux-a' })),
      Promise.resolve().then(() => addMemberWithUniqueHandle(home, 'ops', 'agent', { type: 'claude-code', tmuxSession: 'tmux-b' }))
    ]);

    expect([first.name, second.name]).toEqual(['agent', 'agent-2']);
    expect(listChannelMembers(home, 'ops').map((member) => member.name)).toEqual(['agent', 'agent-2', 'human']);
  });

  it('preserves root.md when editChannelGoal crashes during replacement', async () => {
    const { rootFile, rootContent } = seedChannel();
    crashOnWrite((_path, content) => content.includes('new goal'));
    const { editChannelGoal } = await import('../src/server/channelsStore.js');

    expect(() => editChannelGoal(home, 'ops', 'new goal')).toThrow(/simulated write crash/);

    expect(readFileSync(rootFile, 'utf8')).toBe(rootContent);
  });

  it('does not leave a partial thread file when thread preamble creation crashes', async () => {
    const { threadFile } = seedChannel();
    crashOnWrite((_path, content) => content.startsWith('# Thread: msg-parent'));
    const { appendMessage } = await import('../src/server/channelsStore.js');

    await expect(appendMessage(home, 'ops', { author: 'agent', body: 'reply', threadParentId: 'msg-parent' })).rejects.toThrow(
      /simulated write crash/
    );

    expect(existsSync(threadFile)).toBe(false);
  });

  it('preserves root.md when parent thread-link refresh crashes', async () => {
    const { rootFile, rootContent, threadFile } = seedChannel();
    seedThread(threadFile);
    crashOnWrite((_path, content) => content.includes('**thread**:'));
    const { appendMessage } = await import('../src/server/channelsStore.js');

    await expect(appendMessage(home, 'ops', { author: 'agent', body: 'new reply', threadParentId: 'msg-parent' })).rejects.toThrow(
      /simulated write crash/
    );

    expect(readFileSync(rootFile, 'utf8')).toBe(rootContent);
  });

  it('preserves root.md when a root message append crashes', async () => {
    const { rootFile, rootContent } = seedChannel();
    crashOnAppend((_path, content) => content.includes('new root message'));
    const { appendMessage } = await import('../src/server/channelsStore.js');

    await expect(appendMessage(home, 'ops', { author: 'agent', body: 'new root message' })).rejects.toThrow(
      /simulated append crash/
    );

    expect(readFileSync(rootFile, 'utf8')).toBe(rootContent);
  });

  it('preserves an existing thread when a thread reply append crashes', async () => {
    const { threadFile } = seedChannel();
    const threadContent = seedThread(threadFile);
    crashOnAppend((_path, content) => content.includes('new thread reply'));
    const { appendMessage } = await import('../src/server/channelsStore.js');

    await expect(appendMessage(home, 'ops', { author: 'agent', body: 'new thread reply', threadParentId: 'msg-parent' })).rejects.toThrow(
      /simulated append crash/
    );

    expect(readFileSync(threadFile, 'utf8')).toBe(threadContent);
  });

  it('preserves root.md when editMessage crashes during replacement', async () => {
    const { rootFile, rootContent } = seedChannel();
    crashOnWrite((_path, content) => content.includes('edited body'));
    const { editMessage } = await import('../src/server/channelsStore.js');

    await expect(editMessage(home, 'ops', 'root.md', 'msg-parent', 'edited body')).rejects.toThrow(/simulated write crash/);

    expect(readFileSync(rootFile, 'utf8')).toBe(rootContent);
  });

  it('preserves root.md when deleteMessage crashes during replacement', async () => {
    const { rootFile, rootContent } = seedChannel();
    crashOnWrite((_path, content) => content.startsWith('# ops') && !content.includes('msg-parent'));
    const { deleteMessage } = await import('../src/server/channelsStore.js');

    await expect(deleteMessage(home, 'ops', 'root.md', 'msg-parent')).rejects.toThrow(/simulated write crash/);

    expect(readFileSync(rootFile, 'utf8')).toBe(rootContent);
  });
});
