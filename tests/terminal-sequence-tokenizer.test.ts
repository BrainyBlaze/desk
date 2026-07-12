import { describe, expect, it } from 'vitest';
import {
  TerminalSequenceTokenizer,
  tokenizeTerminalSequences,
  type TerminalToken
} from '../src/shared/terminalSequenceTokenizer.js';

const BEL = '\x07';
const ESC = '\x1b';
const ST = '\x1b\\';

// A "signature" of the non-text token stream: what the sequence MEANS, ignoring
// how text runs happen to be split by chunk boundaries.
function signature(tokens: TerminalToken[]): string {
  return tokens
    .filter((t) => t.kind !== 'text')
    .map((t) => {
      switch (t.kind) {
        case 'csi':
          return `csi:${t.prefix}|${t.params}|${t.final}`;
        case 'osc':
          return `osc:${t.command}|${t.payload}|${t.terminated}`;
        case 'dcs':
          return `dcs:${t.payload}|${t.terminated}`;
        case 'esc':
          return `esc:${t.final}`;
        case 'execute':
          return `exec:${t.code}`;
        default:
          return '';
      }
    })
    .join(' ');
}

function splitTokenize(input: string, at: number): TerminalToken[] {
  const tok = new TerminalSequenceTokenizer();
  return [...tok.push(input.slice(0, at)), ...tok.push(input.slice(at)), ...tok.flush()];
}

const FIXTURES: Array<[string, string]> = [
  ['plain text', 'hello world'],
  ['osc 9 notification', `${ESC}]9;needs input${BEL}`],
  ['osc 0 title', `${ESC}]0;my title${BEL}`],
  ['osc 8 hyperlink pair', `${ESC}]8;;https://example.com${ST}link${ESC}]8;;${ST}`],
  ['decset mouse on', `${ESC}[?1000h`],
  ['decset mouse off', `${ESC}[?1002l`],
  ['decset alt screen', `${ESC}[?1049h`],
  ['csi cursor home', `${ESC}[H`],
  ['csi clear', `${ESC}[2J`],
  ['dcs kitty version', `${ESC}P>|kitty(0.47.0)${ST}`],
  ['standalone bel', `abc${BEL}def`],
  ['two-byte escape', `${ESC}=`],
  ['mixed stream', `hi${ESC}[?1000h${ESC}]9;msg${BEL}bye${BEL}${ESC}[0m`],
  ['osc terminated by ST', `${ESC}]0;title${ST}rest`],
  ['back to back csi', `${ESC}[1m${ESC}[31m${ESC}[?25l`]
];

describe('TerminalSequenceTokenizer — chunk-boundary invariance (D-1/D-2)', () => {
  for (const [name, input] of FIXTURES) {
    it(`is lossless and boundary-invariant: ${name}`, () => {
      const whole = tokenizeTerminalSequences(input);
      const wholeSig = signature(whole);
      // Whole tokenization reassembles exactly.
      expect(whole.map((t) => t.raw).join('')).toBe(input);
      // Split at EVERY byte boundary: same reassembly, same meaning.
      for (let at = 0; at <= input.length; at += 1) {
        const split = splitTokenize(input, at);
        expect(split.map((t) => t.raw).join(''), `reassembly at split ${at}`).toBe(input);
        expect(signature(split), `signature at split ${at}`).toBe(wholeSig);
      }
    });
  }

  it('D-1: a split OSC 9 is one OSC token, never a bare BEL', () => {
    const input = `${ESC}]9;approval needed${BEL}`;
    // Split so the terminating BEL lands in the second chunk — the exact case the
    // old chunk-local regex turned into an anonymous bell.
    const belIndex = input.length - 1;
    const tok = new TerminalSequenceTokenizer();
    const tokens = [...tok.push(input.slice(0, belIndex)), ...tok.push(input.slice(belIndex)), ...tok.flush()];
    const oscs = tokens.filter((t) => t.kind === 'osc');
    expect(oscs).toHaveLength(1);
    expect(oscs[0]).toMatchObject({ command: 9, payload: 'approval needed', terminated: true });
    // And NO standalone BEL leaked out.
    expect(tokens.some((t) => t.kind === 'execute' && t.code === 7)).toBe(false);
  });

  it('D-2: a split DECSET mouse-mode is one CSI token the strip filter can catch', () => {
    const input = `${ESC}[?1000h`;
    // Split mid-params (ESC[?10 | 00h) — the old chunk-local filter let this pass.
    const tok = new TerminalSequenceTokenizer();
    const tokens = [...tok.push(`${ESC}[?10`), ...tok.push('00h'), ...tok.flush()];
    const csis = tokens.filter((t) => t.kind === 'csi');
    expect(csis).toHaveLength(1);
    expect(csis[0]).toMatchObject({ prefix: '?', params: '1000', final: 'h' });
    expect(tokens.map((t) => t.raw).join('')).toBe(input);
  });

  it('coalesced push of many small chunks stays lossless and correct', () => {
    const input = `title${ESC}]0;x${BEL}${ESC}[?1002h${ESC}P q${ST}end`;
    const tok = new TerminalSequenceTokenizer();
    const collected: TerminalToken[] = [];
    for (const ch of input) {
      collected.push(...tok.push(ch)); // one byte at a time — the worst case
    }
    collected.push(...tok.flush());
    expect(collected.map((t) => t.raw).join('')).toBe(input);
    expect(signature(collected)).toBe(signature(tokenizeTerminalSequences(input)));
  });
});
