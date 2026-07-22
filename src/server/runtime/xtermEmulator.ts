// Real emulator adapter (spec §3.3/§6.8/§7.2/§7.3) — the EmulatorPort backed by
// @xterm/headless (the H10 packaging dep). One headless Terminal per LIVE
// terminal session is the authoritative screen: it renders OUTPUT bytes, exposes
// plain-text rows for the §6.8 classifier, a SerializeAddon restorable string for
// §7.3 snapshots, and semantic events (bell/OSC) via the PUBLIC parser hooks
// (§7.2). scrollback is 0 — history comes from the journal, not per-headless.
//
// xterm's write() is async (parsed on a microtask), so reads that must reflect a
// just-written chunk should await flush().

import { createRequire } from 'node:module';
import type { Terminal as XtermTerminal } from '@xterm/headless';
import type { SerializeAddon as XtermSerializeAddon } from '@xterm/addon-serialize';
import { type EmulatorEvent, type EmulatorFactory, type EmulatorPort } from '../../shared/runtime/emulatorPort.js';

// Both @xterm packages are CommonJS; a named ESM import works under
// vite/vitest interop but FAILS under plain node running the tsc-emitted ESM
// ("does not provide an export named 'Terminal'") — which is exactly how the
// supervised `desk terminal-daemon` child runs in production. createRequire
// side-steps the interop entirely; types stay via import type.
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as { Terminal: typeof XtermTerminal };
const { SerializeAddon } = require('@xterm/addon-serialize') as { SerializeAddon: typeof XtermSerializeAddon };

export class XtermEmulator implements EmulatorPort {
  private readonly term: XtermTerminal;
  private readonly serializer: XtermSerializeAddon;
  private listeners: ((e: EmulatorEvent) => void)[] = [];

  constructor(opts: { rows: number; cols: number }) {
    this.term = new Terminal({ rows: opts.rows, cols: opts.cols, scrollback: 0, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
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

  serialize(): string {
    return this.serializer.serialize();
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
