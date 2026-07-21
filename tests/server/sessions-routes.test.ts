import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('preserves the actionable startSession failure reason for the API response', async () => {
    const cleanup = vi.fn();
    const plan: TmuxPlanAction[] = [{ type: 'start', session, argv: [] }];
    const result = await runManagedPlan(
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

describe('sessions route native edit fail-closed', () => {
  it('aborts a rename (manifest unchanged, nothing provisioned) when the old identity cannot be retired', async () => {
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
          '            agent: codex'
        ].join('\n') + '\n'
      );
      process.env.HOME = home;
      process.env.DESK_ATCH_NATIVE = '1';
      process.env.DESK_DAEMON_URL = 'ws://127.0.0.1:5178';

      // The daemon rejects the retire → the edit must abort before any write/provision.
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '{"ok":false,"error":"daemon down"}' });
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

      expect(res.statusCode).toBe(500);
      // manifest on disk is untouched — the rename never committed
      const persisted = readFileSync(manifestPath, 'utf8');
      expect(persisted).toContain('name: oldname');
      expect(persisted).not.toContain('name: newname');
      // the retire was attempted, but no provision happened
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes('/control/retire'))).toBe(true);
      expect(urls.some((url) => url.includes('/control/provision'))).toBe(false);
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
