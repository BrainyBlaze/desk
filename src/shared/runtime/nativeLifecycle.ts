// Daemon-owned native agent-host lifecycle (spec §6.9 / §3.6, C14). Pure state
// machine. atch is TERMINAL-ONLY (§5.2 C14: "native is not atch's") — it spawns
// PTY sessions and nothing else. NATIVE (non-PTY) sessions are supervised by the
// DAEMON's agent-host: the daemon spawns/watches the host process, maps its
// AgentSurface command-results to the control-plane `native-fsm` source, and
// applies a restart policy. This module is the contract the atch C lane needs so
// it does NOT try to own native lifecycle (which breaks its terminal-only tests).
//
// The daemon drives real host processes over the stable socket (§3.6); here we
// encode the lifecycle rules so they are testable without spawning.

import type { AgentSurfaceEventPayload } from '../../core/agentSurfaceProtocol.js';
import type { AgentSemanticFact, WaitOwner } from '../controlPlane/contract.js';

/** The native host PROCESS lifecycle the daemon supervises. */
export type NativeHostPhase =
  | 'starting' // spawned, not yet handshaked (control state is unobservable → unknown)
  | 'ready' // handshaked, awaiting work (idle)
  | 'working' // an AgentSurface command is in flight
  | 'idle' // completed, awaiting the next command
  | 'exited' // the host process exited cleanly (session ended)
  | 'crashed'; // the host process died unexpectedly (restart candidate)

/** AgentSurface command-result classes the host reports (§6.9 native work). */
export type CommandResultClass = 'working' | 'idle' | 'blocked' | 'awaiting-approval';

export interface NativeHostState {
  phase: NativeHostPhase;
  /** Restart attempts since the last clean ready (bounded-backoff input). */
  restarts: number;
  /** Exit code when phase is exited/crashed. */
  exitCode?: number;
}

export function createNativeHostState(): NativeHostState {
  return { phase: 'starting', restarts: 0 };
}

export type NativeEvent =
  | { kind: 'handshake' } // host connected to the daemon socket
  | { kind: 'command-result'; result: CommandResultClass }
  | { kind: 'exit'; code: number }
  | { kind: 'crash'; code: number };

/**
 * Fold one host event into the lifecycle (pure; mutates + returns). A crash from
 * any live phase → crashed (restart candidate); a clean exit → exited (terminal).
 * command-result transitions ready/idle/working per the surface's class.
 */
export function applyNativeEvent(s: NativeHostState, ev: NativeEvent): NativeHostState {
  switch (ev.kind) {
    case 'handshake':
      if (s.phase === 'starting' || s.phase === 'crashed') {
        s.phase = 'ready';
      }
      return s;
    case 'command-result':
      if (s.phase === 'ready' || s.phase === 'working' || s.phase === 'idle') {
        s.phase = ev.result === 'working' ? 'working' : 'idle';
      }
      return s;
    case 'exit':
      s.phase = 'exited';
      s.exitCode = ev.code;
      return s;
    case 'crash':
      s.phase = 'crashed';
      s.exitCode = ev.code;
      s.restarts += 1;
      return s;
  }
}

export type NativeAgentObservation =
  | AgentSurfaceEventPayload
  | { kind: 'host-connected' }
  | { kind: 'host-disconnected'; detail?: string };

/**
 * Map one typed native-provider observation to canonical semantic facts.
 * Conversation events remain conversation transport; only this adapter writes
 * activity/wait/health, and it never inspects terminal rendering.
 */
