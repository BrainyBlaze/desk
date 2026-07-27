import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionPlanAction, SessionSpec } from '../../src/core/types.js';
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
  sessionId: 'shell',
  command: 'bash',
  uiMode: 'terminal'
};

describe('sessions route managed startup', () => {
  it('preserves the actionable startSession failure reason for the API response', async () => {
    const cleanup = vi.fn();
    const plan: SessionPlanAction[] = [{ type: 'start', session }];
    const result = await runManagedPlan(
      plan,
      undefined,
      { prepare: () => ({ session, cleanup }) } as never,
      (spec) => spec,
      () => ({ ok: false, error: 'tmux executable not found' })
    );

    expect(result.exitCode).toBe(1);
    // The reason must survive verbatim — it is what the operator acts on.
    expect(result.error).toContain('tmux executable not found');
    expect(result.error).toContain('shell');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  /**
   * A single unstartable session used to abort the whole plan, so one stale
   * cwd left an entire fleet down with only the first error surfaced.
   */
  it('attempts every session when one fails and names all failures', async () => {
    const second: SessionSpec = { ...session, name: 'second', sessionId: 'second' };
    const third: SessionSpec = { ...session, name: 'third', sessionId: 'third' };
    const plan: SessionPlanAction[] = [
      { type: 'start', session },
      { type: 'start', session: second },
      { type: 'start', session: third }
    ];
    const attempted: string[] = [];
    const result = await runManagedPlan(
      plan,
      undefined,
      { prepare: () => undefined } as never,
      (spec) => spec,
      (spec) => {
        attempted.push(spec.sessionId);
        return spec.sessionId === 'second' ? { ok: false, error: 'attach-failed' } : { ok: true };
      }
    );

    expect(attempted).toEqual(['shell', 'second', 'third']);
    expect(result.exitCode).toBe(1); // a partial start is never reported as success
    expect(result.error).toContain('second');
    expect(result.error).not.toContain('third');
  });

  it('reports success only when every session starts', async () => {
    const plan: SessionPlanAction[] = [{ type: 'start', session }, { type: 'preserve', session }];
    const result = await runManagedPlan(
      plan,
      undefined,
      { prepare: () => undefined } as never,
      (spec) => spec,
      () => ({ ok: true })
    );

    expect(result).toEqual({ exitCode: 0 });
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

describe('sessions route native edit identity', () => {
  it('a rename with a persisted sessionId KEEPS its identity: no retire, no provision, manifest renamed even with the daemon down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const home = mkdtempSync(join(tmpdir(), 'desk-edit-home-'));
    const work = mkdtempSync(join(tmpdir(), 'desk-edit-work-'));
    const savedEnv = { HOME: process.env.HOME, DESK_ATCH_NATIVE: process.env.DESK_ATCH_NATIVE, DESK_DAEMON_URL: process.env.DESK_DAEMON_URL };
    try {
      mkdirSync(join(home, '.config', 'desk'), { recursive: true });
      const manifestPath = join(home, '.config', 'desk', 'desk.yml');
      writeFileSync(
        manifestPath,
        [
          'projects:',
          '  - id: proj',
          '    label: Proj',
          `    cwd: ${work}`,
          '    groups:',
          '      - id: g',
          '        label: G',
          '        sessions:',
          '          - name: oldname',
          '            agent: codex',
          '            sessionId: oldname'
        ].join('\n') + '\n'
      );
      process.env.HOME = home;
      process.env.DESK_ATCH_NATIVE = '1';
      process.env.DESK_DAEMON_URL = 'ws://127.0.0.1:5178';

      // The daemon is DOWN — irrelevant, because a durable sessionId survives
      // the rename (b506db3): identity is unchanged, so nothing native runs.
      const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', fetchMock);

      const req = Object.assign(new PassThrough(), {
        method: 'POST',
        url: '/api/edit-project-session',
        headers: { 'content-type': 'application/json' }
      }) as unknown as IncomingMessage;
      req.end(JSON.stringify({ projectId: 'proj', groupId: 'g', currentName: 'oldname', session: { name: 'newname', agent: 'codex' } }));
      const chunks: string[] = [];
      const res = {
        statusCode: 0,
        setHeader: () => undefined,
        end: (payload?: unknown) => {
          if (payload !== undefined) chunks.push(String(payload));
        }
      } as unknown as ServerResponse;
      const route = createSessionsRoutes({
        managedAgentLsp: { prepare: vi.fn(), cleanup: vi.fn() } as never,
        nativeAgentLaunch: (spec) => spec,
        agentSurfaceBroker: { disposeSession: vi.fn() }
      });

      await createDeskApiMiddleware([route])(req, res, vi.fn());

      expect(res.statusCode).toBe(200);
      // the rename COMMITTED (identity is durable, no native op was needed)
      const persisted = readFileSync(manifestPath, 'utf8');
      expect(persisted).toContain('name: newname');
      expect(persisted).toContain('sessionId: oldname'); // the durable id survived the rename
      expect(persisted).not.toContain('name: oldname');
      // and the daemon was never consulted — no retire, no provision
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.HOME = savedEnv.HOME;
      if (savedEnv.DESK_ATCH_NATIVE === undefined) delete process.env.DESK_ATCH_NATIVE;
      else process.env.DESK_ATCH_NATIVE = savedEnv.DESK_ATCH_NATIVE;
      if (savedEnv.DESK_DAEMON_URL === undefined) delete process.env.DESK_DAEMON_URL;
      else process.env.DESK_DAEMON_URL = savedEnv.DESK_DAEMON_URL;
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
