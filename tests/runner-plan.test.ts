import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  atchCommandFor,
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

describe('runPlan atch-native lifecycle', () => {
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
      command: atchCommandFor(plan[0]!.session),
      geometry: { rows: 24, cols: 80 }
    });
    expect(errors).toEqual([]);
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
        env: { DESK_ATCH_SOCKET_ROOT: '/run/desk' },
        probeSession: (path) => path === '/run/desk/terminal-session.sock'
      })
    ).toEqual([{ type: 'preserve', session }]);
  });

  it('uses a zero-byte atch push probe and rejects stale sockets', () => {
    const session = terminalPlan()[0]!.session;
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 1 });
    const options = {
      atchBinPath: '/release/libexec/atch',
      env: { DESK_ATCH_SOCKET_ROOT: '/run/desk' },
      spawn: spawn as never
    };

    expect(runningSessionSet([session], options)).toEqual(new Set(['terminal-session']));
    expect(runningSessionSet([session], options)).toEqual(new Set());
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      '/release/libexec/atch',
      ['push', '/run/desk/terminal-session.sock'],
      expect.objectContaining({ input: '' })
    );
  });

  it('probes the daemon then attaches the shipped binary to the durable socket', async () => {
    const session = terminalPlan()[0]!.session;
    const control = vi.fn().mockResolvedValue({ ok: true, body: { ok: true, lines: [] } });
    const spawn = vi.fn().mockReturnValue({ status: 0 });

    await expect(
      attachSession(session, {
        control,
        spawn: spawn as never,
        atchBinPath: '/release/libexec/atch',
        env: { DESK_ATCH_SOCKET_ROOT: '/run/desk' }
      })
    ).resolves.toBe(0);
    expect(control).toHaveBeenCalledWith('/control/tail', {
      sessionId: 'terminal-session',
      rows: 1,
      offset: 0
    });
    expect(spawn).toHaveBeenCalledWith(
      '/release/libexec/atch',
      ['attach', '/run/desk/terminal-session.sock'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });
});
