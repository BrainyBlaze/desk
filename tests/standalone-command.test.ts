import { describe, expect, it, vi } from 'vitest';
import { runStandaloneCommand, STANDALONE_USAGE } from '../src/server/standaloneCommand.js';

function harness() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const start = vi.fn(async () => {});
  return {
    stdout,
    stderr,
    start,
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
      start
    }
  };
}

describe('standalone command contract', () => {
  it('starts the server only when argv is empty', async () => {
    const h = harness();

    expect(await runStandaloneCommand([], h.io)).toBe(0);
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual([]);
  });

  it.each([['--help'], ['-h']])('prints help for %s without starting', async (...argv) => {
    const h = harness();

    expect(await runStandaloneCommand(argv, h.io)).toBe(0);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.stdout.join('')).toContain(STANDALONE_USAGE);
    expect(h.stderr).toEqual([]);
  });

  it.each([
    ['serve'],
    ['channels', 'read', 'example-channel'],
    ['--port', '5173']
  ])('rejects unsupported argv %j before starting', async (...argv) => {
    const h = harness();

    expect(await runStandaloneCommand(argv, h.io)).toBe(2);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.stdout).toEqual([]);
    expect(h.stderr.join('')).toContain('desk-server');
  });
});
