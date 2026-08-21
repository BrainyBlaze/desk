// Real emulator adapter (spec §3.3/§6.8/§7.2/§7.3) — the EmulatorPort backed by
// @xterm/headless (the H10 packaging dep). One headless Terminal per LIVE
// terminal session is the authoritative screen: it renders OUTPUT bytes, exposes
// plain-text rows for the §6.8 classifier, a SerializeAddon restorable string for
// §7.3 snapshots, and semantic events (bell/OSC) via the PUBLIC parser hooks
// (§7.2). scrollback is SCROLLBACK_LINES — the emulator IS the history
// authority for the frozen-scrollback UX (/control/tail ranged reads); there
// is no journal-replay path.
//
// xterm's write() is async (parsed on a microtask), so reads that must reflect a
// just-written chunk should await flush().

import { createRequire } from 'node:module';
import type { Terminal as XtermTerminal } from '@xterm/headless';
import {
  type EmulatorEvent,
  type EmulatorFactory,
  type EmulatorPort
} from '../../shared/runtime/emulatorPort.js';

/**
 * Retained history bound per session (screen rows + scrollback). Matches the
 * capture window the web's frozen-scrollback UX was built for.
 */
export const SCROLLBACK_LINES = 2000;

// Both @xterm packages are CommonJS; a named ESM import works under
// vite/vitest interop but FAILS under plain node running the tsc-emitted ESM
// ("does not provide an export named 'Terminal'") — which is exactly how the
// supervised `desk terminal-daemon` child runs in production. createRequire
// side-steps the interop entirely; types stay via import type.
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as { Terminal: typeof XtermTerminal };

export class XtermEmulator implements EmulatorPort {
  private readonly term: XtermTerminal;
  private listeners: ((e: EmulatorEvent) => void)[] = [];

  constructor(opts: { rows: number; cols: number }) {
    this.term = new Terminal({ rows: opts.rows, cols: opts.cols, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    // Semantic events via PUBLIC hooks (§7.2). OSC handlers return false so the
    // emulator ALSO applies them (observe, do not suppress) — suppression is the
    // browser addon's job (§7.7), not the authoritative worker's.
    this.term.onBell(() => this.emit({ kind: 'bell' }));
    this.term.parser.registerOscHandler(0, (data: string) => (this.emit({ kind: 'title', data }), false));
    this.term.parser.registerOscHandler(8, (data: string) => (this.emit({ kind: 'link', data }), false));
    this.term.parser.registerOscHandler(9, (data: string) => (this.emit({ kind: 'osc', code: 9, data }), false));
  }

  write(bytes: Uint8Array): void {
    this.term.write(bytes);
  }

  /** Await the parser draining all pending writes (read-after-write correctness). */
  flush(): Promise<void> {
    return new Promise((resolve) => this.term.write('', () => resolve()));
  }

  resize(rows: number, cols: number): void {
    this.term.resize(cols, rows); // xterm takes (cols, rows)
  }

  readTailText(rows: number): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    const start = Math.max(0, buf.length - rows);
    for (let i = start; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '');
    return out;
  }

  /**
   * A ranged plain-text window into screen + scrollback. `offset` counts lines
   * back from the live edge (0 = the current tail — identical to
   * readTailText); the window is [end - rows, end) with end = total - offset,
   * clamped at the top, so an offset at or beyond the top yields [] and the
   * caller pages by offset until it does. `totalAvailable` is the lines the
   * emulator currently retains (bounded by SCROLLBACK_LINES + screen rows).
   */
  readHistoryText(rows: number, offset: number): { lines: string[]; totalAvailable: number } {
    const buf = this.term.buffer.active;
    const totalAvailable = buf.length;
    const end = Math.max(0, totalAvailable - Math.max(0, offset));
    const start = Math.max(0, end - Math.max(0, rows));
    const lines: string[] = [];
    for (let i = start; i < end; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return { lines, totalAvailable };
  }

  cursor(): { row: number; col: number } {
    const buf = this.term.buffer.active;
    return { row: buf.cursorY, col: buf.cursorX };
  }

  bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  onEvent(cb: (event: EmulatorEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  dispose(): void {
    this.term.dispose();
  }

  private emit(e: EmulatorEvent): void {
    for (const l of this.listeners) l(e);
  }
}

/** The real EmulatorFactory the daemon injects in production. */
export class XtermEmulatorFactory implements EmulatorFactory {
  create(opts: { rows: number; cols: number }): EmulatorPort {
    return new XtermEmulator(opts);
  }
}
