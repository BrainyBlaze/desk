import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Socket } from 'node:net';
import { MasterClient } from '../src/server/runtime/masterClient.js';
import { spawnMaster } from '../src/server/runtime/spawnMaster.js';
import { Role } from '../src/shared/atchWire/frames.js';

const ATCH_BIN = process.env.ATCH_BIN ?? join(__dirname, '..', 'libexec', 'atch');
const AVAILABLE =
  existsSync(ATCH_BIN) &&
  existsSync('/proc/self/fd') &&
  process.env.RUN_REAL_JOIN === '1';
const UID = typeof process.getuid === 'function' ? process.getuid() : 1000;
const SOCK_DIR = `/tmp/.atch-${UID}`;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  predicate: () => boolean,
  timeoutMs: number,
  stepMs = 25
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(stepMs);
  }
  return predicate();
}

function findMasterPid(socketPath: string, sessionId: string): number | undefined {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (
        (cmdline.includes(socketPath) || cmdline.includes(sessionId)) &&
        cmdline.includes(ATCH_BIN)
      ) {
        return Number(entry);
      }
    } catch {
      // Process vanished during the scan.
    }
  }
  return undefined;
}

async function attach(
  socketPath: string,
  sessionId: string,
  onRaw?: (length: number) => void
): Promise<MasterClient> {
  let acked = false;
  const client = new MasterClient(socketPath, {
    onRaw: (bytes) => onRaw?.(bytes.byteLength),
    onAttachAck: () => {
      acked = true;
    }
  });
  await client.connect();
  client.handshake({
    role: Role.CONTROLLER,
    sessionId,
    rows: 40,
    cols: 120
  });
  expect(await until(() => acked, 6000), 'controller ATTACH_ACK').toBe(true);
  return client;
}

describe.skipIf(!AVAILABLE)('atch v3 controller backpressure', () => {
  const sessions: string[] = [];
  const clients: MasterClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const name of sessions.splice(0)) {
      spawn(ATCH_BIN, ['kill', '-f', join(SOCK_DIR, name)], {
        stdio: 'ignore'
      }).unref();
      rmSync(join(SOCK_DIR, name), { force: true });
    }
    await wait(200);
  });

  it('drops a stalled v3 reader without killing the master or child', async () => {
    const name = `deskbp${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    const socketPath = join(SOCK_DIR, name);
    sessions.push(name);
    await spawnMaster({
      binPath: ATCH_BIN,
      args: [
        'start',
        name,
        'sh',
        '-c',
        "IFS= read -r _; yes 0123456789abcdef | head -c 67108864; sleep 60"
      ],
      sockPath: socketPath,
      generation: 1,
      detached: true,
      readyTimeoutMs: 6000
    });

    let fastBytes = 0;
    const fast = await attach(socketPath, name, (length) => {
      fastBytes += length;
    });
    const slow = await attach(socketPath, name);
    clients.push(fast, slow);

    const slowSocket = (
      slow as unknown as { sock: Socket | null }
    ).sock;
    expect(slowSocket, 'slow controller socket').not.toBeNull();
    slowSocket!.pause();

    const masterPid = findMasterPid(socketPath, name);
    expect(masterPid, 'daemonized atch master pid').toBeTruthy();
    fast.sendInput(new TextEncoder().encode('\n'), false, 1);

    expect(
      await until(
        () =>
          fastBytes >= 8 * 1024 * 1024 ||
          !existsSync(`/proc/${masterPid}`),
        20_000
      ),
      'fast controller receives output or the broken master dies'
    ).toBe(true);
    expect(existsSync(`/proc/${masterPid}`), 'master survived slow-reader backpressure').toBe(true);
    expect(fastBytes, 'fast controller continued receiving after slow reader stalled').toBeGreaterThanOrEqual(
      8 * 1024 * 1024
    );
    expect(existsSync(socketPath), 'live session socket remains present').toBe(true);
  }, 40_000);
});
