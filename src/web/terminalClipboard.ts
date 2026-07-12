/**
 * Whether a right-click on the terminal should suppress the browser's native
 * context menu and handle the gesture itself.
 *
 * We may only swallow the native menu when we can offer something better in its
 * place:
 *   - a selection to copy, or
 *   - an async-clipboard read to paste from.
 *
 * On a plain-HTTP (non-secure) deployment `navigator.clipboard.readText` is
 * absent. A right-click there with NO selection previously still called
 * preventDefault and then no-oped on the missing async clipboard — swallowing
 * the gesture into a dead end and, critically, suppressing the native menu's
 * own Paste item. Returning false in that case lets the native menu through so
 * paste still works without a secure context.
 */
export function shouldSuppressContextMenu(hasSelection: boolean, canReadAsyncClipboard: boolean): boolean {
  return hasSelection || canReadAsyncClipboard;
}
