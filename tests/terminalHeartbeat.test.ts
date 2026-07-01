import { describe, expect, it } from 'vitest';
import { emitBridgeRetry, subscribeBridgeRetry } from '../src/web/terminalHeartbeat.js';

describe('terminalHeartbeat', () => {
  it('notifies every subscriber on emit', () => {
    let a = 0;
    let b = 0;
    const offA = subscribeBridgeRetry(() => (a += 1));
    const offB = subscribeBridgeRetry(() => (b += 1));
    emitBridgeRetry();
    expect(a).toBe(1);
    expect(b).toBe(1);
    offA();
    offB();
  });

  it('stops notifying after unsubscribe', () => {
    let count = 0;
    const off = subscribeBridgeRetry(() => (count += 1));
    off();
    emitBridgeRetry();
    expect(count).toBe(0);
  });

  it('tolerates a subscriber unsubscribing during emit', () => {
    let calls = 0;
    const off = subscribeBridgeRetry(() => {
      calls += 1;
      off(); // mutate the set mid-iteration — the snapshot copy must survive
    });
    emitBridgeRetry();
    emitBridgeRetry();
    expect(calls).toBe(1);
  });
});
