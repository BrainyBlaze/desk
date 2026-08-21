// Emulator port (spec §3.3/§6.8/§7.2/§7.3). The narrow interface the daemon
// needs from the authoritative headless terminal, so the daemon + control-plane
// wiring are testable against a fake and the real @xterm/headless adapter is a
// thin, swappable shim added with the H10 packaging dep. Pure interface — no
// @xterm import here (that lives in the daemon-side adapter).
//
// Real adapter mapping (server-side, when @xterm/headless lands):
//   write(b)          → terminal.write(b)
//   resize(r,c)       → terminal.resize(c, r)
//   readTailText(n)   → iterate terminal.buffer.active.getLine(i).translateToString()
//                       over the last n rows (plain text for capture and delivery
//                       verification, never semantic agent-state inference)
//   onBell/onOsc/...  → terminal.onBell / terminal.parser.registerOscHandler(code,…)
//                       / registerCsiHandler(…) (PUBLIC hooks only, §7.2)

/** A semantic event the emulator's public parser hooks surface (§6.6/§7.2). */
export interface EmulatorEvent {
  kind: 'bell' | 'osc' | 'title' | 'link' | 'query';
  /** OSC code for kind 'osc', or a query-class hint for kind 'query'. */
  code?: number;
  /** Raw payload (OSC body, title text, link, or the query bytes). */
  data?: string;
}

/**
 * The authoritative headless emulator, as the daemon uses it. One instance per
 * LIVE terminal session (§3.3). Its bounded scrollback is the ranged-history
 * authority, while browser baselines may request only the current screen.
 */
export interface EmulatorPort {
  /** Feed raw output bytes from the master (binary end-to-end, §7.8). */
  write(bytes: Uint8Array): void;
  /**
   * Await pending parser work when the adapter parses writes asynchronously.
   * Attach-time terminal state must drain before input delivery can inspect it;
   * output must drain before the holder receives its consumption watermark.
   */
  flush?(): Promise<void>;
  /** Apply a geometry change (rows × cols). */
  resize(rows: number, cols: number): void;
  /** The last `rows` on-screen lines as plain text. Never escape sequences. */
  readTailText(rows: number): string[];
  /**
   * Ranged plain-text history (screen + scrollback): `offset` lines back from
   * the live edge, `rows` per page, clamped at the top (beyond-top reads
   * yield []). Optional so minimal fakes stay minimal — absent means the
   * emulator retains no history beyond the live tail.
   */
  readHistoryText?(rows: number, offset: number): { lines: string[]; totalAvailable: number };
  /** Current cursor position (for CPR/DSR worker replies, §7.7). */
  cursor(): { row: number; col: number };
  /**
   * Whether the app enabled bracketed-paste mode (DECSET 2004). Optional so
   * test fakes stay minimal; absent reads as false. Channels delivery uses it
   * to mirror legacy bracketed-paste staging (wrap pasted text only when asked for).
   */
  bracketedPaste?(): boolean;
  /** Subscribe to semantic parser events (§6.6). Returns an unsubscribe fn. */
  onEvent(cb: (event: EmulatorEvent) => void): () => void;
  /** Tear down the emulator (session ended / worker recycle). */
  dispose(): void;
}

/** Factory the daemon injects; the real one builds an @xterm/headless Terminal. */
export interface EmulatorFactory {
  create(opts: { rows: number; cols: number }): EmulatorPort;
}
