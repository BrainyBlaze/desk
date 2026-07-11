import { beforeEach, describe, expect, it } from 'vitest';
import {
  ensureTmuxGlobalOptions,
  markTmuxGlobalOptionsStale,
  resetTmuxGlobalOptionsForTests
} from '../src/server/tmuxOptions';

describe('tmux global options', () => {
  beforeEach(() => {
    resetTmuxGlobalOptionsForTests();
  });

  it('applies the shared options once until the tmux server is marked stale', () => {
    const calls: string[][] = [];
    const exec = (_file: string, args: string[]) => {
      calls.push(args);
      return { status: 0 };
    };

    expect(ensureTmuxGlobalOptions(exec)).toBe(true);
    expect(ensureTmuxGlobalOptions(exec)).toBe(true);
    expect(calls).toEqual([
      ['set-option', '-g', 'mouse', 'off'],
      ['set-option', '-g', 'allow-passthrough', 'on']
    ]);

    markTmuxGlobalOptionsStale();
    expect(ensureTmuxGlobalOptions(exec)).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('retries after tmux rejects an option command', () => {
    const calls: string[][] = [];
    let fail = true;
    const exec = (_file: string, args: string[]) => {
      calls.push(args);
      return { status: fail ? 1 : 0 };
    };

    expect(ensureTmuxGlobalOptions(exec)).toBe(false);
    fail = false;
    expect(ensureTmuxGlobalOptions(exec)).toBe(true);
    expect(calls).toHaveLength(4);
  });
});
