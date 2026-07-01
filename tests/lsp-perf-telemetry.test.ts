import { afterEach, describe, expect, it } from 'vitest';
import {
  isPerfEnabled,
  perfMarkBackendReady,
  perfMarkFirst,
  perfMarkOpen,
  perfMarkRequest,
  perfMarkSessionCreate,
  perfMarkSessionReady,
  perfReset,
  perfSnapshot,
  setPerfEnabled,
  __setPerfNow
} from '../src/web/editor/lsp/perfTelemetry';

afterEach(() => {
  setPerfEnabled(false);
  perfReset();
  __setPerfNow(null); // restore default clock
});

describe('perfTelemetry', () => {
  it('is a no-op when disabled (zero cost, empty snapshot)', () => {
    setPerfEnabled(false);
    expect(isPerfEnabled()).toBe(false);
    perfMarkOpen();
    perfMarkRequest('textDocument/semanticTokens/full', 'start');
    perfMarkFirst('diagnostic');
    const snap = perfSnapshot();
    expect(snap.t0).toBeNull();
    expect(snap.methodCounts).toEqual({});
    expect(snap.firstResultMs).toEqual({});
  });

  it('counts provider requests by method with start/finish/cancel when enabled', () => {
    setPerfEnabled(true);
    let t = 0;
    __setPerfNow(() => t);
    perfMarkOpen();
    perfMarkRequest('textDocument/semanticTokens/full', 'start');
    perfMarkRequest('textDocument/semanticTokens/full', 'finish');
    perfMarkRequest('textDocument/codeLens', 'start');
    perfMarkRequest('textDocument/codeLens', 'cancel');
    const snap = perfSnapshot();
    expect(snap.methodCounts['textDocument/semanticTokens/full']).toEqual({ start: 1, finish: 1, cancel: 0 });
    expect(snap.methodCounts['textDocument/codeLens']).toEqual({ start: 1, finish: 0, cancel: 1 });
  });

  it('records the FIRST visible result per kind relative to open, ignoring later ones', () => {
    setPerfEnabled(true);
    let t = 100;
    __setPerfNow(() => t);
    perfMarkOpen(); // t0 = 100
    t = 350;
    perfMarkFirst('diagnostic'); // 250ms after open
    t = 900;
    perfMarkFirst('diagnostic'); // ignored (already recorded)
    t = 500;
    perfMarkFirst('semanticTokens');
    const snap = perfSnapshot();
    expect(snap.firstResultMs.diagnostic).toBe(250);
    expect(snap.firstResultMs.semanticTokens).toBe(400);
  });

  it('records backend ready-envelope timing (createSession/acceptToReady) when enabled', () => {
    setPerfEnabled(true);
    perfMarkBackendReady(195.8, 42.3);
    const snap = perfSnapshot();
    expect(snap.backendCreateSessionMs).toBe(195.8);
    expect(snap.backendAcceptToReadyMs).toBe(42.3);
  });

  it('ignores backend ready-envelope timing when disabled', () => {
    setPerfEnabled(false);
    perfMarkBackendReady(195.8, 42.3);
    const snap = perfSnapshot();
    expect(snap.backendCreateSessionMs).toBeNull();
    expect(snap.backendAcceptToReadyMs).toBeNull();
  });

  it('records websocket session create->ready elapsed', () => {
    setPerfEnabled(true);
    let t = 1000;
    __setPerfNow(() => t);
    perfMarkSessionCreate();
    t = 1620;
    perfMarkSessionReady();
    expect(perfSnapshot().sessionReadyMs).toBe(620);
  });

  it('reset clears all collected state', () => {
    setPerfEnabled(true);
    __setPerfNow(() => 5);
    perfMarkOpen();
    perfMarkRequest('textDocument/hover', 'start');
    perfReset();
    const snap = perfSnapshot();
    expect(snap.t0).toBeNull();
    expect(snap.methodCounts).toEqual({});
  });
});
