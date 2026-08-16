/**
 * The on-disk store support floor.
 *
 * Desk v0.3.2 (released 2026-08-11) is the last release that carries the
 * cutover migration: it rewrote every store Desk v0.3.1 and older had written —
 * the manifest, the Channels paused store, the delivery-events ring, member
 * manifests, the durability queue — from the retired per-session identity to
 * `sessionId`. This version does not migrate. A store still in the older shape
 * is refused by name at the reader that meets it, and every such refusal ends
 * with this note so the operator learns the one remedy that exists: boot Desk
 * v0.3.2 once against the store (it migrates in place), then upgrade.
 *
 * Nothing here recognises old shapes; each reader owns that knowledge because
 * each store's pre-cutover shape is different. This module only pins the floor
 * and the sentence, so no reader can name a migration that no longer exists.
 */
export const STORE_SUPPORT_FLOOR_RELEASE = 'Desk v0.3.2';

export const STORE_SUPPORT_FLOOR_NOTE =
  `this version does not migrate stores written by Desk v0.3.1 or older; ` +
  `boot ${STORE_SUPPORT_FLOOR_RELEASE} once against this store (the last release that migrates it in place), then upgrade`;

/**
 * A store in a pre-cutover shape that this version refuses to read. Carries
 * the floor note in its message; the API router maps it to a 422 with a stable
 * code so the UI shows the same sentence the server logs.
 */
export class PreCutoverStoreError extends Error {
  readonly code = 'pre-cutover-store';

  constructor(what: string) {
    super(`${what}; ${STORE_SUPPORT_FLOOR_NOTE}`);
    this.name = 'PreCutoverStoreError';
  }
}
