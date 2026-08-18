// Native (moor) session control for the web server (cutover spawn/boot/restart).
//
// The three-tier split means the web process never spawns moor itself — the
// separate daemon process owns the @xterm/headless screen authority, so
// session start/restart provisions via the daemon's HTTP control plane
// (createDaemonControlHandler). Every path returns a concrete {ok,error}; a daemon that is down or refuses a
// spawn surfaces as a non-ok result the route turns into a non-2xx JSON error,
// never a silent no-op.

import { SESSION_CREATION_GEOMETRY } from '../../shared/runtime/sessionGeometryStore.js';
import type { RetireReason as SessionRetireReason } from '../../shared/runtime/daemonCore.js';
import { daemonControl, daemonControlGet, toOkResult, type DaemonControlResult } from '../../shared/daemonControlClient.js';
import { loadDeskCached, sessionLivenessFor, type SessionLiveness } from '../../core/runner.js';
import type { SessionSpec } from '../../core/types.js';
import { moorCommandFor } from '../../shared/moorCommand.js';
import { sessionStateSubjectFor } from '../../shared/controlPlane/index.js';
import {
  claudeContinuityDescriptorFor,
  claudeProfileMemoryDescriptorFor
} from '../../shared/claudeContinuityDescriptor.js';

// The moor child command lives in shared/moorCommand — one audited copy for
// this wrapper and the core runner lifecycle. Re-exported for existing
// consumers/tests.
export { moorCommandFor };

// HTTP transport lives in the shared daemonControlClient (one client for the
// server wrapper here and the codex-lane core/CLI consumers, R8.4/R6.1-style
// single audited copy). This module keeps only the session-level semantics.

/** Provision (spawn + attach) a session's moor holder via the daemon. */
export function provisionNativeSession(spec: SessionSpec): Promise<{ ok: boolean; error?: string }> {
  const sessionId = spec.sessionId;
  const continuity = claudeContinuityDescriptorFor(spec);
  const claudeMemory = claudeProfileMemoryDescriptorFor(spec);
  return toOkResult(
    daemonControl('/control/provision', {
      sessionId,
      command: moorCommandFor(spec),
      geometry: SESSION_CREATION_GEOMETRY,
      subject: sessionStateSubjectFor(spec),
      ...(spec.resume === undefined
        ? {}
        : { providerSessionId: spec.resume }),
      ...(continuity ? { continuity } : {}),
      ...(claudeMemory ? { claudeMemory } : {})
    })
  );
}

/**
 * Retire a session's moor holder via the daemon (KILL contract).
 *
 * desk#59 — the CAUSE travels with the request. The route is only transport:
 * only the caller knows whether this is an operator restarting the session, a
 * kill switch, or a generic control retire, and a cause dropped here is a cause
 * the record can never recover.
 */
export function retireNativeSession(
  sessionId: string,
  reason: SessionRetireReason
): Promise<{ ok: boolean; error?: string }> {
  return toOkResult(daemonControl('/control/retire', { sessionId, reason }));
}

/**
 * A native edit never changes a session's identity: the persisted sessionId is
 * not an editable field (the manifest edit carries it across a rename) and the
 * store support floor refuses an entry that lacks one, so there is no legacy
 * shape left whose id could be re-minted from its name. A differing id here is
 * therefore a contradiction in the edit itself, not a case to repair by
 * retiring the old holder: the edit MUST abort before anything commits.
 * Returns the abort reason, or undefined when the identity is intact or either
 * spec is absent (nothing native is involved then).
 */
export function editIdentityContradiction(
  oldSpec: SessionSpec | undefined,
  newSpec: SessionSpec | undefined
): string | undefined {
  if (!oldSpec || !newSpec || oldSpec.sessionId === newSpec.sessionId) {
    return undefined;
  }
  return `identity changed from ${oldSpec.sessionId} to ${newSpec.sessionId}: a session edit never re-mints the persisted sessionId`;
}

/** Start a session: daemon provision (the server enriches the spec first). */
export function startSessionNativeAware(spec: SessionSpec): Promise<{ ok: boolean; error?: string }> {
  return provisionNativeSession(spec);
}

/** Restart a session: awaited daemon retire, then provision. */
export async function restartSessionNativeAware(spec: SessionSpec): Promise<{ ok: boolean; error?: string }> {
  // An operator restart is not a generic control retire: the record must be
  // able to say the session ended because someone rebooted it.
  const retired = await retireNativeSession(spec.sessionId, 'operator-reboot');
  if (!retired.ok) {
    return retired;
  }
  return provisionNativeSession(spec);
}

/**
 * The channels-delivery transport for terminal sessions, over the daemon
 * control plane. The engine keys by sessionId end-to-end — the values pass
 * through untouched. The uiMode=native broker path is unaffected.
 */
export interface NativeChannelsTransport {
  /** Submit one complete prompt through one daemon-to-Moor input packet. */
  sendText: (sessionId: string, text: string) => Promise<boolean>;
  /**
   * The daemon's authoritative three-state liveness (#8 criterion 1). Never a
   * socket-level probe, and `indeterminate` never rounds to live or dead.
   */
  sessionLiveness: (sessionId: string) => Promise<SessionLiveness>;
  /** The emulator's on-screen tail (plain text), null when unobservable. */
  capturePane: (sessionId: string) => Promise<string | null>;
  /**
   * Session start time in epoch SECONDS (legacy session_created parity),
   * from the adopted holder's own wallStart clock (#8: wire truth, never a
   * filesystem timestamp); null when unobservable.
   */
  sessionCreatedAt: (sessionId: string) => Promise<number | null>;
}

export function createNativeChannelsTransport(): NativeChannelsTransport {
  const capturePane = async (sessionId: string): Promise<string | null> => {
    const result = await daemonControl('/control/tail', { sessionId, rows: 200 });
    const lines = result.ok ? result.body?.lines : undefined;
    return Array.isArray(lines) && lines.every((line) => typeof line === 'string') ? lines.join('\n') : null;
  };
  return {
    async sendText(sessionId, text) {
      return (await daemonControl('/control/prompt', { sessionId, text })).ok;
    },
    sessionLiveness(sessionId) {
      // #8: the daemon's own adopted-link status, not a socket probe.
      return sessionLivenessFor(sessionId);
    },
    capturePane,
    async sessionCreatedAt(sessionId) {
      // #8: WIRE truth, not a filesystem timestamp — the adopted ATTACH_ACK's
      // wallStart is the holder's own start clock, immune to fs birthtime
      // quirks and to a rendezvous recreated by a successor generation.
      const result = await daemonControlGet(`/control/moor-status?sessionId=${encodeURIComponent(sessionId)}`);
      const wallStartMs = result.ok ? result.body?.wallStartMs : undefined;
      return typeof wallStartMs === 'number' && Number.isFinite(wallStartMs) && wallStartMs > 0
        ? Math.floor(wallStartMs / 1000)
        : null; // no live adopted link / daemon unreachable — unobservable
    }
  };
}
