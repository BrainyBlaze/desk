import { describe, expect, it } from 'vitest';
import { chooseScrollStrategy, encodeApplicationScrollInput } from '../src/web/terminalScroll';

describe('terminal scroll strategy', () => {
  it('uses local xterm scrollback before tmux virtual capture', () => {
    expect(
      chooseScrollStrategy({
        running: true,
        localScrollbackRows: 120,
        localViewportY: 8,
        requestedLines: -8
      })
    ).toBe('local');
  });

  it('uses tmux capture when upward local scrollback is exhausted', () => {
    expect(
      chooseScrollStrategy({
        running: true,
        localScrollbackRows: 120,
        localViewportY: 0,
        requestedLines: -8
      })
    ).toBe('tmux');
  });

  it('uses tmux capture only when no local xterm scrollback exists', () => {
    expect(
      chooseScrollStrategy({
        running: true,
        localScrollbackRows: 0,
        requestedLines: -8
      })
    ).toBe('tmux');
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

  it('uses application scroll for alternate-screen buffers instead of the tmux capture overlay', () => {
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

  it('keeps normal-buffer OpenCode on the shared tmux scrollback path', () => {
    expect(
      chooseScrollStrategy({
        activeBufferType: 'normal',
        agent: 'opencode',
        running: true,
        localScrollbackRows: 0,
        localViewportY: 0,
        requestedLines: -8
      })
    ).toBe('tmux');
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
