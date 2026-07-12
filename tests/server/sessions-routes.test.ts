import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSpec, TmuxPlanAction } from '../../src/core/types.js';
import { createDeskApiMiddleware } from '../../src/server/deskApiRouter.js';
import { createSessionsRoutes, readDeskSessionBody, runManagedPlan } from '../../src/server/routes/sessionsRoutes.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('sessions route validation', () => {
  it('preserves agent metadata for custom-command sessions', () => {
    expect(
      readDeskSessionBody(
        {
          name: 'custom-agent',
          command: 'claude-wrapper',
          agent: 'claude',
          resume: 'sess-edited',
          bypassPermissions: true
        },
        { cwdRequired: false }
      )
    ).toEqual({
      name: 'custom-agent',
      command: 'claude-wrapper',
      agent: 'claude',
      resume: 'sess-edited',
      bypassPermissions: true
    });
  });

  it('surfaces an invalid session payload as a typed 400 response', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = Object.assign(new PassThrough(), {
      method: 'POST',
      url: '/api/add',
      headers: { 'content-type': 'application/json' }
    }) as unknown as IncomingMessage;
    req.end(JSON.stringify({ groupId: 'main', session: null }));
    const chunks: string[] = [];
    const res = {
      statusCode: 0,
      setHeader: () => undefined,
      end: (payload?: unknown) => {
        if (payload !== undefined) {
          chunks.push(String(payload));
        }
      }
    } as unknown as ServerResponse;
    const route = createSessionsRoutes({
      managedAgentLsp: {} as never,
      nativeAgentLaunch: (spec) => spec,
      agentSurfaceBroker: { disposeSession: vi.fn() }
    });

    await createDeskApiMiddleware([route])(req, res, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(chunks.join(''))).toEqual({
      error: 'session body is required',
      code: 'invalid-input'
    });
  });
});
