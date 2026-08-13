// Daemon socket/RPC server integration (spec §3.2/§3.7). Starts the real
// unix-socket daemon around DaemonCore, drives it over a client socket, and
// checks the single-instance lock. Node stdlib only — no moor binary.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, type Socket } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { DaemonCore, WorkerSupervisor, type EmulatorPort, type EmulatorEvent } from '../src/shared/runtime/index.js';
import { encodeRequest, decodeResponse, type RpcResponse } from '../src/shared/runtime/rpcEnvelope.js';
import { DaemonServer } from '../src/server/runtime/daemonServer.js';

class FakeEmu implements EmulatorPort {
  write(): void {}
  resize(): void {}
  readTailText(): string[] {
    return [];
  }
  serialize(): string {
    return '';
  }
  cursor(): { row: number; col: number } {
    return { row: 0, col: 0 };
  }
  onEvent(_cb: (e: EmulatorEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
}

function makeCore(maxLiveWorkers = 256): DaemonCore {
  const clock = { t: 1000 };
  return new DaemonCore({
    ledger: new GenerationLedger(new InMemoryGenerationLedger()),
    supervisor: new WorkerSupervisor({ maxLiveWorkers, shardThreshold: 128, restoreConcurrency: 8, backoffBaseMs: 250, backoffMaxMs: 30_000, backoffFactor: 2 }),
    emulatorFactory: { create: () => new FakeEmu() },
    now: () => clock.t,
    sendBrowser: () => {},
    sendMaster: () => {}
  });
}

/** Open a client and issue sequential newline-framed RPC calls. */
class RpcClient {
  private sock: Socket;
  private buf = '';
  private waiters: ((line: string) => void)[] = [];
  private nextId = 1;
  constructor(sockPath: string) {
    this.sock = connect(sockPath);
    this.sock.setEncoding('utf8');
    this.sock.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        this.waiters.shift()?.(line);
      }
    });
  }
  ready(): Promise<void> {
    return new Promise((resolve) => this.sock.once('connect', () => resolve()));
  }
  call(method: string, params?: unknown): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise<RpcResponse>((resolve) => {
      this.waiters.push((line) => resolve(decodeResponse(line)));
      this.sock.write(encodeRequest(method, id, params) + '\n');
    });
  }
  close(): void {
    this.sock.destroy();
  }
}

describe('daemon server — RPC over a real unix socket (§3.2)', () => {
  let dir: string;
  let server: DaemonServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsk-'));
    server = new DaemonServer({ sockPath: join(dir, 'rt.sock'), lockPath: join(dir, 'daemon.lock'), core: makeCore() });
    await server.start();
  });
  afterEach(async () => {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers ping', async () => {
    const c = new RpcClient(join(dir, 'rt.sock'));
    await c.ready();
    const r = await c.call('ping');
    expect(r.ok).toBe(true);
    expect((r.result as { pong: boolean }).pong).toBe(true);
    c.close();
  });

  it('ensure → list → state round-trips a session', async () => {
    const c = new RpcClient(join(dir, 'rt.sock'));
    await c.ready();
    const ensure = await c.call('ensure', { sessionId: 'web-1', rows: 40, cols: 120 });
    expect(ensure.ok).toBe(true);
    expect((ensure.result as { generation: number }).generation).toBe(2);

    const list = await c.call('list');
    expect((list.result as unknown[]).length).toBe(1);

    const state = await c.call('state', { sessionId: 'web-1' });
    expect(state.result).toEqual((list.result as unknown[])[0]);
    expect(state.result).toMatchObject({
      lifecycle: 'starting',
      subject: { kind: 'terminal' }
    });
    c.close();
  });

  it('unknown method and unknown session return typed errors', async () => {
    const c = new RpcClient(join(dir, 'rt.sock'));
    await c.ready();
    expect((await c.call('bogus')).error?.code).toBe('unknown-method');
    expect((await c.call('state', { sessionId: 'nope' })).error?.code).toBe('no-session');
    c.close();
  });

  it('stop refuses while a session is live unless forced', async () => {
    const c = new RpcClient(join(dir, 'rt.sock'));
    await c.ready();
    await c.call('ensure', { sessionId: 'web-1', rows: 24, cols: 80 });
    const refuse = await c.call('stop', { forced: false });
    expect((refuse.result as { action: string }).action).toBe('refuse');
    const ok = await c.call('stop', { forced: true });
    expect((ok.result as { action: string }).action).toBe('stop');
    c.close();
  });
});

describe('daemon server — single-instance lock repair (§3.7)', () => {
  // The live-peer DEFER path needs a second OS process; decideLock's defer /
  // PID-reuse / stale logic is unit-tested in runtime.test.ts. Here we verify the
  // server repairs a stale lock (dead pid) and comes up serving — the reliably
  // in-process-testable half.
  it('repairs a stale lock left by a dead pid and starts serving', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsk-'));
    const deadPid = 0x7ffffff0; // far above any live pid → not running
    writeFileSync(join(dir, 'daemon.lock'), JSON.stringify({ pid: deadPid, startTime: 12345, sockPath: join(dir, 'old.sock'), version: '1' }));
    const s = new DaemonServer({ sockPath: join(dir, 'rt.sock'), lockPath: join(dir, 'daemon.lock'), core: makeCore() });
    await s.start(); // acquires (stale-dead-pid), must not throw
    const c = new RpcClient(join(dir, 'rt.sock'));
    await c.ready();
    expect((await c.call('ping')).ok).toBe(true);
    c.close();
    await s.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
