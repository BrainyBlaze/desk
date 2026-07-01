import { describe, expect, it } from 'vitest';
import {
  cancellationTokenToAbortSignal,
  monacoPositionToLsp,
  monacoRangeToLsp
} from '../src/web/editor/lsp/adapterConversions';

/** Fake Monaco CancellationToken whose listener can be fired and whose registration tracks disposal. */
function makeToken() {
  let listener: (() => void) | undefined;
  return {
    isCancellationRequested: false,
    onCancellationRequested(cb: () => void) {
      listener = cb;
      return {
        dispose() {
          listener = undefined;
        }
      };
    },
    fire() {
      if (listener !== undefined) {
        listener();
      }
    }
  };
}

describe('monacoPositionToLsp', () => {
  it('converts 1-based Monaco position to 0-based LSP position', () => {
    expect(monacoPositionToLsp({ lineNumber: 3, column: 7 })).toEqual({ line: 2, character: 6 });
  });

  it('maps the Monaco origin (1,1) to the LSP origin (0,0)', () => {
    expect(monacoPositionToLsp({ lineNumber: 1, column: 1 })).toEqual({ line: 0, character: 0 });
  });
});

describe('monacoRangeToLsp', () => {
  it('converts both range endpoints from 1-based Monaco to 0-based LSP', () => {
    expect(
      monacoRangeToLsp({ startLineNumber: 1, startColumn: 1, endLineNumber: 4, endColumn: 9 })
    ).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 3, character: 8 }
    });
  });
});

describe('cancellationTokenToAbortSignal', () => {
  it('returns an already-aborted signal when the token is already cancelled', () => {
    const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) };
    const { signal } = cancellationTokenToAbortSignal(token);
    expect(signal.aborted).toBe(true);
  });

  it('aborts the signal when a non-cancelled token later fires cancellation', () => {
    const token = makeToken();
    const { signal } = cancellationTokenToAbortSignal(token);
    expect(signal.aborted).toBe(false);
    token.fire();
    expect(signal.aborted).toBe(true);
  });

  it('dispose unsubscribes so later cancellation does not abort', () => {
    const token = makeToken();
    const { signal, dispose } = cancellationTokenToAbortSignal(token);
    dispose();
    token.fire();
    expect(signal.aborted).toBe(false);
  });
});
