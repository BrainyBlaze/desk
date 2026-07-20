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

import { type ControlState } from '../controlPlane/model.js';

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

/**
 * Project the host lifecycle + last command-result to the control-plane
 * `native-fsm` ControlState (§6.9). `starting` and `crashed`/`exited` are
 * unobservable-as-work → `unknown` (fail-closed, never coerced to idle); a live
 * host's state comes from its last command-result class.
 */
export function nativeControlState(s: NativeHostState, lastResult?: CommandResultClass): ControlState {
  switch (s.phase) {
    case 'working':
      return 'working';
    case 'ready':
    case 'idle':
      // map the last command-result class; a bare ready with no result is idle
      if (lastResult === 'blocked') return 'blocked';
      if (lastResult === 'awaiting-approval') return 'awaiting-approval';
      return 'idle';
    case 'starting':
    case 'exited':
    case 'crashed':
      return 'unknown';
  }
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
