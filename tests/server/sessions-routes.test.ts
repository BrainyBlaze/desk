import { describe, expect, it, vi } from 'vitest';
import type { SessionSpec, TmuxPlanAction } from '../../src/core/types.js';
import { runManagedPlan } from '../../src/server/routes/sessionsRoutes.js';

const session: SessionSpec = {
  groupId: 'main',
  groupLabel: 'Main',
  name: 'shell',
  cwd: '/tmp',
  tmuxSession: 'desk-main-shell',
  command: 'bash',
  uiMode: 'terminal'
};

describe('sessions route managed startup', () => {
  it('preserves the actionable startSession failure reason for the API response', () => {
    const cleanup = vi.fn();
    const plan: TmuxPlanAction[] = [{ type: 'start', session, argv: [] }];
    const result = runManagedPlan(
      plan,
      undefined,
      { prepare: () => ({ session, cleanup }) } as never,
      (spec) => spec,
      () => ({ ok: false, error: 'tmux executable not found' })
    );

    expect(result).toEqual({ exitCode: 1, error: 'tmux executable not found' });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
