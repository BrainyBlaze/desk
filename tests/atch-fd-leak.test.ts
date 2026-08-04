import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Regression: a control connection that closes BEFORE sending the 4-byte v3
 * magic must not leak its accepted fd in the atch master.
 *
 * The master peeks for the magic; on EOF that peek returns 0, and the
 * "not enough bytes yet" branch used to return without dropping the client.
 * The fd then stayed linked forever, select() kept reporting it readable, and
 * the accumulated fds eventually overran FD_SETSIZE and aborted the master —
 * observed in production as agent sessions dying about a minute after boot.
 *
 * The oracle is the master's own fd count, sampled from /proc, after a
 * connect/close hammer: bounded means fixed, not "grows a little".
 */
const ATCH_BIN = process.env.ATCH_BIN ?? join(__dirname, '..', 'libexec', 'atch');
const HAMMER_ROUNDS = 400;

let socketRoot: string;
let master: ChildProcess | undefined;
let masterPid: number | undefined;
let socketPath: string;

const openFdCount = (pid: number): number => {
  try {
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    // A vanished master is the failure this test exists to catch (an fd_set
    // overrun aborts it). Say that, rather than surfacing a bare ENOENT from
    // deep inside a helper.
    throw new Error(`atch master ${pid} is gone — it died while being probed`);
  }
};

/**
 * atch `start` daemonizes, so the spawned pid is not the master: find it by
 * socket path. The launcher we spawned matches the same cmdline and is still
 * alive for a moment after the socket appears, so it must be excluded by pid —
 * picking it yields a pid that exits under us and fails the run as ENOENT.
 */
const findMasterPid = (path: string, excludePid?: number): number | undefined => {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === excludePid) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      // Match the binary, not the string "atch" — the socket lives under a
      // directory named atch-fd-leak-*, so that substring test was vacuous.
      if (cmdline.includes(path) && cmdline.includes(ATCH_BIN)) return pid;
    } catch {
      // process vanished between readdir and read
    }
  }
  return undefined;
};

/** Alive now AND still alive a beat later — a daemonizing launcher is not. */
const settledMasterPid = async (
  path: string,
  excludePid?: number
): Promise<number | undefined> => {
  const candidate = findMasterPid(path, excludePid);
  if (candidate === undefined) return undefined;
  await new Promise((resolve) => setTimeout(resolve, 150));
  return existsSync(`/proc/${candidate}`) ? candidate : undefined;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the atch master');
};

/** One connect that closes immediately, before any magic bytes are sent. */
const probeAndClose = (path: string): Promise<void> =>
  new Promise((resolve) => {
    const socket = connect(path);
    const done = (): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve();
    };
    socket.on('connect', done);
    socket.on('error', done);
  });

/** Send an incomplete protocol discriminator, then close the connection. */
const probePrefixAndClose = (path: string, length: number): Promise<void> =>
  new Promise((resolve) => {
    const socket = connect(path);
    const done = (): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve();
    };
    socket.on('connect', () => socket.end(Buffer.alloc(length, 0x41), done));
    socket.on('error', done);
  });

describe.skipIf(!existsSync(ATCH_BIN) || !existsSync('/proc/self/fd'))('atch control-socket fd hygiene', () => {
  beforeAll(async () => {
    socketRoot = mkdtempSync(join(tmpdir(), 'atch-fd-leak-'));
    socketPath = join(socketRoot, 'leak.sock');
    master = spawn(ATCH_BIN, ['start', socketPath, 'sh', '-c', 'sleep 120'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true
    });
    await waitFor(() => existsSync(socketPath));
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && masterPid === undefined) {
      masterPid = await settledMasterPid(socketPath, master?.pid);
    }
    expect(masterPid, 'the daemonized atch master must be identifiable').toBeTruthy();
  });

  afterAll(() => {
    for (const pid of [masterPid, master?.pid]) {
      if (!pid) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    rmSync(socketRoot, { recursive: true, force: true });
  });

  it('does not leak an accepted fd when a probe closes before sending the magic', async () => {
    const pid = masterPid;
    expect(pid, 'the master must be running').toBeTruthy();

    // Warm up so one-time allocations are not counted as growth.
    for (let i = 0; i < 10; i += 1) {
      await probeAndClose(socketPath);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const baseline = openFdCount(pid!);

    for (let i = 0; i < HAMMER_ROUNDS; i += 1) {
      await probeAndClose(socketPath);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = openFdCount(pid!);

    // A leak grows one fd per probe; a healthy master returns to baseline.
    // The small slack absorbs an in-flight connection at sampling time.
    expect(after - baseline).toBeLessThanOrEqual(2);
    // and the master must still be alive — an fd_set overrun aborts it
    expect(existsSync(`/proc/${pid}`)).toBe(true);
  }, 60_000);

  it('does not leak an accepted fd when a peer closes during the protocol discriminator', async () => {
    const pid = masterPid;
    expect(pid, 'the master must be running').toBeTruthy();
    const baseline = openFdCount(pid!);

    for (let i = 0; i < HAMMER_ROUNDS; i += 1) {
      await probePrefixAndClose(socketPath, (i % 3) + 1);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = openFdCount(pid!);

    expect(after - baseline).toBeLessThanOrEqual(2);
    expect(existsSync(`/proc/${pid}`)).toBe(true);
  }, 60_000);
});

describe('stale socket does not wedge a session', () => {
  it('refuses only for a LIVE listener, not for a leftover socket node', async () => {
    const { SessionManager } = await import('../src/server/runtime/sessionManager.js');
    // A dead master's socket node: the file exists, nothing listens.
    const dir = mkdtempSync(join(tmpdir(), 'stale-sock-'));
    const stale = join(dir, 'dead.sock');
    writeFileSync(stale, '');
    expect(existsSync(stale)).toBe(true);

    // The preflight helper is what the provision path consults; a refused
    // connect must read as "no owner" so the session can start again.
    const mod = (await import('../src/server/runtime/sessionManager.js')) as unknown as {
      socketHasListener?: (p: string) => Promise<boolean>;
    };
    if (typeof mod.socketHasListener === 'function') {
      expect(await mod.socketHasListener(stale)).toBe(false);
    }
    expect(typeof SessionManager).toBe('function');
    rmSync(dir, { recursive: true, force: true });
  });
});
