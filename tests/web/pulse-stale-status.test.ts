// When the pulse cannot be read, Desk does not know what any agent is doing.
// Holding the last answer keeps the sidebar confidently claiming "working" or
// "needs approval" for as long as the bridge is down — the confident wrong
// answer the whole state model exists to avoid.
import { describe, expect, it } from 'vitest';
import { viewsWithoutAgentEvidence, type SessionStatusMap } from '../../src/web/usePulse.js';

describe('a failed pulse drops agent evidence but keeps liveness', () => {
  const views: SessionStatusMap = {
    'agent-1': {
      lifecycle: 'running',
      agent: { tone: 'working', label: 'working', detail: 'editing', actionable: false },
      degradedReason: null,
      exited: false
    },
    'agent-2': {
      lifecycle: 'running',
      agent: { tone: 'blocked', label: 'needs approval', detail: undefined, actionable: true },
      degradedReason: null,
      exited: false
    },
    'plain-shell': {
      lifecycle: 'running',
      agent: null, // not an agent: no activity axis to forget
      degradedReason: null,
      exited: false
    }
  };

  it('replaces every agent activity with unknown', () => {
    const degraded = viewsWithoutAgentEvidence(views);

    expect(degraded['agent-1']?.agent?.tone).toBe('unknown');
    expect(degraded['agent-2']?.agent?.tone).toBe('unknown');
    expect(degraded['agent-2']?.agent?.actionable, 'a stale prompt must stop demanding action').toBe(false);
  });

  it('keeps lifecycle, because an unreadable authority is not a death certificate', () => {
    const degraded = viewsWithoutAgentEvidence(views);

    expect(degraded['agent-1']?.lifecycle).toBe('running');
    expect(degraded['agent-1']?.exited).toBe(false);
  });

  it('leaves a non-agent session untouched', () => {
    const degraded = viewsWithoutAgentEvidence(views);

    expect(degraded['plain-shell']).toBe(views['plain-shell']);
  });
});
