/**
 * The keyboard-cursor id to seed when switching TO a channel without an explicit
 * navigation target.
 *
 * Switching channels must NOT carry the previous channel's cursor: that id is
 * absent from the new window, so the first j/k falls through adjacentMessageId's
 * not-found branch and jumps to the oldest (j) or newest (k) loaded row. But
 * seeding null is not enough either — null takes the same not-found branch, so
 * the first j still enters at the oldest row. We instead seed an id that IS in
 * the window the switch lands on, so the first j advances from the current view:
 *
 *   - A plain cached restore lands on the remembered viewport, whose anchor
 *     message (savedAnchorMessageId) is in the cached window → seed it.
 *   - A fresh visit or an unread-reanchor re-fetches a window centred on the
 *     read/unread boundary, so the SAVED viewport anchor may be off-window;
 *     seed the read anchor (readAnchorId), which sits at that boundary instead.
 *
 * Falling back to null is harmless: it is no worse than the pre-seed behaviour
 * (first j → oldest row) for a channel never visited or read.
 */
export function channelSwitchCursorSeed(
  savedAnchorMessageId: string | null | undefined,
  readAnchorId: string | null | undefined,
  useSavedAnchor: boolean
): string | null {
  if (useSavedAnchor) {
    return savedAnchorMessageId ?? readAnchorId ?? null;
  }
  return readAnchorId ?? null;
}
