// Native (moor) session control for the web server (cutover spawn/boot/restart).
//
// The three-tier split means the web process never spawns moor itself — the
// separate daemon process owns the @xterm/headless screen authority, so
// session start/restart provisions via the daemon's HTTP control plane
// (createDaemonControlHandler). Every path returns a concrete {ok,error}; a daemon that is down or refuses a
// spawn surfaces as a non-ok result the route turns into a non-2xx JSON error,
// never a silent no-op.

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
      geometry: { rows: 24, cols: 80 },
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
 * The native identity a session edit leaves behind, or undefined if unchanged.
 *
 * A session's moor holder is keyed by its durable sessionId. A persisted
 * sessionId survives renames, so only a LEGACY entry lacking one (whose id is
 * minted from the name) can change identity on rename — leaving the running
 * master keyed by the old id. The edit path retires the returned id so that
 * master does not orphan (nothing references it again). Returns undefined when
 * nothing changed or either spec is missing.
 */
export function staleNativeIdentityAfterEdit(
  oldSpec: SessionSpec | undefined,
  newSpec: SessionSpec | undefined
): string | undefined {
  if (!oldSpec || !newSpec) {
    return undefined;
  }
  const oldId = oldSpec.sessionId;
  const newId = newSpec.sessionId;
  return oldId !== newId ? oldId : undefined;
}

/**
 * Fail-closed guard for an identity-changing native edit (a legacy entry whose
 * name-minted id changes on rename; a persisted sessionId never does): retire
 * the pre-edit identity BEFORE the manifest rename commits. Returns `ok: false`
 * (the caller MUST abort the edit, leaving the manifest untouched and
 * provisioning nothing) when the retire fails — so a rename can never orphan
 * the old moor holder nor desync the manifest against a still-running master.
 * A no-op (ok) when the flag is off or the identity is unchanged. (R2.1.)
 */
export async function retireStaleIdentityForEdit(
  oldSpec: SessionSpec | undefined,
  newSpec: SessionSpec | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
  const stale = staleNativeIdentityAfterEdit(oldSpec, newSpec);
  if (stale === undefined) {
    return { ok: true };
  }
  const retired = await retireNativeSession(stale, 'stale-identity-after-edit');
  if (retired.ok) {
    return { ok: true };
  }
  return { ok: false, error: `could not retire old identity ${stale}: ${retired.error}` };
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
  /** Paste text then a delayed Enter (bracketed-paste staging + separate submit). */
  sendText: (sessionId: string, text: string) => Promise<boolean>;
  /**
   * The daemon's authoritative three-state liveness (#8 criterion 1). Never a
   * socket-level probe, and `indeterminate` never rounds to live or dead.
   */
  sessionLiveness: (sessionId: string) => Promise<SessionLiveness>;
  /** The emulator's on-screen tail (plain text), null when unobservable. */
  capturePane: (sessionId: string) => Promise<string | null>;
  /** Bare Enter (the submit-verification retry). */
  sendEnter: (sessionId: string) => Promise<boolean>;
  /**
   * Session start time in epoch SECONDS (legacy session_created parity),
   * from the adopted holder's own wallStart clock (#8: wire truth, never a
   * filesystem timestamp); null when unobservable.
   */
  sessionCreatedAt: (sessionId: string) => Promise<number | null>;
}

export function createNativeChannelsTransport(
  options: {
    enterDelayMs?: number;
    wait?: (ms: number) => Promise<void>;
    confirmDelayMs?: number;
    enterAttempts?: number;
    pasteObserveAttempts?: number;
  } = {}
): NativeChannelsTransport {
  const enterDelayMs = options.enterDelayMs ?? 1200;
  const confirmDelayMs = options.confirmDelayMs ?? 400;
  // Total Enter presses, including the first. 1 restores the open-loop send.
  const enterAttempts = Math.max(1, options.enterAttempts ?? 3);
  const pasteObserveAttempts = Math.max(1, options.pasteObserveAttempts ?? 3);
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const capturePane = async (sessionId: string): Promise<string | null> => {
    const result = await daemonControl('/control/tail', { sessionId, rows: 200 });
    const lines = result.ok ? result.body?.lines : undefined;
    return Array.isArray(lines) && lines.every((line) => typeof line === 'string') ? lines.join('\n') : null;
  };
  return {
    async sendText(sessionId, text) {
      const prePaste = await capturePane(sessionId);
      // paste:true mirrors legacy paste semantics — the daemon wraps in
      // bracketed-paste codes only when the app enabled the mode.
      const delivered = await daemonControl('/control/input', { sessionId, text, paste: true });
      if (!delivered.ok) {
        return false;
      }
      await wait(enterDelayMs);

      // The control endpoint acknowledges the socket write, not TUI ingestion.
      // Under load the first post-paste capture can still equal the pre-paste
      // screen. Wait boundedly for the composer to move before using a later
      // screen change as evidence that Enter submitted the prompt.
      let before = await capturePane(sessionId);
      if (prePaste !== null && before !== null) {
        for (let attempt = 1; attempt < pasteObserveAttempts && before === prePaste; attempt += 1) {
          await wait(confirmDelayMs);
          before = await capturePane(sessionId);
          if (before === null) break;
        }
        if (before === prePaste) {
          before = null; // paste staging stayed unobservable: one open-loop Enter only
        }
      }

      // The submit is CONFIRMED, not assumed. A fixed delay is an open-loop
      // guess: a TUI still digesting the paste (or busy rendering) swallows
      // the Enter, and the message then sits in the composer until a human
      // presses Enter — the operator-reported symptom. Submitting always
      // repaints (composer clears, the message renders), so an unchanged
      // screen across the Enter means the keystroke did nothing and is worth
      // repeating. Bounded, and a screen we cannot observe falls back to the
      // single open-loop press rather than hammering Enter blindly.
      let sent = false;
      for (let attempt = 0; attempt < enterAttempts; attempt += 1) {
        const pressed = await daemonControl('/control/input', { sessionId, text: '\r' });
        if (!pressed.ok) {
          return false;
        }
        sent = true;
        // Unobservable screen: no oracle, so keep the single open-loop press
        // instead of spending a confirm round-trip on a guess.
        if (before === null || attempt + 1 >= enterAttempts) {
          break;
        }
        await wait(confirmDelayMs);
        const after = await capturePane(sessionId);
        if (after === null) {
          break;
        }
        if (after !== before) {
          break; // the screen moved — the submit landed
        }
        before = after; // identical across the press: swallowed, try once more
      }
      return sent;
    },
    sessionLiveness(sessionId) {
      // #8: the daemon's own adopted-link status, not a socket probe.
      return sessionLivenessFor(sessionId);
    },
    capturePane,
    async sendEnter(sessionId) {
      return (await daemonControl('/control/input', { sessionId: sessionId, text: '\r' })).ok;
    },
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
