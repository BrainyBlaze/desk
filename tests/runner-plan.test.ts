import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  moorCommandFor,
  attachSession,
  planDeskUp,
  restartSession,
  runPlan,
  runningSessionSet,
  startSession
} from '../src/core/runner.js';
import { buildSessionSpecs, parseDeskManifest } from '../src/core/manifest.js';
import type { SessionPlanAction } from '../src/core/types.js';

function terminalPlan(): SessionPlanAction[] {
  const spec = buildSessionSpecs(
    parseDeskManifest(`
projects:
  - id: p
    cwd: /tmp
    groups:
      - id: g
        sessions:
          - name: n
            sessionId: terminal-session
            command: bash
`),
    { homeDir: '/tmp' }
  )[0]!;
  return [{ type: 'start', session: spec }];
}

describe('runPlan moor-native lifecycle', () => {
  let errors: string[];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('provisions a missing session through the daemon with the durable identity', async () => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((line = '') => errors.push(String(line)));
    const control = vi.fn().mockResolvedValue({ ok: true });
    const plan = terminalPlan();

    await expect(runPlan(plan, false, { control })).resolves.toBe(0);
    expect(control).toHaveBeenCalledWith('/control/provision', {
      sessionId: 'terminal-session',
      command: moorCommandFor(plan[0]!.session),
      geometry: { rows: 24, cols: 80 },
      subject: { kind: 'terminal' }
    });
    expect(errors).toEqual([]);
  });

  it('passes Claude continuity ownership through the CLI provision path', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const control = vi.fn().mockResolvedValue({ ok: true });
    const spec = {
      ...terminalPlan()[0]!.session,
      agent: 'claude' as const,
      customCommand: false,
      resume: '11111111-2222-4333-8444-555555555555',
      profileId: 'work'
    };

    await expect(runPlan([{ type: 'start', session: spec }], false, { control })).resolves.toBe(0);

    expect(control).toHaveBeenCalledWith(
      '/control/provision',
      expect.objectContaining({
        providerSessionId: spec.resume,
        continuity: {
          schemaVersion: 1,
          provider: 'claude',
          providerSessionId: spec.resume,
          cwd: spec.cwd,
          profileId: 'work'
        },
        claudeMemory: {
          schemaVersion: 1,
          provider: 'claude',
          cwd: spec.cwd,
          profileId: 'work'
        }
      })
    );
  });

  it('passes the exact Codex resume id as provider fence input', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const control = vi.fn().mockResolvedValue({ ok: true });
    const spec = {
      ...terminalPlan()[0]!.session,
      agent: 'codex' as const,
      customCommand: false,
      resume: '11111111-2222-4333-8444-555555555555'
    };

    await expect(
      runPlan([{ type: 'start', session: spec }], false, { control })
    ).resolves.toBe(0);

    expect(control).toHaveBeenCalledWith(
      '/control/provision',
      expect.objectContaining({ providerSessionId: spec.resume })
    );
  });

  it('passes Claude profile memory ownership without requiring a resume id', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const control = vi.fn().mockResolvedValue({ ok: true });
    const spec = {
      ...terminalPlan()[0]!.session,
      agent: 'claude' as const,
      customCommand: false,
      profileId: 'work'
    };

    await expect(runPlan([{ type: 'start', session: spec }], false, { control })).resolves.toBe(0);

    const payload = control.mock.calls[0]?.[1];
    expect(payload).toMatchObject({
      claudeMemory: {
        schemaVersion: 1,
        provider: 'claude',
        cwd: spec.cwd,
        profileId: 'work'
      }
    });
    expect(payload).not.toHaveProperty('continuity');
  });

  it('fails honestly when the daemon cannot provision the session', async () => {
    errors = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((line = '') => errors.push(String(line)));
    const control = vi.fn().mockResolvedValue({ ok: false, error: 'terminal daemon unreachable' });

    await expect(runPlan(terminalPlan(), false, { control })).resolves.toBe(1);
    expect(errors.join(' ')).toContain('terminal daemon unreachable');
  });

  it('dry-run prints the plan without contacting the daemon', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const control = vi.fn();

    await expect(runPlan(terminalPlan(), true, { control })).resolves.toBe(0);
    expect(control).not.toHaveBeenCalled();
  });

  it('refuses direct native provisioning before contacting the daemon', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((line = '') => errors.push(String(line)));
    const control = vi.fn();
    const plan = terminalPlan();
    plan[0] = {
      ...plan[0]!,
      session: { ...plan[0]!.session, uiMode: 'native' }
    };

    await expect(runPlan(plan, false, { control })).resolves.toBe(1);
    expect(control).not.toHaveBeenCalled();
    expect(errors.join(' ')).toContain('needs a running desk server');
  });

  it('keeps direct start and restart helpers from launching unenriched native commands', async () => {
    const session = { ...terminalPlan()[0]!.session, uiMode: 'native' as const };
    const control = vi.fn();

    await expect(startSession(session, { control })).resolves.toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('needs a running desk server') })
    );
    await expect(restartSession(session, { control })).resolves.toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('needs a running desk server') })
    );
    expect(control).not.toHaveBeenCalled();
  });

  it('preserves only sessions whose durable master probe succeeds', () => {
    const plan = terminalPlan();
    const session = plan[0]!.session;

    expect(
      planDeskUp([session], {
        env: { DESK_MOOR_SOCKET_ROOT: '/run/desk' },
        probeSession: (path) => path === '/run/desk/terminal-session'
      })
    ).toEqual([{ type: 'preserve', session }]);
  });

  it('uses a zero-byte moor push probe and rejects stale sockets', () => {
    const session = terminalPlan()[0]!.session;
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 1 });
    const options = {
      moorBinPath: '/release/libexec/moor',
      env: { DESK_MOOR_SOCKET_ROOT: '/run/desk' },
      spawn: spawn as never
    };

    expect(runningSessionSet([session], options)).toEqual(new Set(['terminal-session']));
    expect(runningSessionSet([session], options)).toEqual(new Set());
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      '/release/libexec/moor',
      ['push', '/run/desk/terminal-session'],
      expect.objectContaining({ input: '' })
    );
  });

  it('reads the probe ANSWER, so an adopted session is not reported missing', () => {
    // Answers taken from the real holder (moor 237a62c) during manual QA. A
    // session the daemon has adopted refuses the push because the daemon holds
    // the input lease, and exits 1 — byte-identical in status to an absent
    // session. Classifying by exit code alone reported every healthy adopted
    // session as missing (`desk status` showed all sessions missing while
    // /control/moor-status answered running:true).
    const session = terminalPlan()[0]!.session;
    const answer = (status: number, stderr: string) => ({ status, stderr });
    const options = (spawn: unknown) => ({
      moorBinPath: '/release/libexec/moor',
      env: { DESK_MOOR_SOCKET_ROOT: '/run/desk' },
      spawn: spawn as never
    });

    // Adopted and healthy — a holder answered, only the lease was busy.
    expect(
      runningSessionSet([session], options(vi.fn().mockReturnValue(answer(1, 'moor: input lease is busy\n'))))
    ).toEqual(new Set(['terminal-session']));

    // The one proof of absence.
    expect(
      runningSessionSet(
        [session],
        options(vi.fn().mockReturnValue(answer(1, "moor: session '/run/desk/terminal-session' does not exist\n")))
      )
    ).toEqual(new Set());

    // The probe itself could not run — unobservable is never claimed alive.
    expect(
      runningSessionSet([session], options(vi.fn().mockReturnValue({ error: new Error('ENOENT'), status: null })))
    ).toEqual(new Set());
  });

  it('probes the daemon then attaches the shipped binary to the durable socket', async () => {
    const session = terminalPlan()[0]!.session;
    const control = vi.fn().mockResolvedValue({ ok: true, body: { ok: true, lines: [] } });
    const spawn = vi.fn().mockReturnValue({ status: 0 });

    await expect(
      attachSession(session, {
        control,
        spawn: spawn as never,
        moorBinPath: '/release/libexec/moor',
        env: { DESK_MOOR_SOCKET_ROOT: '/run/desk' }
      })
    ).resolves.toBe(0);
    expect(control).toHaveBeenCalledWith('/control/tail', {
      sessionId: 'terminal-session',
      rows: 1,
      offset: 0
    });
    expect(spawn).toHaveBeenCalledWith(
      '/release/libexec/moor',
      ['attach', '/run/desk/terminal-session'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });
});
