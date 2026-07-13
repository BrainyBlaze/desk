import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPlan } from '../src/core/runner.js';
import { buildSessionSpecs, parseDeskManifest } from '../src/core/manifest.js';
import type { TmuxPlanAction } from '../src/core/types.js';

function nativePlan(): TmuxPlanAction[] {
  // claude with no explicit uiMode resolves to native-mode.
  const spec = buildSessionSpecs(
    parseDeskManifest(`
projects:
  - id: p
    cwd: /tmp
    groups:
      - id: g
        sessions:
          - name: n
            agent: claude
`),
    { homeDir: '/tmp' }
  )[0]!;
  return [{ type: 'start', session: spec, argv: ['new-session', '-d', '-s', spec.tmuxSession] }];
}

describe('runPlan native-mode guard (finding C4)', () => {
  let errors: string[];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses to boot a native-mode session and points at desk serve (no silent death, exit 1)', () => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((line = '') => errors.push(String(line)));
    // Would previously spawn `tmux new-session` running `exec desk agent-host`,
    // which dies for lack of server env, and still return 0.
    expect(runPlan(nativePlan(), false)).toBe(1);
    expect(errors.join(' ')).toContain('native-mode');
    expect(errors.join(' ')).toContain('desk serve');
  });

  it('dry-run still just prints the plan (does not refuse)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runPlan(nativePlan(), true)).toBe(0);
  });
});
