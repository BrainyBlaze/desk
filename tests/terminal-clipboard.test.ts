import { describe, expect, it } from 'vitest';
import { shouldSuppressContextMenu } from '../src/web/terminalClipboard.js';

describe('shouldSuppressContextMenu', () => {
  it('suppresses the native menu when there is a selection to copy (secure OR plain HTTP)', () => {
    expect(shouldSuppressContextMenu(true, true)).toBe(true);
    expect(shouldSuppressContextMenu(true, false)).toBe(true);
  });

  it('suppresses the native menu with no selection ONLY when async clipboard read is available', () => {
    expect(shouldSuppressContextMenu(false, true)).toBe(true);
  });

  it('lets the native menu through on plain HTTP with no selection (so its Paste item works)', () => {
    // The exact regression: no selection + no async clipboard must NOT swallow
    // the gesture — otherwise right-click paste is impossible on a non-secure
    // context.
    expect(shouldSuppressContextMenu(false, false)).toBe(false);
  });
});
