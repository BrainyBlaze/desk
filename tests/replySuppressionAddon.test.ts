// Browser reply-suppression addon conformance (spec §7.7). Uses @xterm/headless
// (its common InputHandler generates DA/DSR/CPR replies via onData, exactly like
// the browser build) to prove the addon suppresses those replies while leaving
// non-query sequences untouched.

import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { ReplySuppressionAddon } from '../src/web/replySuppressionAddon.js';

const wait = () => new Promise<void>((r) => setTimeout(r, 15));

/** Capture everything the terminal would send back to the app (its replies). */
function capture(term: Terminal): () => string {
  let out = '';
  term.onData((d) => (out += d));
  return () => out;
}

describe('reply-suppression addon (§7.7)', () => {
  it('WITHOUT the addon, the terminal replies to DA1', async () => {
    const t = new Terminal({ rows: 10, cols: 40, allowProposedApi: true });
    const replies = capture(t);
    t.write('\x1b[c'); // DA1
    await wait();
    expect(replies().length).toBeGreaterThan(0); // baseline: xterm auto-replies
    t.dispose();
  });

  it('WITH the addon, DA1 / DA2 / DSR / CPR replies are suppressed', async () => {
    const t = new Terminal({ rows: 10, cols: 40, allowProposedApi: true });
    const addon = new ReplySuppressionAddon();
    addon.activate(t);
    const replies = capture(t);
    t.write('\x1b[c'); // DA1
    t.write('\x1b[>c'); // DA2
    t.write('\x1b[5n'); // DSR status
    t.write('\x1b[6n'); // CPR
    await wait();
    expect(replies()).toBe(''); // every query reply suppressed
    addon.dispose();
    t.dispose();
  });

  it('a non-query sequence is NOT suppressed (cursor still moves)', async () => {
    const t = new Terminal({ rows: 10, cols: 40, allowProposedApi: true });
    const addon = new ReplySuppressionAddon();
    addon.activate(t);
    t.write('abc'); // cursor at col 3
    t.write('\x1b[2D'); // cursor back 2 (CSI D — not intercepted)
    await wait();
    expect(t.buffer.active.cursorX).toBe(1); // 3 - 2, the move applied
    addon.dispose();
    t.dispose();
  });

  it('dispose() removes the handlers — DA1 replies again', async () => {
    const t = new Terminal({ rows: 10, cols: 40, allowProposedApi: true });
    const addon = new ReplySuppressionAddon();
    addon.activate(t);
    addon.dispose();
    const replies = capture(t);
    t.write('\x1b[c');
    await wait();
    expect(replies().length).toBeGreaterThan(0); // suppression removed
    t.dispose();
  });
});
