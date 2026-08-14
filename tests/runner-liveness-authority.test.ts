import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  planDeskUp,
  printStatus,
  runPlan,
  sessionLivenessMap,
  startSession
} from '../src/core/runner.js';
import { buildSessionSpecs, parseDeskManifest } from '../src/core/manifest.js';
import type { SessionSpec } from '../src/core/types.js';

function sessionSpec(sessionId: string): SessionSpec {
  return buildSessionSpecs(
    parseDeskManifest(`
projects:
  - id: p
    cwd: /tmp
    groups:
      - id: main
        sessions:
          - name: ${sessionId}
            sessionId: ${sessionId}
            command: bash
`),
    { homeDir: '/tmp' }
  )[0]!;
}

/**
 * A daemon that answers /control/moor-status the way terminalDaemon really
 * does. `text` sends raw bytes instead of JSON, so a proxy's HTML error page
 * can be modelled as faithfully as a well-formed envelope.
 */
function daemonAnswering(
  reply: (sessionId: string) => { status: number; body?: unknown; text?: string } | Error
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    const sessionId = new URL(String(url)).searchParams.get('sessionId') ?? '';
    const answer = reply(sessionId);
    if (answer instanceof Error) {
      throw answer;
    }
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => answer.text ?? JSON.stringify(answer.body)
    };
  });
}

const LIVE = { ok: true, generation: 3, wallStartMs: 1786560739350, pid: 209, running: true };
/** The route's own negative envelope — the only 404 that proves absence. */
const NO_LINK = { ok: false, error: 'session has no live moor link' };

