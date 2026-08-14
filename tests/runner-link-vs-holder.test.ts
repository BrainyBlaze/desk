// desk#50b — "this daemon has no adopted link" is NOT "no holder is alive".
//
// `/control/moor-status` 404s with `session has no live moor link` exactly
// while THIS daemon holds no adopted ATTACH_ACK descriptor for the session.
// That is a statement about the LINK. Desk used to read it as a statement
// about the HOLDER and answer `stale`, which authorises a start — so every
// surviving session in the window between daemon start and re-adoption, and
// every session whose controller link was lost, looked startable while its
// holder was alive. `desk up` would have double-started them; a session edit
// would have skipped the respawn and left a live holder on the pre-edit
// launch config.
//
// The route now says both things: the link (the 404) and the holder
// (`holder`, a closed vocabulary). Only `holder: 'absent'` — positively
// proven absence — may be read as `stale`.

import { describe, expect, it, vi } from 'vitest';
import { planDeskUp, sessionLivenessMap, startSession } from '../src/core/runner.js';
import { buildSessionSpecs, parseDeskManifest } from '../src/core/manifest.js';
import { MOOR_STATUS_NO_LIVE_LINK_ERROR } from '../src/shared/daemonControlClient.js';
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

/** A daemon answering `/control/moor-status` with a per-session 404 body. */
function daemonAnswering(body: (sessionId: string) => unknown): typeof fetch {
  return vi.fn(async (url: string) => {
    const sessionId = new URL(String(url)).searchParams.get('sessionId') ?? '';
    return {
      ok: false,
      status: 404,
      text: async () => JSON.stringify(body(sessionId))
    };
  }) as unknown as typeof fetch;
}

/** The route's negative envelope, with whatever holder verdict rides on it. */
function noLink(holder?: unknown): Record<string, unknown> {
  return {
    ok: false,
    error: MOOR_STATUS_NO_LIVE_LINK_ERROR,
    ...(holder === undefined ? {} : { holder })
  };
}

describe('a missing adopted link is not a missing holder (desk#50b)', () => {
  it('reads a proven-present holder as indeterminate, never as stale', async () => {
    // The live-machine case: session `qa-claude` had a live holder process and
    // a live child, the agent-state authority reported running/healthy, and
    // this exact 404 came back because the daemon had not re-adopted it yet.
    const fetchImpl = daemonAnswering(() => noLink('present'));

    await expect(
      sessionLivenessMap([sessionSpec('qa-claude')], { fetchImpl })
    ).resolves.toEqual(new Map([['qa-claude', 'indeterminate']]));
  });

  it('reads a silent daemon — no holder field at all — as indeterminate', async () => {
    // A daemon older than this contract 404s without saying anything about the
    // holder. A missing field is not a verdict: reading it as `stale` is the
    // original bug wearing a version skew.
    const fetchImpl = daemonAnswering(() => noLink());

    await expect(
      sessionLivenessMap([sessionSpec('old-daemon')], { fetchImpl })
    ).resolves.toEqual(new Map([['old-daemon', 'indeterminate']]));
  });

  it('still reads a PROVEN-absent holder as stale, so dead sessions can start', async () => {
    // The over-correction guard: a system that can never answer `stale` is a
    // system that can never start anything. Positive absence still authorises.
    const fetchImpl = daemonAnswering(() => noLink('absent'));

    await expect(
      sessionLivenessMap([sessionSpec('really-gone')], { fetchImpl })
    ).resolves.toEqual(new Map([['really-gone', 'stale']]));
  });

  it('treats an unproven or off-vocabulary holder verdict as indeterminate', async () => {
    // `unknown` is the route's own "I could not prove it either way". Anything
    // outside the closed vocabulary did not come from this route at all —
    // including the well-typed lies that a loose truthiness check would read
    // as absence.
    const answers: Record<string, unknown> = {
      'holder-unknown': 'unknown',
      'holder-empty': '',
      'holder-null': null,
      'holder-false': false,
      'holder-bool-true': true,
      'holder-cased': 'ABSENT',
      'holder-padded': ' absent ',
      'holder-object': { state: 'absent' }
    };
    const fetchImpl = daemonAnswering((sessionId) => noLink(answers[sessionId]));

    const liveness = await sessionLivenessMap(
      Object.keys(answers).map(sessionSpec),
      { fetchImpl }
    );

    expect([...liveness]).toEqual(
      Object.keys(answers).map((sessionId) => [sessionId, 'indeterminate'])
    );
  });

  it('never plans a start for a session whose holder is present but unadopted', async () => {
    const surviving = sessionSpec('surviving');
    const dead = sessionSpec('dead');
    const fetchImpl = daemonAnswering((sessionId) =>
      noLink(sessionId === 'surviving' ? 'present' : 'absent')
    );

    await expect(planDeskUp([surviving, dead], { fetchImpl })).resolves.toEqual([
      { type: 'skip', session: surviving },
      { type: 'start', session: dead }
    ]);
  });

  it('refuses to provision over a present-but-unadopted holder', async () => {
    const control = vi.fn();
    const fetchImpl = daemonAnswering(() => noLink('present'));

    await expect(
      startSession(sessionSpec('surviving'), { control, fetchImpl })
    ).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('liveness is unknown')
    });
    expect(control).not.toHaveBeenCalled();
  });
});
