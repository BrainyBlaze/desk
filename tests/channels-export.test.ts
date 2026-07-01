import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChannel, appendMessage } from '../src/server/channelsStore.js';
import { exportChannelToMarkdown } from '../src/server/channelsExport.js';

describe('channelsExport', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-export-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('exports a channel with goal + members + messages as clean markdown', async () => {
    createChannel(home, 'ops', 'ship the release');
    await appendMessage(home, 'ops', { author: 'human', body: 'hello team' });
    await appendMessage(home, 'ops', { author: 'agent-a', body: 'starting work on **build**' });

    const md = exportChannelToMarkdown(home, 'ops');
    expect(md).toContain('# #ops');
    expect(md).toContain('> ship the release');
    expect(md).toContain('_Exported:');
    expect(md).toContain('**Members**:');
    expect(md).toContain('## @human ·');
    expect(md).toContain('hello team');
    expect(md).toContain('## @agent-a ·');
    expect(md).toContain('starting work on **build**');
    // Protocol markers are stripped.
    expect(md).not.toContain('<!-- END_TURN -->');
    expect(md).not.toContain('### msg-');
  });

  it('exports a thread with parent context + replies', async () => {
    createChannel(home, 'ops', 'goal');
    const parent = await appendMessage(home, 'ops', { author: 'human', body: 'parent message' });
    await appendMessage(home, 'ops', {
      author: 'agent-a',
      body: 'reply in thread',
      threadParentId: parent.message.id
    });

    const md = exportChannelToMarkdown(home, 'ops', parent.message.id);
    expect(md).toContain(`# Thread: ${parent.message.id}`);
    expect(md).toContain('1 replies');
    expect(md).toContain('## @agent-a ·');
    expect(md).toContain('reply in thread');
  });

  it('throws when the channel does not exist', () => {
    expect(() => exportChannelToMarkdown(home, 'nonexistent')).toThrow(/not found/);
  });

  it('throws when the thread does not exist', () => {
    createChannel(home, 'ops', 'goal');
    expect(() => exportChannelToMarkdown(home, 'ops', 'msg-nope')).toThrow(/not found/);
  });
});
