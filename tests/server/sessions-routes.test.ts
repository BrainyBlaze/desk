import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionPlanAction, SessionSpec } from '../../src/core/types.js';
import { parseDeskManifest } from '../../src/core/manifest.js';
import { createDeskApiMiddleware } from '../../src/server/deskApiRouter.js';
import {
  commitManifestIfUnchanged,
  createSessionsRoutes,
  readDeskSessionBody,
  runManagedPlan
} from '../../src/server/routes/sessionsRoutes.js';
import { MOOR_STATUS_NO_LIVE_LINK_ERROR } from '../../src/shared/daemonControlClient.js';

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

async function invokeGlobalProviderAdd(
  onProvision: (manifestPath: string) => Response | Promise<Response>
): Promise<{ statusCode: number; payload: Record<string, unknown>; manifestSource: string }> {
  const home = mkdtempSync(join(tmpdir(), 'desk-add-provider-home-'));
  const work = mkdtempSync(join(tmpdir(), 'desk-add-provider-work-'));
  const savedHome = process.env.HOME;
  const savedDaemonUrl = process.env.DESK_DAEMON_URL;
  try {
    const configDir = join(home, '.config', 'desk');
    mkdirSync(configDir, { recursive: true });
    const manifestPath = join(configDir, 'desk.yml');
    writeFileSync(
      manifestPath,
      'groups:\n  - id: main\n    label: Main\n    sessions: []\n'
    );
    process.env.HOME = home;
    process.env.DESK_DAEMON_URL = 'http://127.0.0.1:43131';
    vi.stubGlobal('fetch', vi.fn(() => onProvision(manifestPath)));

    const req = Object.assign(new PassThrough(), {
      method: 'POST',
      url: '/api/add',
      headers: { 'content-type': 'application/json' }
    }) as unknown as IncomingMessage;
    req.end(
      JSON.stringify({
        groupId: 'main',
        session: { name: 'new-agent', cwd: work, agent: 'codex' }
      })
    );
    const chunks: string[] = [];
    const res = {
      statusCode: 0,
      setHeader: () => undefined,
      end: (payload?: unknown) => {
        if (payload !== undefined) chunks.push(String(payload));
      }
    } as unknown as ServerResponse;
    const route = createSessionsRoutes({
      managedAgentLsp: { prepare: () => undefined } as never,
      nativeAgentLaunch: (spec) => spec,
      agentSurfaceBroker: { disposeSession: vi.fn() }
    });

    await createDeskApiMiddleware([route])(req, res, vi.fn());
    return {
      statusCode: res.statusCode,
      payload: JSON.parse(chunks.join('')) as Record<string, unknown>,
      manifestSource: readFileSync(manifestPath, 'utf8')
    };
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDaemonUrl === undefined) delete process.env.DESK_DAEMON_URL;
    else process.env.DESK_DAEMON_URL = savedDaemonUrl;
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

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
          bypassPermissions: true
        },
        { cwdRequired: false }
      )
    ).toEqual({
      name: 'custom-agent',
      command: 'claude-wrapper',
      agent: 'claude',
      bypassPermissions: true
    });
  });

  it('rejects resume ids for custom-command sessions', () => {
    expect(() =>
      readDeskSessionBody(
        {
          name: 'custom-agent',
          command: 'claude-wrapper',
          agent: 'claude',
          resume: '11111111-1111-4111-8111-111111111111'
        },
        { cwdRequired: false }
      )
    ).toThrow(/managed provider/);
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

  it('rejects generic resume clearing and names the explicit reset command', async () => {
    const req = Object.assign(new PassThrough(), {
      method: 'POST',
      url: '/api/edit-project-session',
      headers: { 'content-type': 'application/json' }
    }) as unknown as IncomingMessage;
    req.end(
      JSON.stringify({
        projectId: 'proj',
        groupId: 'main',
        currentName: 'agent',
        session: {
          name: 'agent',
          agent: 'codex',
          clearResume: true
        }
      })
    );
    const chunks: string[] = [];
    const res = {
      statusCode: 0,
      setHeader: () => undefined,
      end: (payload?: unknown) => {
        if (payload !== undefined) chunks.push(String(payload));
      }
    } as unknown as ServerResponse;
    const route = createSessionsRoutes({
      managedAgentLsp: {} as never,
      nativeAgentLaunch: (spec) => spec,
      agentSurfaceBroker: { disposeSession: vi.fn() }
    });

    await createDeskApiMiddleware([route])(req, res, vi.fn());

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(chunks.join(''))).toEqual({
      ok: false,
      code: 'provider-session-reset-required',
      error:
        'provider session identity can only be cleared with desk reset-provider-session <name-or-session-id> --force'
    });
  });
});

