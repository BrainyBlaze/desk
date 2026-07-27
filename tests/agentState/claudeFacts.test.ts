import { describe, expect, it } from 'vitest';
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_NOTIFICATION_MATCHERS,
  claudeFacts
} from '../../src/core/agentState/claudeFacts.js';
import { buildClaudeHooksSettings } from '../../src/core/agentHooks.js';

describe('claude turn edges', () => {
  it('opens the turn on UserPromptSubmit, before the model runs', () => {
    expect(claudeFacts({ hook: 'UserPromptSubmit' })).toEqual([{ kind: 'activity', activity: 'working' }]);
  });

  it('closes the turn on Stop', () => {
    expect(claudeFacts({ hook: 'Stop' })).toEqual([{ kind: 'activity', activity: 'idle' }]);
  });

  // A started session is at its prompt with nothing running. Reporting that is
  // what keeps an idle fleet from reading `unknown` until someone happens to
  // talk to it — the state most sessions are in most of the time.
  it.each(['startup', 'resume', 'clear', 'fork'])(
    'reports IDLE when a session starts via %s',
    (source) => {
      expect(claudeFacts({ hook: 'SessionStart', matcher: source })).toEqual([
        { kind: 'activity', activity: 'idle' }
      ]);
    }
  );

  it('treats a start with no named source as a genuine start', () => {
    // Compaction is the only way a session can begin mid-turn, and it always
    // names itself; anything unnamed is a real start.
    expect(claudeFacts({ hook: 'SessionStart' })).toEqual([{ kind: 'activity', activity: 'idle' }]);
  });

  // The dangerous case: auto-compaction fires WHILE the agent is working, so
  // calling it idle would paint a busy session as free and, through the
  // delivery gate, invite a message straight into the middle of its turn.
  it('never claims idle on compaction — it asserts only liveness', () => {
    expect(claudeFacts({ hook: 'SessionStart', matcher: 'compact' })).toEqual([{ kind: 'heartbeat' }]);
  });

  it('says nothing on session end — the daemon watches the process exit', () => {
    expect(claudeFacts({ hook: 'SessionEnd', matcher: 'logout' })).toEqual([]);
  });
});

describe('a failed turn is idle and degraded, never blocked or dead', () => {
  it('reports a rate-limited turn as finished, with the reason attached', () => {
    // The turn is OVER: nothing is holding the agent, the operator resubmits if
    // they want the work. Calling it blocked would invent a wait that no one
    // can clear; calling it offline would paint a live agent dead.
    expect(claudeFacts({ hook: 'StopFailure', matcher: 'rate_limit' })).toEqual([
      { kind: 'activity', activity: 'idle' },
      { kind: 'health', health: { status: 'degraded', reason: 'provider-rate-limit' } }
    ]);
  });

  it('distinguishes provider trouble from account trouble', () => {
    const reasonOf = (matcher: string): string | undefined => {
      const fact = claudeFacts({ hook: 'StopFailure', matcher }).find((candidate) => candidate.kind === 'health');
      return fact?.kind === 'health' && fact.health.status === 'degraded' ? fact.health.reason : undefined;
    };
    expect(reasonOf('overloaded')).toBe('provider-overloaded');
    expect(reasonOf('server_error')).toBe('provider-error');
    expect(reasonOf('authentication_failed')).toBe('auth');
    expect(reasonOf('oauth_org_not_allowed')).toBe('auth');
    expect(reasonOf('billing_error')).toBe('billing');
    expect(reasonOf('model_not_found')).toBe('model-not-found');
    expect(reasonOf('max_output_tokens')).toBe('output-length-cap');
  });

  it('still reports a finished turn when the reason is one this build does not know', () => {
    // A new upstream matcher must not swallow the turn end — the activity is
    // known even when the reason is not.
    expect(claudeFacts({ hook: 'StopFailure', matcher: 'brand_new_failure' })).toEqual([
      { kind: 'activity', activity: 'idle' },
      { kind: 'health', health: { status: 'degraded', reason: 'unknown-error' } }
    ]);
  });
});

describe('claude blocks name the operator', () => {
  it('blocks on an approval from PermissionRequest and from the notification', () => {
    expect(claudeFacts({ hook: 'PermissionRequest', message: 'Bash(rm -rf)' })).toEqual([
      { kind: 'blocked', wait: { kind: 'approval', owner: 'operator', detail: 'Bash(rm -rf)' } }
    ]);
    expect(claudeFacts({ hook: 'Notification', matcher: 'permission_prompt', message: 'Bash(rm -rf)' })).toEqual([
      { kind: 'blocked', wait: { kind: 'approval', owner: 'operator', detail: 'Bash(rm -rf)' } }
    ]);
  });

  it('blocks on input for an elicitation and for agent_needs_input', () => {
    for (const matcher of ['elicitation_dialog', 'agent_needs_input']) {
      const facts = claudeFacts({ hook: 'Notification', matcher, message: 'which branch?' });
      expect(facts, matcher).toEqual([
        { kind: 'blocked', wait: { kind: 'input', owner: 'operator', detail: 'which branch?' } }
      ]);
    }
  });

  it('treats the idle and completed notifications as a finished turn', () => {
    expect(claudeFacts({ hook: 'Notification', matcher: 'idle_prompt' })).toEqual([
      { kind: 'activity', activity: 'idle' }
    ]);
    expect(claudeFacts({ hook: 'Notification', matcher: 'agent_completed' })).toEqual([
      { kind: 'activity', activity: 'idle' }
    ]);
  });

  it('asserts nothing for a notification matcher it does not know', () => {
    expect(claudeFacts({ hook: 'Notification', matcher: 'auth_success' })).toEqual([]);
    expect(claudeFacts({ hook: 'Notification' })).toEqual([]);
  });
});

describe('tool hooks are the only proof a long turn is alive', () => {
  it('beats without asserting a transition', () => {
    for (const hook of ['PreToolUse', 'PostToolUse', 'PostToolBatch']) {
      expect(claudeFacts({ hook, tool: 'Bash' }), hook).toEqual([{ kind: 'heartbeat' }]);
    }
  });

  it('asserts nothing for an unknown hook and survives a malformed observation', () => {
    expect(claudeFacts({ hook: 'CwdChanged' })).toEqual([]);
    expect(claudeFacts({} as { hook: string })).toEqual([]);
    expect(claudeFacts(undefined as unknown as { hook: string })).toEqual([]);
  });
});

describe('the installed hook set matches what the mapper can read', () => {
  const settings = buildClaudeHooksSettings('/tmp/shim');

  it('installs exactly the events the adapter understands', () => {
    expect(Object.keys(settings.hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS]);
  });

  it('installs the heartbeat hooks — without them a long turn has no evidence', () => {
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();
  });

  it('subscribes to every notification matcher the mapper acts on', () => {
    const matchers = (settings.hooks.Notification ?? []).map((group) => group.matcher).sort();
    expect(matchers).toEqual([...CLAUDE_NOTIFICATION_MATCHERS]);
  });

  it('asks for a permission decision through PermissionRequest, not only the notification', () => {
    expect(settings.hooks.PermissionRequest).toBeDefined();
  });
});
