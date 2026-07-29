// Reply-suppression responder matrix + query classifier (spec §7.7, reused by
// §7.9's output-side stripper). Pure module — no xterm import. The real browser
// addon and the human-attach parser feed already-parsed control-sequence pieces
// (as xterm's registerCsiHandler / registerOscHandler deliver them) into this
// classifier to decide: is this a query, who answers it, and must it be
// suppressed. Keeping it pure makes the whole matrix unit-testable independent
// of the terminal runtime.

import { QueryClass } from '../atchWire/frames.js';

/** Who answers a query (§7.7). `worker` = the authoritative headless emulator;
 *  `surface` = the ONE lease-owning browser surface (pixel/color/focus, which
 *  the worker has no basis to answer). */
export type Responder = 'worker' | 'surface';

/**
 * A recognized query. `wireClass` is the frozen §4.2 QueryClass when the reply
 * routes over a TERMINAL_REPLY frame; it is undefined for char-geometry
 * (18t/19t), which the worker answers locally as ordinary emulator output and
 * needs no routed class. `suppress` is always true for a recognized query — the
 * browser's built-in reply must be suppressed so exactly one responder answers.
 */
export interface QueryMatch {
  responder: Responder;
  wireClass?: QueryClass;
  suppress: true;
}

/** The §7.7 responder for a frozen wire QueryClass. */
export function responderFor(cls: QueryClass): Responder {
  switch (cls) {
    case QueryClass.DA1:
    case QueryClass.DA2:
    case QueryClass.DSR:
    case QueryClass.CPR:
    case QueryClass.DECRQM:
    case QueryClass.XTVERSION:
      return 'worker';
    case QueryClass.PIXEL_GEOM:
    case QueryClass.COLOR:
    case QueryClass.FOCUS:
      return 'surface';
  }
}

/**
 * Classify a CSI sequence as xterm's registerCsiHandler delivers it:
 *  - `params`: numeric params (0 for empty),
 *  - `prefix`: a private-marker char ('?', '>', '<', '=') or '',
 *  - `intermediate`: an intermediate char ('$', ' ', etc.) or '',
 *  - `final`: the final byte char.
 * Returns a QueryMatch for a recognized QUERY form, else null (a non-query CSI —
 * e.g. a mode SET, cursor move — must NOT be suppressed).
 */
export function classifyCsi(params: readonly number[], prefix: string, intermediate: string, final: string): QueryMatch | null {
  const p0 = params.length > 0 ? params[0] : 0;
  switch (final) {
    case 'c': // Device Attributes
      if (prefix === '' && (p0 === 0 || params.length === 0)) return worker(QueryClass.DA1); // DA1  CSI c
      if (prefix === '>') return worker(QueryClass.DA2); // DA2  CSI > c
      return null;
    case 'n': // Device Status Report / Cursor Position Report
      if (prefix === '' && p0 === 5) return worker(QueryClass.DSR); // status
      if (prefix === '' && p0 === 6) return worker(QueryClass.CPR); // cursor position
      if (prefix === '?' && (p0 === 6 || p0 === 15 || p0 === 25 || p0 === 26)) return worker(QueryClass.DSR); // DEC DSR variants
      return null;
    case 'p':
      if (prefix === '?' && intermediate === '$') return worker(QueryClass.DECRQM); // CSI ? Ps $ p — request mode
      return null;
    case 't': // window ops — only the geometry REPORT requests are queries
      if (p0 === 14 || p0 === 16) return surface(QueryClass.PIXEL_GEOM); // pixel geometry — browser answers
      if (p0 === 18 || p0 === 19) return { responder: 'worker', suppress: true }; // char geometry — worker-local, no wire class
      return null; // 8t resize / 22t/23t stack etc. are commands, not queries
    case 'I': // focus-in report (DECSET 1004) — browser-generated, route to surface
    case 'O': // focus-out report
      return surface(QueryClass.FOCUS);
    default:
      return null;
  }
}

/**
 * Classify an OSC sequence. `code` is the OSC number; `isReportQuery` is whether
 * the payload is the `?` REPORT form (a color query) versus a SET (which changes
 * the color and MUST pass through unsuppressed). Only OSC 4 (palette) and OSC
 * 10/11/12 (fg/bg/cursor) have query forms we route to the surface.
 */
export function classifyOsc(code: number, isReportQuery: boolean): QueryMatch | null {
  if (!isReportQuery) return null; // a SET — never suppress
  if (code === 4 || code === 10 || code === 11 || code === 12) return surface(QueryClass.COLOR);
  return null;
}

/**
 * Detect the `?` report form in an OSC 4/10/11/12 payload. OSC 4 palette queries
 * look like `4;<index>;?`; OSC 10/11/12 like `?`. A payload that assigns a color
 * (`rgb:...`, `#rrggbb`, a name) is a SET.
 */
export function isOscColorQuery(code: number, payload: string): boolean {
  if (code === 4) {
    // `index;?` (possibly repeated `i;?;j;?`) — a query if any spec field is '?'.
    const fields = payload.split(';');
    for (let i = 1; i < fields.length; i += 2) if (fields[i] === '?') return true;
    return false;
  }
  if (code === 10 || code === 11 || code === 12) return payload.trim() === '?';
  return false;
}

function worker(cls: QueryClass): QueryMatch {
  return { responder: 'worker', wireClass: cls, suppress: true };
}
function surface(cls: QueryClass): QueryMatch {
  return { responder: 'surface', wireClass: cls, suppress: true };
}
