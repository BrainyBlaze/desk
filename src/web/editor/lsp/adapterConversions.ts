/**
 * Register-adapter input conversions (Monaco -> LSP).
 *
 * The Monaco-registration adapter speaks Monaco's 1-based coordinates and CancellationToken, while
 * the connection bridges speak LSP's 0-based coordinates and AbortSignal. These pure helpers cross
 * that boundary. Inputs are minimal structural shapes (not the monaco runtime types) so the helpers
 * stay headless and unit-testable, mirroring the ProviderConnection pattern in providers.ts.
 *
 * The coordinate rule matches documentSync.ts toLspPosition: line = lineNumber - 1, character = column - 1.
 */

import type { LspPosition, LspRange } from './resultConverters.js';

/** Minimal shape of a Monaco position (1-based line/column). */
export interface MonacoPositionLike {
  lineNumber: number;
  column: number;
}
/** Minimal shape of a Monaco range (1-based line/column endpoints). */
export interface MonacoRangeLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}
/** Minimal shape of a Monaco CancellationToken. */
export interface CancellationTokenLike {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/** Convert a 1-based Monaco position to a 0-based LSP position. */
export function monacoPositionToLsp(position: MonacoPositionLike): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

/** Convert a 1-based Monaco range to a 0-based LSP range (both endpoints). */
export function monacoRangeToLsp(range: MonacoRangeLike): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
  };
}

/**
 * Bridge a Monaco CancellationToken to an AbortSignal. Aborts immediately if the token is already
 * cancelled; otherwise aborts when the token fires. dispose() unsubscribes the listener so a later
 * cancellation no longer aborts the signal (and the registration does not leak).
 */
export function cancellationTokenToAbortSignal(
  token: CancellationTokenLike
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
    return { signal: controller.signal, dispose() {} };
  }
  const registration = token.onCancellationRequested(() => controller.abort());
  return {
    signal: controller.signal,
    dispose() {
      registration.dispose();
    }
  };
}
