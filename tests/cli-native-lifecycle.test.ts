import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';
import { MOOR_STATUS_NO_LIVE_LINK_ERROR } from '../src/shared/daemonControlClient.js';

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const output: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line = '') => output.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line = '') => errors.push(String(line)));
  return { code: await main(args), stdout: output.join('\n'), stderr: errors.join('\n') };
}

describe('desk CLI native lifecycle', () => {
  let dir: string;
  let manifest: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-cli-native-lifecycle-'));
    manifest = join(dir, 'desk.yml');
    writeFileSync(
      manifest,
      `groups:
  - id: main
    sessions:
      - name: alpha
        cwd: /tmp
        command: bash
        sessionId: alpha
`
    );
    vi.stubEnv('PATH', '');
    vi.stubEnv('DESK_MOOR_BIN', join(dir, 'missing-moor'));
    vi.stubEnv('DESK_MOOR_SOCKET_ROOT', join(dir, 'moor'));
    vi.stubEnv('DESK_DAEMON_URL', 'http://127.0.0.1:5178');
    vi.stubEnv('HOME', dir);
    const defaultManifest = join(dir, '.config', 'desk', 'desk.yml');
    mkdirSync(join(dir, '.config', 'desk'), { recursive: true });
    writeFileSync(defaultManifest, String.raw`groups:
  - id: main
    sessions:
      - name: alpha
        cwd: /tmp
        agent: codex
        resume: 11111111-1111-4111-8111-111111111111
        uiMode: terminal
        sessionId: alpha
`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails attach honestly when the configured moor binary is unavailable', async () => {
    const result = await run(['attach', '--file', manifest, 'alpha']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('DESK_MOOR_BIN is not an executable file');
  });

  it('reports the daemon authority\'s no-link verdict as missing without requiring the binary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          // desk#50b: `missing` needs BOTH — no adopted link, and a holder
          // proven absent. The 404 on its own would print `unknown`.
          JSON.stringify({
            ok: false,
            error: MOOR_STATUS_NO_LIVE_LINK_ERROR,
            holder: 'absent'
          }),
          {
            status: 404,
            headers: { 'content-type': 'application/json' }
          }
        )
      )
    );

    const result = await run(['status', '--file', manifest]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('missing');
    expect(result.stdout).toContain('alpha');
    expect(result.stderr).toBe('');
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:5178/control/moor-status?sessionId=alpha'
    );
  });

  it('captures retained output through the daemon instead of a local multiplexer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, lines: ['one', 'two'], totalAvailable: 2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const result = await run(['capture', '--file', manifest, 'alpha']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(writes.join('')).toBe('one\ntwo\n');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://127.0.0.1:5178/control/tail',
      expect.objectContaining({ body: JSON.stringify({ sessionId: 'alpha', rows: 200, offset: 0 }) })
    );
  });

  it('routes default-manifest up through the web control plane', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ exitCode: 0, actions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    const result = await run(['up', '--dry-run']);

    expect(result.code).toBe(0);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/api/up',
      expect.objectContaining({ body: JSON.stringify({ dryRun: true }) })
    );
  });

  it('refuses provider-session reset without the explicit destructive force flag', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await run(['reset-provider-session', 'alpha']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'reset-provider-session requires --force'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not accept a provider resume id as the destructive reset target', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await run([
      'reset-provider-session',
      '11111111-1111-4111-8111-111111111111',
      '--force'
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'target must be a session name or sessionId'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requests one daemon-owned provider-session reset for the durable Desk id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            authorizationId: 'authorization-1',
            generation: 3,
            state: 'authorized'
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
      )
    );

    const result = await run([
      'reset-provider-session',
      'alpha',
      '--force'
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('authorized one fresh provider launch');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://127.0.0.1:5178/control/provider-session/reset',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sessionId: 'alpha' })
      })
    );
  });

  it('requires --force and --to for explicit provider-session rebind', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(
      (await run(['rebind-provider-session', 'alpha', '--to', '22222222-2222-4222-8222-222222222222'])).stderr
    ).toContain('rebind-provider-session requires --force');
    expect(
      (await run(['rebind-provider-session', 'alpha', '--force'])).stderr
    ).toContain('rebind-provider-session requires --to');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a provider id as the Desk rebind target', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await run([
      'rebind-provider-session',
      '11111111-1111-4111-8111-111111111111',
      '--to',
      '22222222-2222-4222-8222-222222222222',
      '--force'
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('target must be a session name or sessionId');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits only the exact Desk id and target provider id for rebind', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          kind: 'rebound',
          provider: 'codex',
          providerSessionId: '22222222-2222-4222-8222-222222222222'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await run([
      'rebind-provider-session',
      'alpha',
      '--to',
      '22222222-2222-4222-8222-222222222222',
      '--force'
    ]);

    expect(result.code).toBe(0);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      sessionId: 'alpha',
      targetProviderSessionId: '22222222-2222-4222-8222-222222222222'
    });
    expect(String(init.body)).not.toContain('expectedProviderSessionId');
    expect(String(init.body)).not.toContain('11111111-1111-4111-8111-111111111111');
  });

  it('prefers an exact session name when fuzzy neighbors exist', async () => {
    writeFileSync(
      join(dir, '.config', 'desk', 'desk.yml'),
      `groups:
  - id: main
    sessions:
      - name: alpha-worker
        cwd: /tmp
        agent: codex
        resume: 11111111-1111-4111-8111-111111111111
        sessionId: desk-neighbor
      - name: alpha
        cwd: /tmp
        agent: codex
        resume: 11111111-1111-4111-8111-111111111111
        sessionId: desk-exact
`
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          kind: 'rebound',
          provider: 'codex',
          providerSessionId: '22222222-2222-4222-8222-222222222222'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(
      (
        await run([
          'rebind-provider-session',
          'alpha',
          '--to',
          '22222222-2222-4222-8222-222222222222',
          '--force'
        ])
      ).code
    ).toBe(0);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      sessionId: 'desk-exact',
      targetProviderSessionId: '22222222-2222-4222-8222-222222222222'
    });
  });

  it('accepts retry-safe already-rebound success and preserves semantic rejection', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            kind: 'already-rebound',
            provider: 'codex',
            providerSessionId: '22222222-2222-4222-8222-222222222222'
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            reason: 'provider-session-transition-mismatch',
            error: 'requested target is not pending'
          }),
          { status: 409 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    const args = [
      'rebind-provider-session',
      'alpha',
      '--to',
      '22222222-2222-4222-8222-222222222222',
      '--force'
    ];

    expect((await run(args)).code).toBe(0);
    const rejected = await run(args);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('requested target is not pending');
  });
});
