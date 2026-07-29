import type { SessionSpec } from '../core/types.js';

/**
 * Decide whether a session edit requires respawning the running session.
 *
 * Runtime-config edits (model; any command change that keeps the name) do NOT
 * change the session name, so nothing downstream would ever apply them —
 * the manifest updates but the live process keeps its old launch config
 * silently. Identity edits (agent/cwd/bypass/name) change the name and flow
 * through the existing missing-session reconcile instead. uiMode changes have
 * their own dedicated atomic switch flow (/api/set-session-ui-mode) and are
 * deliberately excluded here so a plain edit can never half-perform a switch.
 */
export function shouldRespawnAfterEdit(
  oldSpec: SessionSpec | undefined,
  newSpec: SessionSpec | undefined,
  isRunning: (sessionId: string) => boolean
): boolean {
  if (!oldSpec || !newSpec) {
    return false;
  }
  if (oldSpec.sessionId !== newSpec.sessionId) {
    return false; // identity change — old id reconciles as missing, new id boots fresh
  }
  if (oldSpec.uiMode !== newSpec.uiMode) {
    return false; // ui-mode changes must go through the dedicated switch endpoint
  }
  if (
    oldSpec.command === newSpec.command &&
    oldSpec.model === newSpec.model &&
    oldSpec.profileId === newSpec.profileId
  ) {
    return false; // nothing launch-relevant changed
  }
  // A profile change IS launch-relevant: the running process still holds the
  // OLD account's credentials, so leaving it alive would answer the operator
  // under the account they just switched away from.
  return isRunning(newSpec.sessionId);
}
