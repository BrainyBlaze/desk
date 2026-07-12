/**
 * Incremental terminal control-sequence tokenizer.
 *
 * Terminal output arrives in arbitrary chunks (a pty read, a WebSocket frame),
 * so an escape sequence can be split across two chunks. The chunk-local regexes
 * Desk used for attention (OSC 9 / BEL) and mouse-mode stripping (DECSET) got
 * this wrong: a split `ESC ] 9 ; …` became a bare BEL (wrong/anonymous
 * notification), and a split `ESC [ ? 1000 h` slipped the strip filter (the app
 * silently stole pointer/selection ownership). This tokenizer is the single
 * stateful parser both consumers share: it carries an unterminated sequence
 * across `push()` calls, so a sequence is recognised identically no matter where
 * the chunk boundary falls.
 *
 * Guarantees (verified by the every-byte-split property test):
 *   - Lossless: concatenating every token's `raw` across all push()+flush()
 *     calls reproduces the original byte stream exactly.
 *   - Boundary-invariant: the sequence of non-text tokens (and their parsed
 *     fields) is identical however the input is chunked.
 *
 * Scope: CSI (`ESC [ … final`), OSC (`ESC ] cmd ; payload` ST/BEL), DCS
 * (`ESC P … ST`), two-byte escapes, standalone BEL, and text runs. It classifies
 * and preserves; it does not interpret. Bounded: an unterminated OSC/DCS/CSI
 * beyond MAX_SEQUENCE_BYTES is flushed as text so a garbled stream can't grow
 * the buffer without limit.
 */

/** A standalone C0 control this tokenizer surfaces on its own (only BEL today —
 *  attention keys on it, and it must never be confused with an OSC terminator). */
export interface ExecuteToken {
  kind: 'execute';
  raw: string;
  code: number;
}

/** `ESC [ <prefix?> <params> <final>` — e.g. prefix '?', params '1000', final 'h'. */
export interface CsiToken {
  kind: 'csi';
  raw: string;
  prefix: string;
  params: string;
  final: string;
}

/** `ESC ] <command> ; <payload>` terminated by BEL or ST (ESC \). */
export interface OscToken {
  kind: 'osc';
  raw: string;
  command: number;
  payload: string;
  terminated: boolean;
}

/** `ESC P <payload> ST`. */
export interface DcsToken {
  kind: 'dcs';
  raw: string;
  payload: string;
  terminated: boolean;
}

/** A two-byte escape `ESC <final>` that is not CSI/OSC/DCS. */
export interface EscToken {
  kind: 'esc';
  raw: string;
  final: string;
}

/** A run of ordinary bytes (no recognised control structure). */
export interface TextToken {
  kind: 'text';
  raw: string;
}

export type TerminalToken = ExecuteToken | CsiToken | OscToken | DcsToken | EscToken | TextToken;

const ESC = 0x1b;
const BEL = 0x07;
const ST_FINAL = 0x5c; // backslash, the second byte of ST (ESC \)

/** Cap on a single buffered sequence before we give up and flush it as text. */
const MAX_SEQUENCE_BYTES = 8192;

type State = 'ground' | 'esc' | 'csi' | 'osc' | 'osc-esc' | 'dcs' | 'dcs-esc';

export class TerminalSequenceTokenizer {
  private state: State = 'ground';
  private text = '';
  private seq = '';

  /** Feed a chunk; returns every COMPLETE token. An incomplete trailing sequence
   *  (or text) is buffered and continues on the next push(). */
  push(chunk: string): TerminalToken[] {
    const out: TerminalToken[] = [];
    for (let i = 0; i < chunk.length; i += 1) {
      this.step(chunk.charCodeAt(i), chunk[i]!, out);
    }
    this.flushText(out);
    return out;
  }

  /** Emit any buffered partial sequence (best-effort) at end of stream. */
  flush(): TerminalToken[] {
    const out: TerminalToken[] = [];
    this.flushText(out);
    if (this.seq.length > 0) {
      out.push(this.finishSequence(false));
    }
    this.state = 'ground';
    return out;
  }

  private flushText(out: TerminalToken[]): void {
    if (this.text.length > 0) {
      out.push({ kind: 'text', raw: this.text });
      this.text = '';
    }
  }

