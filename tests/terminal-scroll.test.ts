import { describe, expect, it } from 'vitest';
import { chooseScrollStrategy, encodeApplicationScrollInput, terminalScrollOwnerForAgent } from '../src/web/terminalScroll';

describe('terminal scroll strategy', () => {
  it('uses local xterm scrollback before shared terminal history', () => {
    expect(
      chooseScrollStrategy({
        running: true,
        localScrollbackRows: 120,
        localViewportY: 8,
        requestedLines: -8
      })
    ).toBe('local');
  });

  it('uses shared terminal history when upward local scrollback is exhausted', () => {
    expect(
      chooseScrollStrategy({
        running: true,
        localScrollbackRows: 120,
        localViewportY: 0,
        requestedLines: -8
      })
    ).toBe('history');
  });

  it('uses shared terminal history only when no local xterm scrollback exists', () => {
    expect(
      chooseScrollStrategy({
        running: true,
        localScrollbackRows: 0,
        requestedLines: -8
      })
    ).toBe('history');
  });

  it('keeps non-running terminals on local scroll handling', () => {
    expect(
      chooseScrollStrategy({
        running: false,
        localScrollbackRows: 0,
        requestedLines: -8
      })
    ).toBe('local');
  });

  it('uses application scroll for alternate-screen buffers instead of the history overlay', () => {
    expect(
      chooseScrollStrategy({
        activeBufferType: 'alternate',
        running: true,
        localScrollbackRows: 0,
        localViewportY: 0,
        requestedLines: -8
      })
    ).toBe('application');
  });

  it('keeps normal-buffer OpenCode on the shared terminal history path', () => {
    expect(
      chooseScrollStrategy({
        activeBufferType: 'normal',
        agent: 'opencode',
        running: true,
        localScrollbackRows: 0,
        localViewportY: 0,
        requestedLines: -8
      })
    ).toBe('history');
  });

  it('encodes OpenCode application scroll as repeated line-scroll keys', () => {
    expect(encodeApplicationScrollInput(-3, 'opencode')).toBe('\x1b\x19'.repeat(3));
    expect(encodeApplicationScrollInput(2, 'opencode')).toBe('\x1b\x05'.repeat(2));
    expect(encodeApplicationScrollInput(0, 'opencode')).toBeUndefined();
  });

  it('encodes generic application scroll as page keys', () => {
    expect(encodeApplicationScrollInput(-1, 'page-keys')).toBe('\x1b[5~');
    expect(encodeApplicationScrollInput(1, 'page-keys')).toBe('\x1b[6~');
  });
});

describe('terminal scroll owner', () => {
  it('defers the scroll indicator to grok and keeps the host rail elsewhere', () => {
    expect(terminalScrollOwnerForAgent('grok')).toBe('agent');
    for (const agent of ['claude', 'codex', 'opencode', 'qwen', 'kimi', 'bash', undefined]) {
      expect(terminalScrollOwnerForAgent(agent)).toBe('host');
    }
  });
});
