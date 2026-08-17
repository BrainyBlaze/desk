/**
 * The on-disk store support floor.
 *
 * Desk v0.3.2 (released 2026-08-11) is the last release that carries the cutover
 * migration: it rewrote the stores Desk v0.3.1 and older had written — the
 * manifest, the Channels paused store, the delivery-events ring, member
 * manifests, the durability queue — from the retired per-session identity to
 * `sessionId`. This version does not migrate.
 *
 * That splits what a reader here can meet into two cases, and they are handled
 * oppositely on purpose:
 *
 * 1. A store WHOLLY in the pre-cutover shape — one that was never booted under
 *    v0.3.2 at all: a manifest whose session entries still carry the retired
 *    per-session key or no `sessionId`, or a paused store written at version 1.
 *    Nothing in it is
 *    attributable. Its reader REFUSES it by name (`PreCutoverStoreError`, or the
 *    manifest's own validation error), and every such refusal ends with the note
 *    below, so the operator learns the one remedy that exists: boot Desk v0.3.2
 *    once against the store (it migrates in place), then upgrade.
 *
 * 2. A single unresolvable record left inside an ALREADY-migrated store. v0.3.2
 *    deliberately kept in place any one record whose session no longer existed —
 *    a delivery-events record still keyed by the retired identity, a member
 *    manifest line still bound to it — because it could not map an identity that
 *    was already gone. These are NOT refused: the owning reader (channelsEvents,
 *    channelsProtocol) CARRIES the retired identity as found, under
 *    `preCutoverSession` with no `sessionId`. Refusing the whole store over one
 *    such record would assert it is pre-cutover when it was correctly migrated,
 *    and would make valid post-migration history unreadable.
 *
 * This module pins the floor and the sentence for case 1 only. Neither the note
 * nor `PreCutoverStoreError` belongs on a case-2 carry: recognising a shape is
 * each reader's own knowledge, because each store's shape is different, and this
 * module must not tempt a future reader into refusing what its peers carry.
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