describe('CLI liveness is the daemon authority, not a moor push heuristic (desk#50 / moor#8 §1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks /control/moor-status per session and never spawns a binary to guess', async () => {
    const fetchImpl = daemonAnswering(() => ({ status: 200, body: LIVE }));
    const spawn = vi.fn();

    const liveness = await sessionLivenessMap([sessionSpec('bash-1')], {
      env: { DESK_DAEMON_URL: 'ws://127.0.0.1:5178' },
      fetchImpl: fetchImpl as never,
      spawn: spawn as never
    });

    expect(liveness).toEqual(new Map([['bash-1', 'verified-live']]));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:5178/control/moor-status?sessionId=bash-1'
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('preserves the three states the authority can express, and never collapses them', async () => {
    const answers: Record<string, { status: number; body: unknown } | Error> = {
      // Adopted and running — the case desk#50 reported as missing.
      adopted: { status: 200, body: LIVE },
      // The daemon holds a link but the holder's process is gone.
      exited: { status: 200, body: { ...LIVE, running: false } },
      // The daemon's own negative verdict: no live moor link for this session.
      absent: { status: 404, body: NO_LINK },
      // The daemon answered, but not about liveness.
      confused: { status: 500, body: { ok: false, error: 'boom' } },
      // No daemon at all: unobservable.
      offline: new Error('connect ECONNREFUSED 127.0.0.1:5178')
    };
    const fetchImpl = daemonAnswering((sessionId) => answers[sessionId]!);

    const liveness = await sessionLivenessMap(
      Object.keys(answers).map(sessionSpec),
      { fetchImpl: fetchImpl as never }
    );

    expect(liveness).toEqual(
      new Map([
        ['adopted', 'verified-live'],
        ['exited', 'stale'],
        ['absent', 'stale'],
        ['confused', 'indeterminate'],
        ['offline', 'indeterminate']
      ])
    );
  });

  it('treats a 200 whose descriptor it cannot validate as unknown, never as stale', async () => {
    // `stale` authorises a start. A 200 that does not carry a descriptor Desk
    // can actually read is not evidence the session is gone — it is evidence
    // Desk is talking to something it does not understand, and starting there
    // would spawn a second holder on top of a live one.
    const answers: Record<string, { status: number; body?: unknown; text?: string }> = {
      // `ok:true` and nothing else: no `running` field at all.
      'no-running': { status: 200, body: { ok: true } },
      // `running` present but the wrong type — a truthy string that a lazy
      // check would read as "not true" and call stale.
      'string-running': { status: 200, body: { ...LIVE, running: 'false' } },
      'string-running-true': { status: 200, body: { ...LIVE, running: 'true' } },
      // A descriptor missing the generation fence / clock / pid it claims.
      'no-generation': { status: 200, body: { ok: true, wallStartMs: 1786560739350, pid: 209, running: true } },
      'bad-wall-start': { status: 200, body: { ...LIVE, wallStartMs: 'soon' } },
      'no-pid': { status: 200, body: { ok: true, generation: 3, wallStartMs: 1786560739350, running: true } },
      // A 200 from something that is not this route at all.
      'other-service': { status: 200, body: { ok: true, status: 'healthy' } }
    };
    const fetchImpl = daemonAnswering((sessionId) => answers[sessionId]!);

    const liveness = await sessionLivenessMap(Object.keys(answers).map(sessionSpec), {
      fetchImpl: fetchImpl as never
    });

    expect([...liveness.values()]).toEqual(Object.keys(answers).map(() => 'indeterminate'));
  });

  it('rejects descriptor numbers moor could not have produced, in both directions', async () => {
    // The types were right and the values were impossible. moor decodes
    // `generation` and `pid` from u32 fields and refuses a descriptor where
    // either is zero (decodeStatus, `invalid status descriptor`), so on the
    // wire both are positive integers; `wallStart` is a u64 the route converts
    // with Number(), so it is a nonnegative integer Desk can hold exactly.
    // A body that satisfies the SHAPE but not the CONTRACT — the trivially
    // forgeable `{ok:true, generation:-1, wallStartMs:-1, pid:-1,
    // running:false}` among them — is not this route's descriptor, and reading
    // it as `stale` would authorise a start on top of a live holder.
    //
    // Every case is asked twice, because both verdicts are dangerous: a bad
    // `running:false` fabricates a licence to start, and a bad `running:true`
    // fabricates a live session that nothing will ever start.
    const UNSAFE = Number.MAX_SAFE_INTEGER + 1;
    const outOfContract: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['generation-negative', { generation: -1 }],
      ['generation-zero', { generation: 0 }],
      ['generation-fractional', { generation: 1.5 }],
      ['generation-unsafe', { generation: UNSAFE }],
      ['pid-negative', { pid: -1 }],
      ['pid-zero', { pid: 0 }],
      ['pid-fractional', { pid: 1.5 }],
      ['pid-unsafe', { pid: UNSAFE }],
      ['wall-start-negative', { wallStartMs: -1 }],
      ['wall-start-fractional', { wallStartMs: 1.5 }],
      ['wall-start-unsafe', { wallStartMs: UNSAFE }],
      // The whole shape at once: the exact body the review forged.
      ['all-negative', { generation: -1, wallStartMs: -1, pid: -1 }]
    ];
    const answers: Record<string, { status: number; body: unknown }> = {};
    for (const [label, patch] of outOfContract) {
      answers[`${label}-claiming-running`] = { status: 200, body: { ...LIVE, ...patch, running: true } };
      answers[`${label}-claiming-exited`] = { status: 200, body: { ...LIVE, ...patch, running: false } };
    }
    const fetchImpl = daemonAnswering((sessionId) => answers[sessionId]!);

    const liveness = await sessionLivenessMap(Object.keys(answers).map(sessionSpec), {
      fetchImpl: fetchImpl as never
    });

    // Named, so a regression says which value slipped through and as what.
    expect([...liveness].filter(([, verdict]) => verdict !== 'indeterminate')).toEqual([]);
  });

  it('reads only the route\'s own 200 as a descriptor, never another 2xx', async () => {
    // `/control/moor-status` answers a validated descriptor with 200 and
    // nothing else. A 202 or 204 carrying a perfect body did not come from
    // this route — it came from something in between that decided to answer
    // for it — so it proves nothing about the session either way.
    const answers: Record<string, { status: number; body: unknown }> = {
      accepted: { status: 202, body: LIVE },
      'accepted-exited': { status: 202, body: { ...LIVE, running: false } },
      'no-content': { status: 204, body: LIVE },
      'no-content-exited': { status: 204, body: { ...LIVE, running: false } },
      'non-authoritative': { status: 203, body: { ...LIVE, running: false } }
    };
    const fetchImpl = daemonAnswering((sessionId) => answers[sessionId]!);

    const liveness = await sessionLivenessMap(Object.keys(answers).map(sessionSpec), {
      fetchImpl: fetchImpl as never
    });

    expect([...liveness].filter(([, verdict]) => verdict !== 'indeterminate')).toEqual([]);
  });

  it('accepts the values the contract really permits, and tolerates unknown keys', async () => {
    // The bound on `wallStartMs` is nonnegative, not positive: moor's decoder
    // fences `generation` and `pid` against zero and nothing fences the start
    // clock, so rejecting zero there would be Desk inventing an invariant its
    // authority does not hold. Zero is accepted deliberately.
    //
    // Unknown keys are tolerated deliberately too — see `adoptedMoorDescriptor`.
    const fetchImpl = daemonAnswering((sessionId) =>
      sessionId === 'zero-clock'
        ? { status: 200, body: { ...LIVE, wallStartMs: 0 } }
        : sessionId === 'future-daemon'
          ? { status: 200, body: { ...LIVE, incarnation: 'abc', leaseEpoch: 4 } }
          : { status: 200, body: { ...LIVE, wallStartMs: 0, running: false } }
    );

    await expect(
      sessionLivenessMap(
        [sessionSpec('zero-clock'), sessionSpec('future-daemon'), sessionSpec('zero-clock-exited')],
        { fetchImpl: fetchImpl as never }
      )
    ).resolves.toEqual(
      new Map([
        ['zero-clock', 'verified-live'],
        ['future-daemon', 'verified-live'],
        ['zero-clock-exited', 'stale']
      ])
    );
  });

  it('treats a 404 that is not the route\'s own negative envelope as unknown, never as stale', async () => {
    // A 404 also comes from an older daemon with no /control/moor-status route
    // and from any proxy in between. Neither has said anything about this
    // session, so neither may authorise a start.
    const answers: Record<string, { status: number; body?: unknown; text?: string }> = {
      // A generic proxy / old daemon: an HTML error page, not an envelope.
      html: { status: 404, text: '<!doctype html><html><body>404 Not Found</body></html>' },
      // Well-formed JSON that says nothing about a moor link.
      'unrelated-json': { status: 404, body: { ok: false, error: 'Not Found' } },
      'no-route': { status: 404, body: { ok: false, error: 'unknown control path' } },
      // The right words, but claimed as a success — not this route's negative.
      'ok-true': { status: 404, body: { ok: true, error: 'session has no live moor link' } },
      // Empty body: a bare status line and nothing else.
      empty: { status: 404, text: '' }
    };
    const fetchImpl = daemonAnswering((sessionId) => answers[sessionId]!);

    const liveness = await sessionLivenessMap(Object.keys(answers).map(sessionSpec), {
      fetchImpl: fetchImpl as never
    });

    expect([...liveness.values()]).toEqual(Object.keys(answers).map(() => 'indeterminate'));
  });

  it('still reads the two honest answers: a valid descriptor and the route\'s own 404', async () => {
    const fetchImpl = daemonAnswering((sessionId) =>
      sessionId === 'live'
        ? { status: 200, body: LIVE }
        : sessionId === 'exited'
          ? { status: 200, body: { ...LIVE, running: false } }
          : { status: 404, body: NO_LINK }
    );

    await expect(
      sessionLivenessMap([sessionSpec('live'), sessionSpec('exited'), sessionSpec('absent')], {
        fetchImpl: fetchImpl as never
      })
    ).resolves.toEqual(
      new Map([
        ['live', 'verified-live'],
        ['exited', 'stale'],
        ['absent', 'stale']
      ])
    );
  });

  it('never plans a start on an unproven answer, and never calls that run a success', async () => {
    const malformed = sessionSpec('malformed');
    const proxied = sessionSpec('proxied');
    const control = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = daemonAnswering((sessionId) =>
      sessionId === 'malformed'
        ? { status: 200, body: { ok: true } }
        : { status: 404, text: '<html>404</html>' }
    ) as never;

    const plan = await planDeskUp([malformed, proxied], { fetchImpl });
    expect(plan).toEqual([
      { type: 'skip', session: malformed },
      { type: 'skip', session: proxied }
    ]);
    await expect(runPlan(plan, false, { control, fetchImpl })).resolves.toBe(1);
    await expect(startSession(malformed, { control, fetchImpl })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('liveness is unknown')
    });
    expect(control).not.toHaveBeenCalled();
  });

  it('reports an adopted session as running and an unreachable daemon as unknown', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line = '') => lines.push(String(line)));

    await printStatus([sessionSpec('bash-1')], {
      fetchImpl: daemonAnswering(() => ({ status: 200, body: LIVE })) as never
    });
    await printStatus([sessionSpec('bash-1')], {
      fetchImpl: daemonAnswering(() => new Error('connect ECONNREFUSED')) as never
    });
    await printStatus([sessionSpec('bash-1')], {
      fetchImpl: daemonAnswering(() => ({
        status: 404,
        body: NO_LINK
      })) as never
    });

    expect(lines.map((line) => line.split(/\s+/)[0])).toEqual(['running', 'unknown', 'missing']);
  });

  it('plans start only on a proven-absent session, never on an unknown one', async () => {
    const live = sessionSpec('adopted');
    const absent = sessionSpec('absent');
    const unknown = sessionSpec('offline');
    const fetchImpl = daemonAnswering((sessionId) =>
      sessionId === 'adopted'
        ? { status: 200, body: LIVE }
        : sessionId === 'absent'
          ? { status: 404, body: NO_LINK }
          : new Error('connect ECONNREFUSED')
    );

    await expect(
      planDeskUp([live, absent, unknown], { fetchImpl: fetchImpl as never })
    ).resolves.toEqual([
      { type: 'preserve', session: live },
      { type: 'start', session: absent },
      { type: 'skip', session: unknown }
    ]);
  });

  it('never provisions on an unknown verdict, and never calls that run a success', async () => {
    const session = sessionSpec('offline');
    const control = vi.fn();
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((line = '') => errors.push(String(line)));
    const fetchImpl = daemonAnswering(() => new Error('connect ECONNREFUSED')) as never;

    await expect(
      runPlan([{ type: 'skip', session }], false, { control, fetchImpl })
    ).resolves.toBe(1);
    await expect(startSession(session, { control, fetchImpl })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('liveness is unknown')
    });
    expect(control).not.toHaveBeenCalled();
    expect(errors.join(' ')).toContain('liveness is unknown');
  });
});
