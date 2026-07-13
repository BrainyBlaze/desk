import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as terminalClipboardModule from '../src/web/terminalClipboard.js';
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

  it('falls back when async clipboard writes are unavailable or reject', async () => {
    const copy = (
      terminalClipboardModule as unknown as {
        copyTextWithFallback?: (
          text: string,
          clipboard?: { writeText(value: string): Promise<void> },
          fallback?: (value: string) => boolean
        ) => Promise<boolean>;
      }
    ).copyTextWithFallback;
    const fallbackValues: string[] = [];
    const fallback = (value: string): boolean => {
      fallbackValues.push(value);
      return true;
    };

    expect(copy).toBeTypeOf('function');
    await expect(copy?.('secure', { writeText: async () => undefined }, fallback)).resolves.toBe(true);
    await expect(copy?.('rejected', { writeText: async () => Promise.reject(new Error('denied')) }, fallback)).resolves.toBe(true);
    await expect(copy?.('missing', undefined, fallback)).resolves.toBe(true);
    expect(fallbackValues).toEqual(['rejected', 'missing']);
  });

  it('routes terminal surface and terminal selection-menu copies through the fallback helper', () => {
    const appSource = readFileSync(new URL('../src/web/App.tsx', import.meta.url), 'utf8');
    const terminalSource = readFileSync(new URL('../src/web/TerminalSurface.tsx', import.meta.url), 'utf8');

    expect(appSource).toContain('void copyTextWithFallback(text)');
    expect(terminalSource.match(/void copyTextWithFallback\(/g)).toHaveLength(4);
    expect(terminalSource).not.toContain('function fallbackCopyText');
  });

  it('scopes the terminal context menu to the terminal selection', () => {
    const terminalSource = readFileSync(new URL('../src/web/TerminalSurface.tsx', import.meta.url), 'utf8');

    expect(terminalSource).toMatch(
      /const handleContextMenu = \(event: MouseEvent\): void => \{\s+const selection = terminal\.getSelection\(\);/
    );
  });
});
