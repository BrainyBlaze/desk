import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchChannelMessages } from '../src/server/channelsStore.js';
import { formatChannelPreamble, formatMessageBlock } from '../src/server/channelsProtocol.js';

const t1 = '2026-06-18 15:00:00';
const t2 = '2026-06-18 16:00:00';
const t3 = '2026-06-18 17:00:00';

describe('channels cross-channel search', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-search-'));
    seedChannel('ops', [
      formatMessageBlock({ id: 'msg-root-1', author: 'human', timestamp: t1, body: 'Deploy checklist mentions @human' }),
      formatMessageBlock({ id: 'msg-parent', author: 'agent', timestamp: t2, body: 'Incident parent' })
    ]);
    writeFileSync(
      join(home, 'ops', 'thread-msg-parent.md'),
      [
        '# Thread: msg-parent',
        '',
        '## Messages',
        '',
        formatMessageBlock({ id: 'msg-thread-1', author: 'agent', timestamp: t3, body: 'Database outage root cause' })
      ].join('\n')
    );
    seedChannel('design', [
      formatMessageBlock({ id: 'msg-design-1', author: 'human', timestamp: t2, body: 'Search ergonomics and command palette' })
    ]);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function seedChannel(channel: string, blocks: string[]): void {
    const dir = join(home, channel);
    mkdirSync(join(dir, '_members'), { recursive: true });
    mkdirSync(join(dir, '_files'), { recursive: true });
    writeFileSync(join(dir, 'root.md'), [formatChannelPreamble(channel, `${channel} goal`), ...blocks].join('\n'));
  }

  it('searches root and thread files across channels and returns navigation metadata', () => {
    expect(searchChannelMessages(home, { query: 'database', limit: 10 })).toEqual([
      expect.objectContaining({
        channel: 'ops',
        file: 'thread-msg-parent.md',
        threadParent: 'msg-parent',
        messageId: 'msg-thread-1',
        author: 'agent',
        snippet: 'Database outage root cause'
      })
    ]);

    expect(searchChannelMessages(home, { query: 'palette', limit: 10 })).toEqual([
      expect.objectContaining({ channel: 'design', file: 'root.md', messageId: 'msg-design-1', threadParent: undefined })
    ]);
  });

  it('applies channel, author, mentions, thread, date, and limit filters', () => {
    expect(searchChannelMessages(home, { query: '', mentions: 'human', channel: 'ops' }).map((item) => item.messageId)).toEqual([
      'msg-root-1'
    ]);
    expect(searchChannelMessages(home, { query: '', author: 'agent', hasThread: true }).map((item) => item.messageId)).toEqual([
      'msg-thread-1'
    ]);
    expect(searchChannelMessages(home, { query: '', dateFrom: '2026-06-18 16:30:00' }).map((item) => item.messageId)).toEqual([
      'msg-thread-1'
    ]);
    expect(searchChannelMessages(home, { query: '', limit: 2 }).map((item) => item.messageId)).toEqual(['msg-thread-1', 'msg-design-1']);
  });
});
