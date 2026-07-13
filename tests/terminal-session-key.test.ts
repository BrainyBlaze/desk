import { describe, expect, it } from 'vitest';
import { terminalSessionKey } from '../src/web/terminalSessionKey.js';
import type { DeskSessionView } from '../src/ui/model.js';
import type { SessionSpec } from '../src/core/types.js';

function view(overrides: Partial<SessionSpec> = {}, state: 'running' | 'missing' = 'running'): DeskSessionView {
  const spec = {
    name: 'web',
    cwd: '/repo',
    groupId: 'g',
    groupLabel: 'G',
    tmuxSession: 'proj-g-web',
    ...overrides
  } as SessionSpec;
  return { spec, state };
}

describe('terminalSessionKey', () => {
  it('is identical for two different-identity objects with the same relevant content', () => {
    // This is the flaky-render fix: a mutation ships a fresh snapshot whose
    // session objects are new instances but identical content. The socket
    // effect must NOT re-run (no reflash), so the key must be stable.
    const a = view();
    const b = view();
    expect(a).not.toBe(b); // different object identities
    expect(terminalSessionKey(a)).toBe(terminalSessionKey(b));
  });

  it('changes when the tmux target changes (rename → resubscribe)', () => {
    expect(terminalSessionKey(view({ tmuxSession: 'proj-g-web' }))).not.toBe(
      terminalSessionKey(view({ tmuxSession: 'proj-g-api' }))
    );
  });

  it('changes when run-state flips (boot/kill → repaint)', () => {
    expect(terminalSessionKey(view({}, 'missing'))).not.toBe(terminalSessionKey(view({}, 'running')));
  });

  it('changes when displayed name or cwd changes', () => {
    expect(terminalSessionKey(view({ name: 'web' }))).not.toBe(terminalSessionKey(view({ name: 'web2' })));
    expect(terminalSessionKey(view({ cwd: '/a' }))).not.toBe(terminalSessionKey(view({ cwd: '/b' })));
  });

  it('distinguishes the no-session (control-channel) case from any real session', () => {
    expect(terminalSessionKey(undefined)).toBe('none');
    expect(terminalSessionKey(view())).not.toBe(terminalSessionKey(undefined));
  });
});
