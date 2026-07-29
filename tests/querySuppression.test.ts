// Reply-suppression responder matrix + query classifier (spec §7.7/§7.9).

import { describe, expect, it } from 'vitest';
import { QueryClass } from '../src/shared/atchWire/frames.js';
import {
  classifyCsi,
  classifyOsc,
  isOscColorQuery,
  responderFor
} from '../src/shared/browserProtocol/index.js';

describe('reply-suppression — responder matrix (§7.7)', () => {
  it('worker answers terminal-canonical queries', () => {
    for (const c of [QueryClass.DA1, QueryClass.DA2, QueryClass.DSR, QueryClass.CPR, QueryClass.DECRQM, QueryClass.XTVERSION]) {
      expect(responderFor(c)).toBe('worker');
    }
  });
  it('the lease-owning surface answers pixel/color/focus', () => {
    for (const c of [QueryClass.PIXEL_GEOM, QueryClass.COLOR, QueryClass.FOCUS]) {
      expect(responderFor(c)).toBe('surface');
    }
  });
});

describe('reply-suppression — CSI query classification', () => {
  it('DA1 (CSI c) → worker', () => {
    expect(classifyCsi([0], '', '', 'c')).toEqual({ responder: 'worker', wireClass: QueryClass.DA1, suppress: true });
    expect(classifyCsi([], '', '', 'c')).toEqual({ responder: 'worker', wireClass: QueryClass.DA1, suppress: true });
  });
  it('DA2 (CSI > c) → worker', () => {
    expect(classifyCsi([0], '>', '', 'c')?.wireClass).toBe(QueryClass.DA2);
  });
  it('DSR status (CSI 5 n) and CPR (CSI 6 n) → worker', () => {
    expect(classifyCsi([5], '', '', 'n')?.wireClass).toBe(QueryClass.DSR);
    expect(classifyCsi([6], '', '', 'n')?.wireClass).toBe(QueryClass.CPR);
  });
  it('DEC DSR (CSI ? 6 n) → worker', () => {
    expect(classifyCsi([6], '?', '', 'n')?.wireClass).toBe(QueryClass.DSR);
  });
  it('DECRQM (CSI ? Ps $ p) → worker', () => {
    expect(classifyCsi([2004], '?', '$', 'p')?.wireClass).toBe(QueryClass.DECRQM);
  });
  it('pixel geometry (CSI 14 t / 16 t) → surface', () => {
    expect(classifyCsi([14], '', '', 't')).toEqual({ responder: 'surface', wireClass: QueryClass.PIXEL_GEOM, suppress: true });
    expect(classifyCsi([16], '', '', 't')?.responder).toBe('surface');
  });
  it('char geometry (CSI 18 t / 19 t) → worker-local (no wire class)', () => {
    expect(classifyCsi([18], '', '', 't')).toEqual({ responder: 'worker', suppress: true });
    expect(classifyCsi([19], '', '', 't')?.wireClass).toBeUndefined();
  });
  it('focus reports (CSI I / CSI O) → surface', () => {
    expect(classifyCsi([], '', '', 'I')?.wireClass).toBe(QueryClass.FOCUS);
    expect(classifyCsi([], '', '', 'O')?.responder).toBe('surface');
  });
  it('non-query CSI is NOT suppressed', () => {
    expect(classifyCsi([1], '', '', 'A')).toBeNull(); // cursor up
    expect(classifyCsi([8, 24, 80], '', '', 't')).toBeNull(); // resize window op
    expect(classifyCsi([2004], '?', '', 'h')).toBeNull(); // DECSET (set), not a query
  });
});

describe('reply-suppression — OSC color query vs set (§7.7 over-suppression trap)', () => {
  it('OSC 4 palette QUERY (index;?) → surface', () => {
    expect(isOscColorQuery(4, '1;?')).toBe(true);
    expect(classifyOsc(4, true)).toEqual({ responder: 'surface', wireClass: QueryClass.COLOR, suppress: true });
  });
  it('OSC 4 palette SET (index;rgb:...) is NOT a query and NOT suppressed', () => {
    expect(isOscColorQuery(4, '1;rgb:ff/00/00')).toBe(false);
    expect(classifyOsc(4, false)).toBeNull();
  });
  it('OSC 10/11/12 color QUERY (?) → surface; SET passes through', () => {
    expect(isOscColorQuery(11, '?')).toBe(true);
    expect(isOscColorQuery(11, 'rgb:00/00/00')).toBe(false);
    expect(classifyOsc(11, true)?.responder).toBe('surface');
    expect(classifyOsc(11, false)).toBeNull();
  });
  it('OSC 4 mixed set+query detects the query field', () => {
    expect(isOscColorQuery(4, '1;rgb:ff/00/00;2;?')).toBe(true);
  });
  it('non-color OSC codes are never color queries', () => {
    expect(isOscColorQuery(0, 'window title')).toBe(false); // OSC 0 = title
    expect(classifyOsc(0, true)).toBeNull();
  });
});
