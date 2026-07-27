import { describe, expect, it } from 'vitest';
import {
  OPENCODE_EVENT_TYPES,
  OPENCODE_OBSERVED_TYPES,
  isKnownOpencodeEventType,
  opencodeFacts
} from '../../src/core/agentState/opencodeFacts.js';

/**
 * Specification for the OpenCode → fact mapping. These are the judgements the
 * plugin used to make inside the agent process, where they could not be tested
 * — which is how two arms matching non-existent event names survived.
 */
describe('opencode observation catalogue', () => {
  it('only observes event types that exist in the pinned SDK union', () => {
    const events = OPENCODE_OBSERVED_TYPES.filter((type) => !type.startsWith('hook:'));
    const unknown = events.filter((type) => !isKnownOpencodeEventType(type));
    expect(unknown, 'observed events absent from the SDK Event union never fire').toEqual([]);
  });

  it('rejects the documented-but-nonexistent names that the old adapter listened for', () => {
    // Both appear in the published plugin docs; neither is in the union the
    // `event` hook receives, so an adapter arm for them is dead code.
    expect(isKnownOpencodeEventType('permission.asked')).toBe(false);
    expect(isKnownOpencodeEventType('question.asked')).toBe(false);
    expect(isKnownOpencodeEventType('permission.updated')).toBe(true);
    expect(isKnownOpencodeEventType('permission.replied')).toBe(true);
  });

  it('pins the union as a sorted, duplicate-free list', () => {
    expect([...OPENCODE_EVENT_TYPES]).toEqual([...new Set(OPENCODE_EVENT_TYPES)].sort());
  });
});

describe('session.status is the direct activity answer', () => {
  it('maps busy to working', () => {
    expect(opencodeFacts({ type: 'session.status', status: { type: 'busy' } })).toEqual([
      { kind: 'activity', activity: 'working' }
    ]);
  });

  it('maps idle to idle', () => {
    expect(opencodeFacts({ type: 'session.status', status: { type: 'idle' } })).toEqual([
      { kind: 'activity', activity: 'idle' }
    ]);
  });

  it('maps retry to a PROVIDER wait, so it never summons the operator', () => {
    const facts = opencodeFacts({
      type: 'session.status',
      status: { type: 'retry', attempt: 2, message: 'overloaded' }
    });
    expect(facts).toEqual([
      { kind: 'blocked', wait: { kind: 'retry', owner: 'provider', detail: 'attempt 2 — overloaded' } }
    ]);
  });

  it('asserts nothing for an unrecognised status rather than guessing idle', () => {
    expect(opencodeFacts({ type: 'session.status', status: { type: 'something-new' } })).toEqual([]);
  });
});

describe('session.error is classified by who must act', () => {
  it('treats an aborted message as a normal end of turn, not a failure', () => {
    expect(
      opencodeFacts({ type: 'session.error', error: { name: 'MessageAbortedError', message: 'aborted' } })
    ).toEqual([{ kind: 'activity', activity: 'idle' }]);
  });

  it('reports the output-length cap as idle AND degraded, losing neither', () => {
    expect(opencodeFacts({ type: 'session.error', error: { name: 'MessageOutputLengthError' } })).toEqual([
      { kind: 'activity', activity: 'idle' },
      { kind: 'health', health: { status: 'degraded', reason: 'output-length-cap' } }
    ]);
  });

  it('sends a provider auth failure to the operator', () => {
    expect(
      opencodeFacts({ type: 'session.error', error: { name: 'ProviderAuthError', message: 'token expired' } })
    ).toEqual([{ kind: 'blocked', wait: { kind: 'auth', owner: 'operator', detail: 'token expired' } }]);
  });

  it('routes a retryable API error to the provider and a 429 by name', () => {
    expect(
      opencodeFacts({
        type: 'session.error',
        error: { name: 'APIError', isRetryable: true, statusCode: 429, message: 'slow down' }
      })
    ).toEqual([{ kind: 'blocked', wait: { kind: 'rate-limit', owner: 'provider', detail: 'slow down' } }]);
  });

  it('routes 401/402 to the operator even when the provider calls them retryable', () => {
    expect(
      opencodeFacts({ type: 'session.error', error: { name: 'APIError', isRetryable: true, statusCode: 401 } })
    ).toEqual([{ kind: 'blocked', wait: { kind: 'auth', owner: 'operator', detail: undefined } }]);
    expect(
      opencodeFacts({ type: 'session.error', error: { name: 'APIError', isRetryable: true, statusCode: 402 } })
    ).toEqual([{ kind: 'blocked', wait: { kind: 'billing', owner: 'operator', detail: undefined } }]);
  });

  it('degrades on an unknown error instead of inventing an activity', () => {
    expect(opencodeFacts({ type: 'session.error', error: { name: 'UnknownError', message: 'boom' } })).toEqual([
      { kind: 'health', health: { status: 'degraded', reason: 'boom' } }
    ]);
  });
});

describe('turn edges, blocks, and heartbeat', () => {
  it('opens the turn on a new user message', () => {
    expect(opencodeFacts({ type: 'hook:chat.message' })).toEqual([{ kind: 'activity', activity: 'working' }]);
  });

  it('blocks on the operator for a permission, from either the event or the hook', () => {
    const wait = { kind: 'approval', owner: 'operator', detail: 'run rm -rf' };
    expect(opencodeFacts({ type: 'permission.updated', permissionTitle: 'run rm -rf' })).toEqual([
      { kind: 'blocked', wait }
    ]);
    expect(opencodeFacts({ type: 'hook:permission.ask', permissionTitle: 'run rm -rf' })).toEqual([
      { kind: 'blocked', wait }
    ]);
  });

  it('clears the block only on an explicit reply', () => {
    expect(opencodeFacts({ type: 'permission.replied' })).toEqual([{ kind: 'unblocked' }]);
  });

  it('emits heartbeat — never a transition — for tool and streaming activity', () => {
    for (const type of ['hook:tool.execute.before', 'hook:tool.execute.after', 'message.part.updated', 'message.updated']) {
      expect(opencodeFacts({ type }), type).toEqual([{ kind: 'heartbeat' }]);
    }
  });

  it('asserts nothing for events it does not understand', () => {
    expect(opencodeFacts({ type: 'todo.updated' })).toEqual([]);
    // Lifecycle belongs to the daemon; an agent's own session bookkeeping
    // says nothing about whether the Desk session is alive.
    expect(opencodeFacts({ type: 'session.created' })).toEqual([]);
    expect(opencodeFacts({ type: 'session.deleted' })).toEqual([]);
    expect(opencodeFacts({ type: 'lsp.updated' })).toEqual([]);
    expect(opencodeFacts({ type: 'session.updated' })).toEqual([]);
    expect(opencodeFacts({ type: 'not.an.event' })).toEqual([]);
  });

  it('survives a malformed observation without asserting anything', () => {
    expect(opencodeFacts({} as { type: string })).toEqual([]);
    expect(opencodeFacts(undefined as unknown as { type: string })).toEqual([]);
  });
});

describe('operator-facing detail is bounded at the producer', () => {
  it('truncates a long provider message instead of forwarding it whole', () => {
    const facts = opencodeFacts({
      type: 'session.error',
      error: { name: 'ProviderAuthError', message: 'x'.repeat(500) }
    });
    const detail = facts[0].kind === 'blocked' ? facts[0].wait.detail : undefined;
    expect(detail?.length).toBe(200);
    expect(detail?.endsWith('…')).toBe(true);
  });
});
