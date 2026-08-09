// THE REAL JOIN (spec §7.1 / §4) — end-to-end against the REAL atch binary. The
// daemon spawns a real atch session with ATCH_GENERATION injected, attaches over
// the v3 socket, and exercises the full protocol: handshake + generation fence,
// input→output round-trip (single + multi-line), RESIZE, and the SessionManager
// production detached spawn/kill lifecycle. Runs against the binary this repo
// builds; skips cleanly when it is absent (override with ATCH_BIN).

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MasterClient } from '../src/server/runtime/masterClient.js';
import { spawnMaster } from '../src/server/runtime/spawnMaster.js';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { Role, RecordType } from '../src/shared/atchWire/frames.js';
import { type RecordEnvelope } from '../src/shared/atchWire/messages.js';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG, type EmulatorPort, type EmulatorEvent, type BpFrame } from '../src/shared/runtime/index.js';
import { XtermEmulatorFactory } from '../src/server/runtime/xtermEmulator.js';
import { BpFrameType } from '../src/shared/browserProtocol/index.js';

const ATCH_BIN = process.env.ATCH_BIN ?? join(__dirname, '..', 'libexec', 'atch');
// Real-binary tests spawn multiple live PTY sessions and are timing-sensitive, so
// they are OPT-IN (RUN_REAL_JOIN=1) — the default suite stays deterministic with
// the fake-master tests. Run explicitly to verify the join against real atch:
//   RUN_REAL_JOIN=1 npx vitest run tests/realJoin.integration.test.ts
const AVAILABLE = existsSync(ATCH_BIN) && process.env.RUN_REAL_JOIN === '1';
const UID = typeof process.getuid === 'function' ? process.getuid() : 1000;
const SOCK_DIR = `/tmp/.atch-${UID}`;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs: number, stepMs = 30): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await wait(stepMs);
  }
  return pred();
}
/** Does a live master accept a connection on this socket? (test-local mirror). */
function socketHasListenerT(path: string, timeoutMs = 250): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ path });
    const settle = (result: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}
function killSession(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const k = spawn(ATCH_BIN, ['kill', '-f', name], { stdio: 'ignore' });
      k.once('exit', () => {
        rmSync(join(SOCK_DIR, name), { force: true });
        resolve();
      });
      k.once('error', () => resolve());
    } catch {
      resolve();
    }
  });
}

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

