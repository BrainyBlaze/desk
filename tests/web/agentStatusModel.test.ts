import { describe, expect, it } from 'vitest';
import {
  NO_SNAPSHOT_VIEW,
  actionableSessions,
  sessionStatusView
} from '../../src/web/agentStatusModel.js';
import type { SessionStateSnapshot } from '../../src/shared/controlPlane/index.js';

const AT = 1_760_000_000_000;

function snapshot(overrides: Partial<SessionStateSnapshot> = {}): SessionStateSnapshot {
  return {
    schemaVersion: 3,
    revision: 1,
    sessionId: 'work-claude',
    generation: 2,
    lifecycle: 'running',
    lifecycleSince: AT,
    exit: null,
    health: { status: 'healthy', since: AT },
    delivery: null,
    policy: { paused: false, since: AT },
    subject: {
      kind: 'agent',
      provider: 'claude',
      mode: 'terminal',
      producer: 'claude-hooks',
      activity: 'idle',
      activitySince: AT,
      wait: null,
      evidence: null
    },
    updatedAt: AT,
    ...overrides
  } as SessionStateSnapshot;
}

function agentSnapshot(
  activity: 'working' | 'idle' | 'blocked' | 'unknown',
  wait: { kind: string; owner: 'operator' | 'provider' | 'desk'; detail?: string; since: number } | null = null,
  overrides: Partial<SessionStateSnapshot> = {}
): SessionStateSnapshot {
  const base = snapshot(overrides);
  return {
    ...base,
    subject: { ...(base.subject as Record<string, unknown>), activity, wait }
  } as SessionStateSnapshot;
}

describe('a session with no snapshot reads unknown, never idle', () => {
  it('reports unknown rather than inventing a resting agent', () => {
    // The authority not knowing a session is a fact about Desk, not about the
    // agent. A confident `idle` here is the defect this rebuild exists to kill.
    expect(sessionStatusView(undefined)).toBe(NO_SNAPSHOT_VIEW);
    expect(NO_SNAPSHOT_VIEW.agent?.tone).toBe('unknown');
    expect(NO_SNAPSHOT_VIEW.agent?.actionable).toBe(false);
  });
});

describe('activity renders as itself', () => {
  it('shows a working turn as working', () => {
    expect(sessionStatusView(agentSnapshot('working')).agent).toMatchObject({
      tone: 'working',
      label: 'working',
      actionable: false
    });
  });

  it('shows a finished turn as idle', () => {
    expect(sessionStatusView(agentSnapshot('idle')).agent).toMatchObject({ tone: 'idle', actionable: false });
  });

  it('shows a session with no evidence as unknown', () => {
    expect(sessionStatusView(agentSnapshot('unknown')).agent).toMatchObject({ tone: 'unknown', actionable: false });
  });
});

describe('only the operator interrupts the operator', () => {
  it('lights for an approval and names what is being approved', () => {
    const view = sessionStatusView(
      agentSnapshot('blocked', { kind: 'approval', owner: 'operator', detail: 'Bash(rm -rf)', since: AT })
    );
    expect(view.agent).toMatchObject({
      tone: 'attention',
      label: 'needs approval',
      detail: 'Bash(rm -rf)',
      actionable: true
    });
  });

  it('names each operator-owned block in words the operator can act on', () => {
    const labelFor = (kind: string): string | undefined =>
      sessionStatusView(agentSnapshot('blocked', { kind, owner: 'operator', since: AT })).agent?.label;
    expect(labelFor('input')).toBe('needs input');
    expect(labelFor('auth')).toBe('needs sign-in');
    expect(labelFor('billing')).toBe('needs billing');
    expect(labelFor('something-new')).toBe('needs you: something-new');
  });

  it('does NOT light for a provider wait — a rate limit is not the operator to clear', () => {
    const view = sessionStatusView(
      agentSnapshot('blocked', { kind: 'rate-limit', owner: 'provider', detail: 'slow down', since: AT })
    );
    expect(view.agent).toMatchObject({ tone: 'waiting', actionable: false });
    expect(view.agent?.label).toContain('rate-limit');
  });

  it('does not light for a Desk-owned hold either', () => {
    const view = sessionStatusView(agentSnapshot('blocked', { kind: 'lease', owner: 'desk', since: AT }));
    expect(view.agent?.actionable).toBe(false);
  });

  it('surfaces a contract violation instead of hiding it behind a guess', () => {
    // wait is required whenever activity is blocked; if it is missing, say so.
    const view = sessionStatusView(agentSnapshot('blocked', null));
    expect(view.agent).toMatchObject({ tone: 'unknown', detail: 'no wait recorded', actionable: false });
  });
});