  private step(code: number, ch: string, out: TerminalToken[]): void {
    switch (this.state) {
      case 'ground':
        if (code === ESC) {
          this.flushText(out);
          this.seq = ch;
          this.state = 'esc';
        } else if (code === BEL) {
          // Standalone BEL — NOT an OSC terminator (we are in ground). Surface it
          // so attention can raise a bell without ever swallowing a split OSC.
          this.flushText(out);
          out.push({ kind: 'execute', raw: ch, code });
        } else {
          this.text += ch;
        }
        return;

      case 'esc':
        this.seq += ch;
        if (ch === '[') {
          this.state = 'csi';
        } else if (ch === ']') {
          this.state = 'osc';
        } else if (ch === 'P') {
          this.state = 'dcs';
        } else {
          // Two-byte escape (or ESC ESC etc.) — complete.
          out.push({ kind: 'esc', raw: this.seq, final: ch });
          this.reset();
        }
        return;

      case 'csi':
        this.seq += ch;
        // Final byte 0x40..0x7e ends the CSI; params/intermediates are 0x20..0x3f.
        if (code >= 0x40 && code <= 0x7e) {
          out.push(this.parseCsi());
          this.reset();
        } else if (this.seq.length > MAX_SEQUENCE_BYTES) {
          this.giveUp(out);
        }
        return;

      case 'osc':
        if (code === BEL) {
          this.seq += ch;
          out.push(this.parseOsc(true));
          this.reset();
        } else if (code === ESC) {
          this.seq += ch;
          this.state = 'osc-esc';
        } else {
          this.seq += ch;
          if (this.seq.length > MAX_SEQUENCE_BYTES) {
            this.giveUp(out);
          }
        }
        return;

      case 'osc-esc':
        if (code === ST_FINAL) {
          this.seq += ch;
          out.push(this.parseOsc(true));
          this.reset();
        } else {
          // The ESC did not form ST — the OSC ends unterminated and this ESC
          // starts a new sequence. Emit the OSC (minus the trailing ESC) and
          // reprocess ESC + this byte in ground.
          this.seq = this.seq.slice(0, -1); // drop the ESC we appended
          out.push(this.parseOsc(false));
          this.reset();
          this.step(ESC, '', out);
          this.step(code, ch, out);
        }
        return;

      case 'dcs':
        this.seq += ch;
        if (code === ESC) {
          this.state = 'dcs-esc';
        } else if (this.seq.length > MAX_SEQUENCE_BYTES) {
          this.giveUp(out);
        }
        return;

      case 'dcs-esc':
        this.seq += ch;
        if (code === ST_FINAL) {
          out.push(this.parseDcs(true));
          this.reset();
        } else {
          // Not ST — stay in DCS (the ESC was data or a false alarm).
          this.state = 'dcs';
          if (this.seq.length > MAX_SEQUENCE_BYTES) {
            this.giveUp(out);
          }
        }
        return;
    }
  }

  private reset(): void {
    this.seq = '';
    this.state = 'ground';
  }

  /** Buffer overflowed — treat the accumulated bytes as opaque text. */
  private giveUp(out: TerminalToken[]): void {
    out.push({ kind: 'text', raw: this.seq });
    this.reset();
  }

  /** End-of-stream: emit whatever partial sequence we have as its best-effort
   *  token (terminated=false for OSC/DCS), or text for a bare ESC/CSI. */
  private finishSequence(_terminated: boolean): TerminalToken {
    switch (this.state) {
      case 'csi':
        return this.parseCsi();
      case 'osc':
      case 'osc-esc':
        return this.parseOsc(false);
      case 'dcs':
      case 'dcs-esc':
        return this.parseDcs(false);
      default:
        return { kind: 'text', raw: this.seq };
    }
  }

  private parseCsi(): CsiToken {
    // seq = ESC [ <prefix?> <params/intermediates> <final>
    const body = this.seq.slice(2);
    const final = body.slice(-1);
    let rest = body.slice(0, -1);
    let prefix = '';
    if (rest.length > 0 && (rest[0] === '?' || rest[0] === '>' || rest[0] === '<' || rest[0] === '=')) {
      prefix = rest[0]!;
      rest = rest.slice(1);
    }
    return { kind: 'csi', raw: this.seq, prefix, params: rest, final };
  }

  private parseOsc(terminated: boolean): OscToken {
    // seq = ESC ] <digits> ; <payload> [BEL | ESC \]
    let inner = this.seq.slice(2);
    if (terminated) {
      inner = inner.endsWith('\\') ? inner.slice(0, -2) : inner.slice(0, -1);
    }
    const semi = inner.indexOf(';');
    const cmdStr = semi >= 0 ? inner.slice(0, semi) : inner;
    const payload = semi >= 0 ? inner.slice(semi + 1) : '';
    const command = /^\d+$/.test(cmdStr) ? Number.parseInt(cmdStr, 10) : Number.NaN;
    return { kind: 'osc', raw: this.seq, command, payload, terminated };
  }

  private parseDcs(terminated: boolean): DcsToken {
    let inner = this.seq.slice(2);
    if (terminated && inner.endsWith('\\')) {
      inner = inner.slice(0, -2);
    }
    return { kind: 'dcs', raw: this.seq, payload: inner, terminated };
  }
}

/** Convenience: fully tokenize a complete string (no cross-call carry). */
export function tokenizeTerminalSequences(input: string): TerminalToken[] {
  const tok = new TerminalSequenceTokenizer();
  return [...tok.push(input), ...tok.flush()];
}
