import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';

function run(args: string[]): { code: number; stderr: string } {
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((line = '') => errors.push(String(line)));
  return { code: main(args), stderr: errors.join('\n') };
}

describe('desk CLI option validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['unknown long option', ['config', '--typo', 'value']],
    ['unknown short option', ['config', '-x']],
    ['option belonging to another command', ['config', '--dry-run']]
  ])('rejects an %s instead of silently ignoring it', (_label, args) => {
    const result = run(args);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`unknown option ${args[1]} for desk config`);
  });
});
