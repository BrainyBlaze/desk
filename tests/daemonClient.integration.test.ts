// Web-server → daemon RPC client integration (spec §3.2/§3.4). Drives the real
// DaemonClient against the real DaemonServer over a unix socket.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { DaemonCore, WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG, type EmulatorPort, type EmulatorEvent } from '../src/shared/runtime/index.js';
import { DaemonServer } from '../src/server/runtime/daemonServer.js';
import { DaemonClient } from '../src/server/runtime/daemonClient.js';

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

function makeCore(): DaemonCore {
  return new DaemonCore({
    ledger: new GenerationLedger(new InMemoryGenerationLedger()),
    supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
    emulatorFactory: { create: () => new FakeEmu() },
    now: () => 1000,
    sendBrowser: () => {},
    sendMaster: () => {}
  });
}

describe('daemon client ↔ server RPC (§3.2/§3.4)', () => {
  let dir: string;
  let server: DaemonServer;
  let client: DaemonClient;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dc-'));
    server = new DaemonServer({ sockPath: join(dir, 'rt.sock'), lockPath: join(dir, 'daemon.lock'), core: makeCore() });
    await server.start();
    client = new DaemonClient();
    await client.connect(join(dir, 'rt.sock'));
  });
  afterEach(async () => {
    client.close();
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ping / ensure / list / state round-trip', async () => {
    expect((await client.ping()).pong).toBe(true);
    const ens = await client.ensure('web-1', 40, 120);
    expect(ens).toEqual({ generation: 1, created: true });
    const list = await client.list();
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe('web-1');
    expect((await client.state('web-1')).state).toBe('unknown');
  });

  it('an error envelope throws through the convenience API', async () => {
    await expect(client.state('ghost')).rejects.toThrow(/no-session/);
  });

  it('concurrent calls are id-correlated', async () => {
    await client.ensure('a', 1, 1);
    await client.ensure('b', 1, 1);
    const [sa, sb, list] = await Promise.all([client.state('a'), client.state('b'), client.list()]);
    expect(sa.generation).toBe(1);
    expect(sb.generation).toBe(1);
    expect(list).toHaveLength(2);
  });

  it('retire removes a session', async () => {
    await client.ensure('web-1', 1, 1);
    expect(await client.retire('web-1')).toEqual({ retired: true });
    expect(await client.list()).toHaveLength(0);
  });
});