export function nativeAgentFactsFor(observation: NativeAgentObservation): AgentSemanticFact[] {
  switch (observation.kind) {
    case 'host-connected':
      return [
        { kind: 'activity', activity: 'unknown' },
        { kind: 'health', health: { status: 'healthy' } }
      ];
    case 'host-disconnected':
      return [
        { kind: 'activity', activity: 'unknown' },
        {
          kind: 'health',
          health: {
            status: 'degraded',
            reason: 'native-host-disconnected',
            ...(observation.detail === undefined ? {} : { detail: observation.detail })
          }
        }
      ];
    case 'status':
      switch (observation.state) {
        case 'processing':
        case 'tool-executing':
          return [{ kind: 'activity', activity: 'working' }];
        case 'idle':
        case 'interrupted':
          return [{ kind: 'activity', activity: 'idle' }];
        case 'awaiting-permission':
          return [blockedFact('permission', 'operator', observation.detail)];
        case 'starting':
          return [
            { kind: 'activity', activity: 'unknown' },
            { kind: 'health', health: { status: 'healthy' } }
          ];
        case 'error':
          return degradedUnknown('native-agent-error', observation.detail);
        case 'exited':
          return degradedUnknown('native-agent-exited', observation.detail);
      }
    case 'user-message':
    case 'tool-start':
      return [{ kind: 'activity', activity: 'working' }];
    case 'assistant-delta':
    case 'assistant-message':
    case 'tool-output-delta':
    case 'tool-end':
      return [{ kind: 'heartbeat' }];
    case 'permission-request':
      return [
        blockedFact(
          `permission-${observation.variant}`,
          'operator',
          observation.detail ?? observation.title
        )
      ];
    case 'permission-resolved':
      return [{ kind: 'unblocked' }];
    case 'turn-complete':
      return [{ kind: 'activity', activity: 'idle' }];
    case 'attention-hint':
      return observation.attention === 'session-status'
        ? [blockedFact('provider-status', 'provider', observation.detail)]
        : [
            blockedFact(
              observation.attention === 'elicitation' ? 'elicitation' : 'input',
              'operator',
              observation.detail
            )
          ];
    case 'agent-error':
      return degradedUnknown('native-agent-error', observation.message);
    case 'session-info':
    case 'history-boundary':
      return [{ kind: 'health', health: { status: 'healthy' } }];
  }
}

function blockedFact(
  kind: string,
  owner: WaitOwner,
  detail: string | undefined
): AgentSemanticFact {
  const boundedDetail = canonicalDetail(detail);
  return {
    kind: 'blocked',
    wait: {
      kind,
      owner,
      ...(boundedDetail === undefined ? {} : { detail: boundedDetail })
    }
  };
}

function degradedUnknown(reason: string, detail: string | undefined): AgentSemanticFact[] {
  const boundedDetail = canonicalDetail(detail);
  return [
    { kind: 'activity', activity: 'unknown' },
    {
      kind: 'health',
      health: {
        status: 'degraded',
        reason,
        ...(boundedDetail === undefined ? {} : { detail: boundedDetail })
      }
    }
  ];
}

function canonicalDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) {
    return undefined;
  }
  const trimmed = detail.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, 2_000);
}

export interface NativeRestartPolicy {
  maxRestarts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  backoffFactor: number;
}

export const DEFAULT_NATIVE_RESTART_POLICY: Readonly<NativeRestartPolicy> = Object.freeze({
  maxRestarts: 5,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  backoffFactor: 2
});

/**
 * Decide whether/when to restart a crashed native host (§8.3 restart matrix,
 * daemon-owned). Past `maxRestarts` the daemon gives up (fail-closed → the
 * session is surfaced as crashed, not silently respawned forever).
 */
export function decideNativeRestart(
  s: NativeHostState,
  now: number,
  policy: NativeRestartPolicy = DEFAULT_NATIVE_RESTART_POLICY
): { action: 'restart'; at: number } | { action: 'give-up'; restarts: number } {
  if (s.phase !== 'crashed') return { action: 'give-up', restarts: s.restarts };
  if (s.restarts > policy.maxRestarts) return { action: 'give-up', restarts: s.restarts };
  const delay = Math.min(policy.backoffBaseMs * policy.backoffFactor ** (s.restarts - 1), policy.backoffMaxMs);
  return { action: 'restart', at: now + delay };
}
