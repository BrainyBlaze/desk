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
//                       over the last n rows (PLAIN text for the §6.8 classifier —
//                       NOT SerializeAddon output, which returns escape sequences)
//   serialize()       → SerializeAddon.serialize() (restorable display string, §7.3)
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
 * LIVE terminal session (§3.3). Scrollback is 0 (history comes from the journal),
 * so `readTailText` reflects only the on-screen rows.
 */
export interface EmulatorPort {
  /** Feed raw output bytes from the master (binary end-to-end, §7.8). */
  write(bytes: Uint8Array): void;
  /** Apply a geometry change (rows × cols). */
  resize(rows: number, cols: number): void;
  /**
   * The last `rows` on-screen lines as PLAIN text (translateToString), for the
   * degraded worker-rendered classifier (§6.8). Never escape sequences.
   */
  readTailText(rows: number): string[];
  /** A restorable display snapshot string (SerializeAddon, §7.3). */
  serialize(): string;
  /** Current cursor position (for CPR/DSR worker replies, §7.7). */
  cursor(): { row: number; col: number };
  /** Subscribe to semantic parser events (§6.6). Returns an unsubscribe fn. */
  onEvent(cb: (event: EmulatorEvent) => void): () => void;
  /** Tear down the emulator (session ended / worker recycle). */
  dispose(): void;
}

/** Factory the daemon injects; the real one builds an @xterm/headless Terminal. */
export interface EmulatorFactory {
  create(opts: { rows: number; cols: number }): EmulatorPort;
}
