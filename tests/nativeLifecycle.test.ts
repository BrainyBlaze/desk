// Daemon-owned native agent-host lifecycle (spec §6.9/§3.6, C14). atch stays
// terminal-only; the daemon supervises native hosts and projects them to the
// control-plane native-fsm source.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NATIVE_RESTART_POLICY,
  applyNativeEvent,
  createNativeHostState,
  decideNativeRestart,
  nativeAgentFactsFor
} from '../src/shared/runtime/index.js';

const T0 = 1_000_000;

describe('native lifecycle — host phase FSM (§6.9)', () => {
  it('starting → ready on handshake', () => {
    const s = createNativeHostState();
    expect(s.phase).toBe('starting');
    applyNativeEvent(s, { kind: 'handshake' });
    expect(s.phase).toBe('ready');
  });

  it('command-result drives working vs idle', () => {
    const s = createNativeHostState();
    applyNativeEvent(s, { kind: 'handshake' });
    applyNativeEvent(s, { kind: 'command-result', result: 'working' });
    expect(s.phase).toBe('working');
    applyNativeEvent(s, { kind: 'command-result', result: 'idle' });
    expect(s.phase).toBe('idle');
  });

  it('clean exit is terminal; crash is a restart candidate with a bumped count', () => {
    const exited = createNativeHostState();
    applyNativeEvent(exited, { kind: 'exit', code: 0 });
    expect(exited.phase).toBe('exited');

    const crashed = createNativeHostState();
    applyNativeEvent(crashed, { kind: 'handshake' });
    applyNativeEvent(crashed, { kind: 'crash', code: 139 });
    expect(crashed.phase).toBe('crashed');
    expect(crashed.restarts).toBe(1);
    expect(crashed.exitCode).toBe(139);
  });
});

describe('native lifecycle — canonical semantic adapter', () => {
  it('maps provider status, turn, and tool facts without a parallel state model', () => {
    expect(nativeAgentFactsFor({ kind: 'status', state: 'processing' })).toEqual([
      { kind: 'activity', activity: 'working' }
    ]);
    expect(
      nativeAgentFactsFor({
        kind: 'tool-start',
        toolUseId: 'tool-1',
        name: 'exec',
        summary: 'running tests'
      })
    ).toEqual([{ kind: 'activity', activity: 'working' }]);
    expect(nativeAgentFactsFor({ kind: 'turn-complete', turnId: 'turn-1' })).toEqual([
      { kind: 'activity', activity: 'idle' }
    ]);
  });

  it('maps permission and provider waits with explicit ownership', () => {
    expect(
      nativeAgentFactsFor({
        kind: 'permission-request',
        requestId: 'permission-1',
        variant: 'file-edit',
        title: 'Approve edit',
        options: []
      })
    ).toEqual([
      {
        kind: 'blocked',
        wait: {
          kind: 'permission-file-edit',
          owner: 'operator',
          detail: 'Approve edit'
        }
      }
    ]);
    expect(
      nativeAgentFactsFor({
        kind: 'attention-hint',
        attention: 'session-status',
        detail: 'provider retry'
      })
    ).toEqual([
      {
        kind: 'blocked',
        wait: {
          kind: 'provider-status',
          owner: 'provider',
          detail: 'provider retry'
        }
      }
    ]);
    expect(
      nativeAgentFactsFor({
        kind: 'permission-resolved',
        requestId: 'permission-1',
        optionId: 'allow',
        via: 'ui'
      })
    ).toEqual([{ kind: 'unblocked' }]);
  });

  it('degrades a disconnected host to unknown instead of preserving stale work', () => {
    expect(nativeAgentFactsFor({ kind: 'host-disconnected', detail: 'socket closed' })).toEqual([
      { kind: 'activity', activity: 'unknown' },
      {
        kind: 'health',
        health: {
          status: 'degraded',
          reason: 'native-host-disconnected',
          detail: 'socket closed'
        }
      }
    ]);
  });
});

describe('native lifecycle — restart policy (§8.3, daemon-owned)', () => {
  it('restarts a crashed host with bounded-exponential backoff', () => {
    const s = createNativeHostState();
    applyNativeEvent(s, { kind: 'crash', code: 1 }); // restarts=1
    const r = decideNativeRestart(s, T0, { maxRestarts: 5, backoffBaseMs: 500, backoffMaxMs: 30_000, backoffFactor: 2 });
    expect(r).toEqual({ action: 'restart', at: T0 + 500 });
  });

  it('gives up past maxRestarts (fail-closed, no infinite respawn)', () => {
    const s = createNativeHostState();
    s.phase = 'crashed';
    s.restarts = 6;
    const r = decideNativeRestart(s, T0, { ...DEFAULT_NATIVE_RESTART_POLICY, maxRestarts: 5 });
    expect(r).toEqual({ action: 'give-up', restarts: 6 });
  });

  it('does not restart a non-crashed host', () => {
    const s = createNativeHostState();
    applyNativeEvent(s, { kind: 'handshake' });
    expect(decideNativeRestart(s, T0).action).toBe('give-up');
  });
});