describe('sessions route provider add transaction', () => {
  it('commits the new provider session before asking the daemon to provision it', async () => {
    let visibleDuringProvision = false;
    const result = await invokeGlobalProviderAdd((manifestPath) => {
      visibleDuringProvision = readFileSync(manifestPath, 'utf8').includes(
        'name: new-agent'
      );
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    expect(result.statusCode).toBe(200);
    expect(visibleDuringProvision).toBe(true);
    expect(result.manifestSource).toContain('name: new-agent');
  });

  it('rolls back the exact manifest commit when provisioning fails', async () => {
    let visibleDuringProvision = false;
    const result = await invokeGlobalProviderAdd((manifestPath) => {
      visibleDuringProvision = readFileSync(manifestPath, 'utf8').includes(
        'name: new-agent'
      );
      return new Response(
        JSON.stringify({ ok: false, error: 'provision rejected' }),
        { status: 409 }
      );
    });

    expect(result.statusCode).toBe(500);
    expect(visibleDuringProvision).toBe(true);
    expect(result.manifestSource).not.toContain('name: new-agent');
  });

  it('does not overwrite a concurrent manifest edit when failed provision cannot roll back', async () => {
    const result = await invokeGlobalProviderAdd((manifestPath) => {
      const committed = readFileSync(manifestPath, 'utf8');
      writeFileSync(manifestPath, `${committed}settings:\n  theme: dark\n`);
      return new Response(
        JSON.stringify({ ok: false, error: 'provision rejected' }),
        { status: 409 }
      );
    });

    expect(result.statusCode).toBe(500);
    expect(result.manifestSource).toContain('name: new-agent');
    expect(result.manifestSource).toContain('theme: dark');
    expect(result.payload.error).toMatch(/rollback skipped.*changed concurrently/);
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

describe('sessions route Claude profile continuity', () => {
  it('rejects a prepared profile edit when the manifest changed concurrently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-profile-edit-cas-'));
    const manifestPath = join(root, 'desk.yml');
    const original = 'groups: []\n';
    const concurrent = 'groups: []\nsettings:\n  theme: dark\n';
    try {
      writeFileSync(manifestPath, original);
      writeFileSync(manifestPath, concurrent);

      await expect(
        commitManifestIfUnchanged(
          manifestPath,
          original,
          parseDeskManifest('groups: []\n')
        )
      ).rejects.toThrow('manifest-changed-concurrently');
      expect(readFileSync(manifestPath, 'utf8')).toBe(concurrent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a Claude profile change without a resume id before committing the manifest', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-profile-edit-home-'));
    const work = mkdtempSync(join(tmpdir(), 'desk-profile-edit-work-'));
    const previousHome = process.env.HOME;
    try {
      mkdirSync(join(home, '.config', 'desk'), { recursive: true });
      const manifestPath = join(home, '.config', 'desk', 'desk.yml');
      writeFileSync(
        manifestPath,
        [
          'profiles:',
          '  - id: source',
          '    provider: claude',
          '    label: Source',
          '  - id: target',
          '    provider: claude',
          '    label: Target',
          'projects:',
          '  - id: proj',
          '    label: Proj',
          `    cwd: ${work}`,
          '    groups:',
          '      - id: g',
          '        label: G',
          '        sessions:',
          '          - name: chat',
          '            agent: claude',
          '            sessionId: desk-chat',
          '            profileId: source',
          '            uiMode: terminal'
        ].join('\n') + '\n'
      );
      process.env.HOME = home;

      const req = Object.assign(new PassThrough(), {
        method: 'POST',
        url: '/api/edit-project-session',
        headers: { 'content-type': 'application/json' }
      }) as unknown as IncomingMessage;
      req.end(
        JSON.stringify({
          projectId: 'proj',
          groupId: 'g',
          currentName: 'chat',
          session: { name: 'chat', agent: 'claude', profileId: 'target' }
        })
      );
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
      expect(chunks.join('')).toContain('continuity-no-resume-id');
      const persisted = readFileSync(manifestPath, 'utf8');
      expect(persisted).toContain('profileId: source');
      expect(persisted).not.toContain('profileId: target');
    } finally {
      process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('materializes a stopped session in the target profile before committing the profile edit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-profile-edit-home-'));
    const work = mkdtempSync(join(tmpdir(), 'desk-profile-edit-work-'));
    const previousHome = process.env.HOME;
    const previousDaemonUrl = process.env.DESK_DAEMON_URL;
    try {
      mkdirSync(join(home, '.config', 'desk'), { recursive: true });
      const manifestPath = join(home, '.config', 'desk', 'desk.yml');
      const providerSessionId = '11111111-2222-4333-8444-555555555555';
      writeFileSync(
        manifestPath,
        [
          'profiles:',
          '  - id: source',
          '    provider: claude',
          '    label: Source',
          '  - id: target',
          '    provider: claude',
          '    label: Target',
          'projects:',
          '  - id: proj',
          '    label: Proj',
          `    cwd: ${work}`,
          '    groups:',
          '      - id: g',
          '        label: G',
          '        sessions:',
          '          - name: chat',
          '            agent: claude',
          '            sessionId: desk-chat',
          `            resume: ${providerSessionId}`,
          '            profileId: source',
          '            uiMode: terminal'
        ].join('\n') + '\n'
      );
      const projectSlug = work.replace(/[^A-Za-z0-9._-]/g, '-');
      const sourceTranscript = join(
        home,
        '.config',
        'desk',
        'profiles',
        'source',
        'projects',
        projectSlug,
        `${providerSessionId}.jsonl`
      );
      mkdirSync(join(sourceTranscript, '..'), { recursive: true });
      writeFileSync(sourceTranscript, 'conversation');
      process.env.HOME = home;
      process.env.DESK_DAEMON_URL = 'http://127.0.0.1:5178';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ ok: false, error: MOOR_STATUS_NO_LIVE_LINK_ERROR }),
            {
              status: 404,
              headers: { 'content-type': 'application/json' }
            }
          )
        )
      );

      const req = Object.assign(new PassThrough(), {
        method: 'POST',
        url: '/api/edit-project-session',
        headers: { 'content-type': 'application/json' }
      }) as unknown as IncomingMessage;
      req.end(
        JSON.stringify({
          projectId: 'proj',
          groupId: 'g',
          currentName: 'chat',
          session: { name: 'chat', agent: 'claude', profileId: 'target' }
        })
      );
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

      expect(res.statusCode, chunks.join('')).toBe(200);
      const targetTranscript = join(
        home,
        '.config',
        'desk',
        'profiles',
        'target',
        'projects',
        projectSlug,
        `${providerSessionId}.jsonl`
      );
      expect(readFileSync(targetTranscript, 'utf8')).toBe('conversation');
      expect(statSync(targetTranscript).ino).toBe(statSync(sourceTranscript).ino);
      expect(readFileSync(manifestPath, 'utf8')).toContain('profileId: target');
      expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
        'http://127.0.0.1:5178/control/moor-status?sessionId=desk-chat'
      );
    } finally {
      process.env.HOME = previousHome;
      if (previousDaemonUrl === undefined) delete process.env.DESK_DAEMON_URL;
      else process.env.DESK_DAEMON_URL = previousDaemonUrl;
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
