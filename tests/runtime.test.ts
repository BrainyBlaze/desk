// desk-runtime daemon pure cores (spec §3.2/§3.3): worker supervisor (fail-closed
// cap, bounded backoff, sharding, visible-first restore), instance lock (PID +
// start-time reuse guard, stop refusal), RPC version negotiation.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  RPC_VERSION,
  RpcError,
  WorkerSupervisor,
  decideLock,
  decideStop,
  decodeRequest,
  decodeResponse,
  encodeErr,
  encodeOk,
  encodeRequest,
  type LockRecord
} from '../src/shared/runtime/index.js';

const T0 = 1_000_000;

// ---- worker supervisor (§3.3) -----------------------------------------------
describe('runtime — worker supervisor cap (§3.3)', () => {
  it('admits up to MAX_LIVE_WORKERS then FAILS CLOSED', () => {
    const sup = new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 3, shardThreshold: 2 });
    expect(sup.admit('a', T0).ok).toBe(true);
    expect(sup.admit('b', T0).ok).toBe(true);
    expect(sup.admit('c', T0).ok).toBe(true);
    const over = sup.admit('d', T0);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toBe('cap-exceeded');
      expect(over.cap).toBe(3);
    }
  });

  it('admit is idempotent for an already-live session', () => {
    const sup = new WorkerSupervisor();
    const first = sup.admit('a', T0);
    const again = sup.admit('a', T0);
    expect(again.ok).toBe(true);
    expect(sup.liveCount).toBe(1);
    if (first.ok && again.ok) expect(again.shardIndex).toBe(first.shardIndex);
  });

  it('release frees a slot so a refused session can be admitted', () => {
    const sup = new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 1 });
    expect(sup.admit('a', T0).ok).toBe(true);
    expect(sup.admit('b', T0).ok).toBe(false);
    sup.release('a');
    expect(sup.admit('b', T0).ok).toBe(true);
  });

  it('shards once live exceeds the threshold (§3.3 shard at > max/2)', () => {
    const sup = new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 256, shardThreshold: 128 });
    expect(sup.shardCount(1)).toBe(1);
    expect(sup.shardCount(128)).toBe(1);
    expect(sup.shardCount(129)).toBe(2);
    expect(sup.shardCount(256)).toBe(2);
    expect(sup.shardCount(257)).toBe(3);
  });

  it('restart backoff is bounded-exponential', () => {
    const sup = new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, backoffBaseMs: 250, backoffFactor: 2, backoffMaxMs: 1000 });
    expect(sup.recordCrash('a', T0).nextRetryAt).toBe(T0 + 250); // attempt 1
    expect(sup.recordCrash('a', T0).nextRetryAt).toBe(T0 + 500); // attempt 2
    expect(sup.recordCrash('a', T0).nextRetryAt).toBe(T0 + 1000); // attempt 3 → 1000
    expect(sup.recordCrash('a', T0).nextRetryAt).toBe(T0 + 1000); // attempt 4 → capped at max
  });

  it('canRestart gates on the elapsed backoff; a successful admit clears it', () => {
    const sup = new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, backoffBaseMs: 500 });
    sup.recordCrash('a', T0);
    expect(sup.canRestart('a', T0 + 100)).toBe(false);
    expect(sup.canRestart('a', T0 + 600)).toBe(true);
    sup.admit('a', T0 + 600); // successful readmit
    expect(sup.canRestart('a', T0 + 601)).toBe(true); // backoff cleared
  });

  it('planRestore batches visible-first at restoreConcurrency', () => {
    const sup = new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, restoreConcurrency: 2 });
    const waves = sup.planRestore([
      { sessionId: 'h1', visible: false },
      { sessionId: 'v1', visible: true },
      { sessionId: 'h2', visible: false },
      { sessionId: 'v2', visible: true },
      { sessionId: 'h3', visible: false }
    ]);
    expect(waves[0]).toEqual(['v1', 'v2']); // visible lead, first wave
    expect(waves).toHaveLength(3);
    expect(waves.flat()).toHaveLength(5);
  });
});

// ---- instance lock (§3.2) ---------------------------------------------------
describe('runtime — instance lock PID+start-time (§3.2)', () => {
  const rec = (over: Partial<LockRecord> = {}): LockRecord => ({
    pid: 100,
    startTime: 5555,
    sockPath: '/run/desk.sock',
    version: '1',
    ...over
  });

  it('acquires when no lock exists', () => {
    expect(decideLock(null, { pid: 1, startTime: 1 }, { alive: false, startTime: null })).toEqual({
      action: 'acquire',
      reason: 'no-lock'
    });
  });

  it('recognizes self (pid+startTime match)', () => {
    expect(decideLock(rec(), { pid: 100, startTime: 5555 }, { alive: true, startTime: 5555 })).toEqual({ action: 'is-self' });
  });

  it('acquires when the holder pid is dead', () => {
    const d = decideLock(rec(), { pid: 200, startTime: 9 }, { alive: false, startTime: null });
    expect(d).toEqual({ action: 'acquire', reason: 'stale-dead-pid' });
  });

  it('acquires when the pid is alive but start-time differs (PID reuse)', () => {
    const d = decideLock(rec({ startTime: 5555 }), { pid: 200, startTime: 9 }, { alive: true, startTime: 8888 });
    expect(d).toEqual({ action: 'acquire', reason: 'stale-pid-reused' });
  });

  it('defers to a genuinely live peer (alive + start-time matches)', () => {
    const d = decideLock(rec(), { pid: 200, startTime: 9 }, { alive: true, startTime: 5555 });
    expect(d.action).toBe('defer');
    if (d.action === 'defer') expect(d.holder.pid).toBe(100);
  });

  it('stop refuses while sessions live unless forced (§11.4)', () => {
    expect(decideStop(3, false)).toEqual({ action: 'refuse', liveSessions: 3 });
    expect(decideStop(3, true)).toEqual({ action: 'stop' });
    expect(decideStop(0, false)).toEqual({ action: 'stop' });
  });
});

// ---- RPC envelope (§3.2) ----------------------------------------------------
describe('runtime — RPC version negotiation (§3.2)', () => {
  it('round-trips a request', () => {
    const req = decodeRequest(encodeRequest('ensure', 7, { cwd: '/x' }));
    expect(req).toEqual({ v: RPC_VERSION, id: 7, method: 'ensure', params: { cwd: '/x' } });
  });

  it('round-trips ok and error responses', () => {
    expect(decodeResponse(encodeOk(7, { port: 5173 }))).toEqual({ v: RPC_VERSION, id: 7, ok: true, result: { port: 5173 }, error: undefined });
    const err = decodeResponse(encodeErr(7, 'no-daemon', 'not running'));
    expect(err.ok).toBe(false);
    expect(err.error).toEqual({ code: 'no-daemon', message: 'not running' });
  });

  it('rejects a version mismatch before trusting the shape', () => {
    const wrong = JSON.stringify({ v: 999, id: 1, method: 'x' });
    try {
      decodeRequest(wrong);
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe('bad-version');
    }
  });

  it('rejects malformed JSON / missing fields', () => {
    expect(() => decodeRequest('{not json')).toThrow(RpcError);
    expect(() => decodeRequest(JSON.stringify({ v: RPC_VERSION, id: 1 }))).toThrow(/method/);
  });
});
