// Browser reply-suppression addon (spec §7.7). An xterm addon that registers
// PUBLIC parser handlers to SUPPRESS the browser terminal's built-in replies to
// terminal queries (DA/DSR/CPR/DECRQM/geometry/focus/color) — so exactly ONE
// responder answers each query (the worker or the lease-owning surface, via the
// TERMINAL_REPLY / query_reply wire path), never a stray browser auto-reply.
//
// The decision of WHICH sequences are queries (and the set-vs-query distinction
// that must NOT over-suppress a color SET) lives in the pure `querySuppression`
// classifier; this addon only wires it into xterm's registerCsiHandler /
// registerOscHandler. Structural terminal type so it runs on @xterm/xterm (the
// browser) AND @xterm/headless (tests) without a hard dep on either.

import { classifyCsi, classifyOsc, isOscColorQuery } from '../shared/browserProtocol/querySuppression.js';

interface IDisposableLike {
  dispose(): void;
}
interface CsiIdentifier {
  prefix?: string;
  intermediates?: string;
  final: string;
}
interface XtermParserLike {
  registerCsiHandler(id: CsiIdentifier, cb: (params: (number | number[])[]) => boolean): IDisposableLike;
  registerOscHandler(ident: number, cb: (data: string) => boolean): IDisposableLike;
}
interface TerminalLike {
  parser: XtermParserLike;
}

/** The (prefix, intermediate, final) CSI query forms to intercept (§7.7 matrix). */
const CSI_QUERY_IDS: { prefix: string; intermediate: string; final: string }[] = [
  { prefix: '', intermediate: '', final: 'c' }, // DA1
  { prefix: '>', intermediate: '', final: 'c' }, // DA2
  { prefix: '', intermediate: '', final: 'n' }, // DSR / CPR
  { prefix: '?', intermediate: '', final: 'n' }, // DEC DSR
  { prefix: '?', intermediate: '$', final: 'p' }, // DECRQM
  { prefix: '', intermediate: '', final: 't' }, // geometry (query params only)
  { prefix: '', intermediate: '', final: 'I' }, // focus in
  { prefix: '', intermediate: '', final: 'O' } // focus out
];
const OSC_COLOR_CODES = [4, 10, 11, 12];

const flat = (params: (number | number[])[]): number[] => params.map((p) => (Array.isArray(p) ? (p[0] ?? 0) : p));

export class ReplySuppressionAddon {
  private disposables: IDisposableLike[] = [];

  activate(terminal: TerminalLike): void {
    for (const id of CSI_QUERY_IDS) {
      const identifier: CsiIdentifier = { final: id.final };
      if (id.prefix) identifier.prefix = id.prefix;
      if (id.intermediate) identifier.intermediates = id.intermediate;
      this.disposables.push(
        terminal.parser.registerCsiHandler(identifier, (params) => {
          // true = suppress the built-in reply; false = not a query, let xterm run.
          return classifyCsi(flat(params), id.prefix, id.intermediate, id.final) !== null;
        })
      );
    }
    for (const code of OSC_COLOR_CODES) {
      this.disposables.push(
        terminal.parser.registerOscHandler(code, (data) => {
          // Only the `?` REPORT form is a query to suppress; a SET must pass through.
          return classifyOsc(code, isOscColorQuery(code, data)) !== null;
        })
      );
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
