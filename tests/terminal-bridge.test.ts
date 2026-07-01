import { beforeEach, describe, expect, it } from 'vitest';
import { MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS } from '../src/core/terminalSizing';
import {
  createTerminalAttachCommand,
  getLastGoodTerminalSize,
  repairTinyTmuxWindows,
  resetTerminalResizeStateForTests,
  resizeTmuxWindow,
  sliceCapturedPaneLines,
  stripTerminalMouseModeControls
} from '../src/server/terminalBridge';
import type { SessionSpec } from '../src/core/types';

const session: SessionSpec = {
  groupId: 'research',
  groupLabel: 'Research',
  name: 'sample-agent',
  cwd: '/workspace/projects/sample',
  agent: 'codex',
  resume: '00000000-0000-7000-8000-000000000000',
  tmuxSession: 'agentdesk-research-sample-agent-00000000',
  command: 'codex --dangerously-bypass-approvals-and-sandbox resume 00000000-0000-7000-8000-000000000000'
};

describe('terminal bridge', () => {
  beforeEach(() => {
    resetTerminalResizeStateForTests();
  });

  it('builds a PTY-backed tmux attach command for a resolved session', () => {
    expect(createTerminalAttachCommand(session)).toEqual({
      file: 'tmux',
      args: ['attach-session', '-f', 'ignore-size', '-t', 'agentdesk-research-sample-agent-00000000']
    });
  });

  it('strips mouse-reporting and cursor-hide escape sequences while preserving cursor-show', () => {
    expect(stripTerminalMouseModeControls('a\x1b[?1000h\x1b[?1006hb')).toBe('ab');
    expect(stripTerminalMouseModeControls('a\x1b[?25;1000hb')).toBe('a\x1b[?25hb');
    expect(stripTerminalMouseModeControls('a\x1b[?25lb')).toBe('ab');
    expect(stripTerminalMouseModeControls('a\x1b[?25hb')).toBe('a\x1b[?25hb');
    expect(stripTerminalMouseModeControls('a\x1b[?12lb')).toBe('ab');
    expect(stripTerminalMouseModeControls('a\x1b[?12hb')).toBe('ab');
  });

  it('rewrites steady cursor styles to blinking cursor styles', () => {
    expect(stripTerminalMouseModeControls('a\x1b[2 qb')).toBe('a\x1b[1 qb');
    expect(stripTerminalMouseModeControls('a\x1b[4 qb')).toBe('a\x1b[3 qb');
    expect(stripTerminalMouseModeControls('a\x1b[6 qb')).toBe('a\x1b[5 qb');
    expect(stripTerminalMouseModeControls('a\x1b[1 qb')).toBe('a\x1b[1 qb');
  });

  it('fast-path returns plain output unchanged (no mouse-mode or cursor-style escapes)', () => {
    const plain = '\x1b[32mline 1 lorem ipsum\x1b[0m\r\nline 2 dolor sit amet consectetur\r\n';
    expect(stripTerminalMouseModeControls(plain)).toBe(plain);
    expect(stripTerminalMouseModeControls('')).toBe('');
    // A colored chunk that also carries a real mouse-mode escape still gets stripped.
    expect(stripTerminalMouseModeControls('\x1b[32mok\x1b[0m\x1b[?1000h')).toBe('\x1b[32mok\x1b[0m');
  });

  it('slices captured tmux history and clamps offsets beyond available lines', () => {
    const lines = ['cmd', 'one', 'two', 'three', 'four', 'prompt'];

    expect(sliceCapturedPaneLines(lines, 3, 0)).toEqual(['three', 'four', 'prompt']);
    expect(sliceCapturedPaneLines(lines, 3, 2)).toEqual(['one', 'two', 'three']);
    expect(sliceCapturedPaneLines(lines, 3, 50)).toEqual(['cmd', 'one', 'two']);
  });

  it('rejects tiny resize requests before calling tmux resize-window', () => {
    const calls: string[][] = [];

    const result = resizeTmuxWindow('agentdesk-small', 12, 6, (_file, args) => {
      calls.push(args);
      return { status: 0, stderr: '' };
    });

    expect(result).toEqual({
      ok: true,
      skipped: true,
      reason: 'below-minimum',
      minCols: MIN_TERMINAL_COLS,
      minRows: MIN_TERMINAL_ROWS
    });
    expect(calls).toEqual([]);
    expect(getLastGoodTerminalSize('agentdesk-small')).toBeUndefined();
  });

  it('records the last good tmux size and preserves it when a later tiny resize is ignored', () => {
    const calls: string[][] = [];
    const resize = (cols: number, rows: number) =>
      resizeTmuxWindow('agentdesk-sized', cols, rows, (_file, args) => {
        calls.push(args);
        return { status: 0, stderr: '' };
      });

    expect(resize(100, 30)).toEqual({ ok: true, cols: 100, rows: 30 });
    expect(getLastGoodTerminalSize('agentdesk-sized')).toEqual({ cols: 100, rows: 30 });

    expect(resize(20, 8)).toEqual({
      ok: true,
      skipped: true,
      reason: 'below-minimum',
      minCols: MIN_TERMINAL_COLS,
      minRows: MIN_TERMINAL_ROWS,
      lastGood: { cols: 100, rows: 30 }
    });
    expect(calls).toEqual([['resize-window', '-t', 'agentdesk-sized', '-x', '100', '-y', '30']]);
    expect(getLastGoodTerminalSize('agentdesk-sized')).toEqual({ cols: 100, rows: 30 });
  });

  it('does not record a failed tmux resize as the last good size', () => {
    const result = resizeTmuxWindow('agentdesk-fail', 100, 30, () => ({
      status: 1,
      stderr: 'no such session'
    }));

    expect(result).toEqual({ ok: false, error: 'no such session' });
    expect(getLastGoodTerminalSize('agentdesk-fail')).toBeUndefined();
  });

  it('repairs tiny tmux windows to a safe default size', () => {
    const calls: string[][] = [];

    const result = repairTinyTmuxWindows([{ tmuxSession: 'agentdesk-tiny' }], (_file, args) => {
      calls.push(args);
      if (args[0] === 'display-message') {
        return { status: 0, stdout: '12\t6\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    expect(result).toEqual({
      checked: 1,
      repaired: [{ tmuxSession: 'agentdesk-tiny', from: { cols: 12, rows: 6 }, to: { cols: 120, rows: 40 } }],
      failed: []
    });
    expect(calls).toEqual([
      ['display-message', '-p', '-t', 'agentdesk-tiny', '#{window_width}\t#{window_height}'],
      ['resize-window', '-t', 'agentdesk-tiny', '-x', '120', '-y', '40']
    ]);
  });

  it('leaves valid tmux windows untouched during tiny-window repair', () => {
    const calls: string[][] = [];

    const result = repairTinyTmuxWindows([{ tmuxSession: 'agentdesk-ok' }], (_file, args) => {
      calls.push(args);
      return { status: 0, stdout: '100\t30\n', stderr: '' };
    });

    expect(result).toEqual({ checked: 1, repaired: [], failed: [] });
    expect(calls).toEqual([['display-message', '-p', '-t', 'agentdesk-ok', '#{window_width}\t#{window_height}']]);
  });
});