describe.skipIf(!AVAILABLE)('REAL join — daemon ↔ real atch master (§7.1)', () => {
  const sessions: string[] = [];
  const track = (n: string) => (sessions.push(n), n);
  afterEach(async () => {
    // Await teardown so each test starts with no lingering atch processes racing
    // the next handshake (isolated they all pass; sequentially they must be clean).
    await Promise.all(sessions.splice(0).map(killSession));
    await wait(150);
  });

  /** Spawn a real atch session running `cmd` and attach a MasterClient. */
  async function openSession(cmd: string[]): Promise<{ client: MasterClient; output: () => string; ackGen: () => number }> {
    const name = track(`deskjoin${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`);
    const sockPath = join(SOCK_DIR, name);
    await spawnMaster({ binPath: ATCH_BIN, args: ['start', name, ...cmd], sockPath, generation: 1, detached: true, readyTimeoutMs: 6000 });
    const bytes: number[] = [];
    let gen = -1;
    const client = new MasterClient(sockPath, {
      onRecord: (rec: RecordEnvelope) => {
        if (rec.record_type === RecordType.OUTPUT) bytes.push(...rec.body);
      },
      onAttachAck: (ack) => (gen = (ack as { generation: number }).generation)
    });
    await client.connect();
    client.handshake({ role: Role.CONTROLLER, sessionId: name, rows: 40, cols: 120 });
    // The generation MUST be adopted before any post-attach frame, or the master
    // fences it — wait robustly for ATTACH_ACK.
    expect(await until(() => gen >= 0, 6000), 'ATTACH_ACK received').toBe(true);
    return { client, output: () => new TextDecoder().decode(Uint8Array.from(bytes)), ackGen: () => gen };
  }

  it('handshake + generation fence + single-line round-trip', { timeout: 25000 }, async () => {
    const s = await openSession(['cat']);
    try {
      expect(s.ackGen()).toBe(1); // the daemon-injected ATCH_GENERATION
      await wait(150);
      s.client.sendInput(new TextEncoder().encode('hello-join\n'), false, 1);
      expect(await until(() => s.output().includes('hello-join'), 5000)).toBe(true);
    } finally {
      s.client.close();
    }
  });

  it('multi-line round-trip preserves all lines', { timeout: 25000 }, async () => {
    const s = await openSession(['cat']);
    try {
      await wait(200);
      for (const line of ['alpha', 'bravo', 'charlie']) {
        s.client.sendInput(new TextEncoder().encode(line + '\n'), false, 1);
        await wait(120); // pace the sends so the PTY echo does not coalesce/drop under load
      }
      const ok = await until(() => {
        const t = s.output();
        return t.includes('alpha') && t.includes('bravo') && t.includes('charlie');
      }, 6000);
      expect(ok, `output: ${JSON.stringify(s.output())}`).toBe(true);
    } finally {
      s.client.close();
    }
  });

  it('RESIZE is accepted (generation-fenced) and input still round-trips after it', { timeout: 25000 }, async () => {
    const s = await openSession(['cat']);
    try {
      await wait(150);
      s.client.sendResize(50, 200, 1, 1); // fenced RESIZE — must not desync the session
      await wait(150);
      s.client.sendInput(new TextEncoder().encode('after-resize\n'), false, 1);
      expect(await until(() => s.output().includes('after-resize'), 5000)).toBe(true);
    } finally {
      s.client.close();
    }
  });

  it('SessionManager production path: detached spawn → browser OUTPUT → retire kills the session', { timeout: 25000 }, async () => {
    const name = track(`deskmgr${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`);
    const sockPath = join(SOCK_DIR, name);
    const browserOut: BpFrame[] = [];
    const mgr = new SessionManager({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: { create: () => new FakeEmu() },
      now: () => Date.now(),
      sendBrowser: (_sid, _ch, frame) => browserOut.push(frame)
    });
    const ens = await mgr.spawnAndAttach(name, {
      binPath: ATCH_BIN,
      args: ['start', name, 'cat'],
      sockPath,
      geometry: { rows: 40, cols: 120 },
      detached: true,
      killSpec: { binPath: ATCH_BIN, args: ['kill', '-f', name] },
      readyTimeoutMs: 6000
    });
    expect(ens.ok).toBe(true);
    const ch = mgr.subscribe(name, 'main', 40, 120)!;
    await wait(200);

    mgr.onBrowserInput(name, ch, false, new TextEncoder().encode('via-manager\n'));
    const got = await until(() => browserOut.some((f) => f.type === BpFrameType.OUTPUT && new TextDecoder().decode((f as Extract<BpFrame, { type: BpFrameType.OUTPUT }>).bytes).includes('via-manager')), 5000);
    expect(got).toBe(true);

    // retire runs `atch kill -f NAME`; the session socket disappears.
    mgr.retire(name);
    expect(await until(() => !existsSync(sockPath), 4000)).toBe(true);
  });

  it('reboot recovery: a leftover socket NODE with no live master does not wedge respawn', { timeout: 25000 }, async () => {
    // Reproduces the post-reboot wedge: on WSL /tmp survives a restart, so every
    // session's socket node persists after its holder was killed by the reboot.
    // The node has no listener (dead master). Both atch's own bind ("session is
    // already running") and spawnMaster's existence gate refuse an existing node
    // regardless of liveness, so without reclaiming it the session can NEVER be
    // respawned. doSpawnAndAttach must remove the listener-less tombstone and
    // spawn cleanly. A companion .log is left in place (it holds prior scrollback
    // and atch appends to it).
    const name = track(`deskreboot${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`);
    const sockPath = join(SOCK_DIR, name);

    // Fabricate the reboot leftover: a bound-then-closed AF_UNIX node with NO
    // listener. Node's net.Server.close() unlinks the path, so use a raw
    // bind()+close(), which leaves the node behind exactly as a SIGKILLed
    // holder would after a reboot.
    const { execFileSync } = await import('node:child_process');
    execFileSync('python3', [
      '-c',
      `import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()`,
      sockPath
    ]);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${sockPath}.log`, 'prior scrollback\n');
    expect(existsSync(sockPath)).toBe(true); // the tombstone is present
    expect(await socketHasListenerT(sockPath)).toBe(false); // and dead

    const mgr = new SessionManager({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: { create: () => new FakeEmu() },
      now: () => Date.now(),
      sendBrowser: () => {}
    });
    const ens = await mgr.spawnAndAttach(name, {
      binPath: ATCH_BIN,
      args: ['start', name, 'cat'],
      sockPath,
      geometry: { rows: 40, cols: 120 },
      detached: true,
      killSpec: { binPath: ATCH_BIN, args: ['kill', '-f', name] },
      readyTimeoutMs: 6000
    });
    expect(ens.ok).toBe(true); // NOT spawn-failed: the tombstone was reclaimed

    mgr.retire(name);
    expect(await until(() => !existsSync(sockPath), 4000)).toBe(true);

  it('a leftover node with a LIVE foreign master is never reclaimed (spawn refuses)', { timeout: 25000 }, async () => {
    // The dual of the reboot case: an existing socket that STILL accepts a
    // connection belongs to a live master and must never be allocated over —
    // the listener check gates the reclaim, so this spawn fails closed.
    const name = track(`desklive${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`);
    const sockPath = join(SOCK_DIR, name);
    // A real, listening master under this exact socket path.
    await spawnMaster({ binPath: ATCH_BIN, args: ['start', name, 'cat'], sockPath, generation: 1, detached: true, readyTimeoutMs: 6000 });
    expect(await socketHasListenerT(sockPath)).toBe(true);

    const mgr = new SessionManager({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: { create: () => new FakeEmu() },
      now: () => Date.now(),
      sendBrowser: () => {}
    });
    const ens = await mgr.spawnAndAttach(name, {
      binPath: ATCH_BIN,
      args: ['start', name, 'cat'],
      sockPath,
      geometry: { rows: 40, cols: 120 },
      detached: true,
      killSpec: { binPath: ATCH_BIN, args: ['kill', '-f', name] },
      readyTimeoutMs: 6000
    });
    expect(ens.ok).toBe(false); // fail closed over a live foreign master
    expect(existsSync(sockPath)).toBe(true); // and it was left untouched
  });

  it('FULL STACK with the REAL @xterm/headless emulator: real atch output renders into the screen snapshot', { timeout: 25000 }, async () => {
    const name = track(`deskfull${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`);
    const sockPath = join(SOCK_DIR, name);
    const browserOut: { channelId: number; frame: BpFrame }[] = [];
    const mgr = new SessionManager({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: new XtermEmulatorFactory(), // the REAL headless emulator
      now: () => Date.now(),
      sendBrowser: (_sid, channelId, frame) => browserOut.push({ channelId, frame })
    });
    await mgr.spawnAndAttach(name, {
      binPath: ATCH_BIN,
      args: ['start', name, 'cat'],
      sockPath,
      geometry: { rows: 24, cols: 80 },
      detached: true,
      killSpec: { binPath: ATCH_BIN, args: ['kill', '-f', name] },
      readyTimeoutMs: 6000
    });
    mgr.subscribe(name, 'surface-1', 24, 80);
    await wait(200);
    mgr.onBrowserInput(name, 1, false, new TextEncoder().encode('render-me\n'));
    // wait until the real emulator has rendered the echoed output (browser OUTPUT arrives)
    await until(() => browserOut.some((x) => x.frame.type === BpFrameType.OUTPUT && new TextDecoder().decode((x.frame as Extract<BpFrame, { type: BpFrameType.OUTPUT }>).bytes).includes('render-me')), 5000);
    await wait(150); // let the async xterm parser drain

    // A NEW surface's SNAPSHOT is the real emulator's serialized screen — it must
    // carry the rendered text, proving the headless emulator is the screen authority.
    browserOut.length = 0;
    mgr.subscribe(name, 'surface-2', 24, 80);
    const snap = browserOut.find((x) => x.frame.type === BpFrameType.SNAPSHOT) as { frame: Extract<BpFrame, { type: BpFrameType.SNAPSHOT }> } | undefined;
    expect(snap, 'snapshot emitted').toBeDefined();
    expect(snap!.frame.text, `snapshot: ${JSON.stringify(snap?.frame.text)}`).toContain('render-me');
    mgr.retire(name);
  });
});
