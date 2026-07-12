import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const output: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line = '') => output.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line = '') => errors.push(String(line)));
  return { code: main(args), stdout: output.join('\n'), stderr: errors.join('\n') };
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

  it('does not consume another option as the value of --file', () => {
    const result = run(['config', '--file', '--dry-run']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--file requires a value');
  });

  it('does not consume the next add option as a missing value', () => {
    const result = run(['add', '--group', 'main', '--name', '--cwd', '/tmp', '--resume', 'new']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--name requires a value');
  });
});