describe('a dead process outranks every activity reading', () => {
  it('never shows a killed session as working', () => {
    const view = sessionStatusView(
      agentSnapshot('working', null, {
        lifecycle: 'exited',
        exit: { at: AT, code: null, signal: 'SIGKILL' }
      })
    );
    expect(view.exited).toBe(true);
    expect(view.agent).toMatchObject({ label: 'exited', detail: 'killed by SIGKILL', actionable: false });
    expect(view.agent?.tone).not.toBe('working');
  });

  it('reports a clean exit code when there was no signal', () => {
    const view = sessionStatusView(
      agentSnapshot('idle', null, { lifecycle: 'exited', exit: { at: AT, code: 0, signal: null } })
    );
    expect(view.agent?.detail).toBe('exit 0');
  });
});

describe('non-agent sessions have no activity axis at all', () => {
  it('renders no agent view for a plain terminal', () => {
    const view = sessionStatusView(snapshot({ subject: { kind: 'terminal' } } as Partial<SessionStateSnapshot>));
    // Not `unknown` — a shell has no notion of a turn, and a badge that means
    // nothing teaches the operator to stop reading badges.
    expect(view.agent).toBeNull();
    expect(view.lifecycle).toBe('running');
  });
});

describe('health rides alongside the state, never replacing it', () => {
  it('keeps a degraded turn readable as idle with its reason attached', () => {
    const view = sessionStatusView(
      agentSnapshot('idle', null, {
        health: { status: 'degraded', reason: 'provider-rate-limit', since: AT }
      })
    );
    expect(view.agent?.tone).toBe('idle');
    expect(view.degradedReason).toBe('provider-rate-limit');
  });

  it('attaches the reason to an unknown activity so the gap is explainable', () => {
    const view = sessionStatusView(
      agentSnapshot('unknown', null, { health: { status: 'degraded', reason: 'hook-untrusted', since: AT } })
    );
    expect(view.agent).toMatchObject({ tone: 'unknown', detail: 'hook-untrusted' });
  });
});

describe('the lamp set is exactly the operator-owned blocks', () => {
  it('selects only sessions the operator must clear', () => {
    const views = {
      busy: sessionStatusView(agentSnapshot('working')),
      limited: sessionStatusView(agentSnapshot('blocked', { kind: 'rate-limit', owner: 'provider', since: AT })),
      asking: sessionStatusView(agentSnapshot('blocked', { kind: 'approval', owner: 'operator', since: AT })),
      quiet: sessionStatusView(agentSnapshot('idle')),
      shell: sessionStatusView(snapshot({ subject: { kind: 'terminal' } } as Partial<SessionStateSnapshot>))
    };
    expect(actionableSessions(views)).toEqual(['asking']);
  });
});

describe('a partial pulse degrades to unknown, never to empty confidence', () => {
  it('yields NO views when the authority could not be read', async () => {
    const { viewsFromPulse } = await import('../../src/web/usePulse.js');
    // The daemon was unreachable, so `agentStates` is absent from the payload.
    // An empty map means every session falls through to NO_SNAPSHOT_VIEW —
    // `unknown` — rather than being rendered as a confidently resting agent.
    expect(viewsFromPulse(undefined)).toEqual({});
    expect(sessionStatusView(undefined).agent?.tone).toBe('unknown');
  });

  it('keys views by sessionId and ignores an entry with no identity', async () => {
    const { viewsFromPulse } = await import('../../src/web/usePulse.js');
    const views = viewsFromPulse([snapshot(), { sessionId: '' }, {}]);
    expect(Object.keys(views)).toEqual(['work-claude']);
  });
});
