// Real @xterm/headless emulator adapter (spec §3.3/§6.8/§7.2/§7.3). Proves the
// authoritative worker renders OUTPUT, exposes plain-text rows for the classifier,
// serializes a restorable snapshot, tracks the cursor, resizes, and surfaces
// semantic events — all headless in Node.

import { describe, expect, it } from 'vitest';
import { XtermEmulator, XtermEmulatorFactory } from '../src/server/runtime/xtermEmulator.js';
import { type EmulatorEvent } from '../src/shared/runtime/index.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('xterm emulator adapter (§3.3/§7.3)', () => {
  it('renders output to plain-text rows (§6.8 classifier feed)', async () => {
    const e = new XtermEmulator({ rows: 10, cols: 40 });
    e.write(enc('hello \x1b[31mred\x1b[0m world'));
    await e.flush();
    const rows = e.readTailText(10);
    expect(rows[0]).toContain('hello red world'); // plain text, escape codes stripped
    e.dispose();
  });

  it('tracks the cursor position', async () => {
    const e = new XtermEmulator({ rows: 10, cols: 40 });
    e.write(enc('abc'));
    await e.flush();
    expect(e.cursor()).toEqual({ row: 0, col: 3 });
    e.write(enc('\r\nxy'));
    await e.flush();
    expect(e.cursor()).toEqual({ row: 1, col: 2 });
    e.dispose();
  });

  it('serializes a non-empty restorable snapshot that carries the content', async () => {
    const e = new XtermEmulator({ rows: 6, cols: 20 });
    e.write(enc('line1\r\nline2'));
    await e.flush();
    const snap = e.serialize();
    expect(snap.length).toBeGreaterThan(0);
    expect(snap).toContain('line1');
    expect(snap).toContain('line2');
    e.dispose();
  });

  it('a snapshot restores into a fresh emulator to the same screen text', async () => {
    const a = new XtermEmulator({ rows: 6, cols: 20 });
    a.write(enc('restore-me\r\nsecond'));
    await a.flush();
    const snap = a.serialize();

    const b = new XtermEmulator({ rows: 6, cols: 20 });
    b.write(enc(snap)); // apply the serialized restore string
    await b.flush();
    expect(b.readTailText(6).join('\n')).toContain('restore-me');
    expect(b.readTailText(6).join('\n')).toContain('second');
    a.dispose();
    b.dispose();
  });

  it('resizes (rows × cols)', async () => {
    const e = new XtermEmulator({ rows: 10, cols: 40 });
    e.resize(24, 80);
    e.write(enc('x'));
    await e.flush();
    // readTailText returns the BOTTOM rows (where a prompt/spinner sits); the
    // written 'x' is on row 0, so read the full screen to find it.
    expect(e.readTailText(24).join('\n')).toContain('x');
    e.dispose();
  });

  it('surfaces semantic events via public parser hooks (§7.2)', async () => {
    const e = new XtermEmulator({ rows: 6, cols: 20 });
    const events: EmulatorEvent[] = [];
    e.onEvent((ev) => events.push(ev));
    e.write(enc('\x1b]0;my title\x07')); // OSC 0 set title
    e.write(enc('\x1b]9;attention\x07')); // OSC 9 attention
    e.write(enc('\x07')); // BEL
    await e.flush();
    expect(events.some((ev) => ev.kind === 'title' && ev.data === 'my title')).toBe(true);
    expect(events.some((ev) => ev.kind === 'osc' && ev.code === 9)).toBe(true);
    expect(events.some((ev) => ev.kind === 'bell')).toBe(true);
    e.dispose();
  });

  it('the factory creates working emulators', async () => {
    const e = new XtermEmulatorFactory().create({ rows: 5, cols: 10 });
    e.write(enc('hi'));
    // EmulatorPort has no flush; the daemon reads on a later cycle, but here we
    // can still read after a microtask.
    await new Promise((r) => setTimeout(r, 20));
    expect(e.readTailText(5).join('\n')).toContain('hi');
    e.dispose();
  });
});
