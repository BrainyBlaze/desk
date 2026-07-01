import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addFeatured, listFeaturedItems, listFeaturedRefs, removeFeatured } from '../src/server/channelsFeatured.js';
import { formatChannelPreamble, formatMessageBlock } from '../src/server/channelsProtocol.js';

const timestamp = '2026-06-18 16:50:00';

describe('channels featured messages', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-featured-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function seedChannel(): void {
    const dir = join(home, 'ops');
    mkdirSync(join(dir, '_members'), { recursive: true });
    mkdirSync(join(dir, '_files'), { recursive: true });
    writeFileSync(
      join(dir, 'root.md'),
      [
        formatChannelPreamble('ops', 'operations'),
        formatMessageBlock({ id: 'msg-same', author: 'human', timestamp, body: 'root saved message' }),
        formatMessageBlock({ id: 'msg-parent', author: 'human', timestamp, body: 'thread parent' })
      ].join('\n')
    );
    writeFileSync(
      join(dir, 'thread-msg-parent.md'),
      [
        '# Thread: msg-parent',
        '',
        '## Messages',
        '',
        formatMessageBlock({ id: 'msg-same', author: 'agent', timestamp, body: 'thread saved message' })
      ].join('\n')
    );
  }

  it('stores featured references by channel+file+id so root and thread ids cannot collapse', () => {
    seedChannel();

    addFeatured(home, { channel: 'ops', file: 'root.md', id: 'msg-same', note: 'root' }, new Date('2026-06-18T16:51:00Z'));
    addFeatured(
      home,
      { channel: 'ops', file: 'thread-msg-parent.md', id: 'msg-same', tag: 'thread' },
      new Date('2026-06-18T16:52:00Z')
    );
    addFeatured(home, { channel: 'ops', file: 'root.md', id: 'msg-same', note: 'updated root' }, new Date('2026-06-18T16:53:00Z'));

    expect(listFeaturedRefs(home).map((item) => [item.channel, item.file, item.id, item.note, item.tag])).toEqual([
      ['ops', 'root.md', 'msg-same', 'updated root', undefined],
      ['ops', 'thread-msg-parent.md', 'msg-same', undefined, 'thread']
    ]);

    const raw = JSON.parse(readFileSync(join(home, 'featured.json'), 'utf8')) as { version: number; items: unknown[] };
    expect(raw.version).toBe(1);
    expect(raw.items).toHaveLength(2);
  });

  it('resolves featured rows from live channel files without storing snippets in featured.json', () => {
    seedChannel();
    addFeatured(home, { channel: 'ops', file: 'thread-msg-parent.md', id: 'msg-same' }, new Date('2026-06-18T16:52:00Z'));

    expect(listFeaturedItems(home)).toEqual([
      expect.objectContaining({
        channel: 'ops',
        file: 'thread-msg-parent.md',
        id: 'msg-same',
        threadParent: 'msg-parent',
        author: 'agent',
        snippet: 'thread saved message',
        missing: false
      })
    ]);

    expect(removeFeatured(home, { channel: 'ops', file: 'thread-msg-parent.md', id: 'msg-same' })).toBe(true);
    expect(listFeaturedItems(home)).toEqual([]);
  });
});
