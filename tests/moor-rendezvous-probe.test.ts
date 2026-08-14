// The daemon's one rendezvous liveness probe, held to its three outcomes
// directly — the cheapest place to pin the invariant that every consumer
// (the spawn path's staleness fence, `/control/moor-status`'s holder verdict)
// then inherits.
//
// The asymmetry is the whole point and it is deliberate: `live` and `stale`
// are CLAIMS, and `stale` is the dangerous one because both consumers act on
// it — the spawn path unlinks a rendezvous node on it, and desk#50b's holder
// verdict turns it into a licence to start a process. So `stale` is returned
// only for a POSITIVELY established missing listener, and every other failure
// is `indeterminate`. A live holder this daemon merely cannot reach — a
// permission problem, a resource error, a slow host — must never round down to
// a dead one (desk#42).
//
// Real filesystem conditions throughout, no mocked `node:net`: the value under
// test IS the kernel's error code, so mocking the syscall would test the mock.

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeRendezvous } from '../src/server/runtime/sessionManager.js';

/** Root bypasses the DAC checks that produce EACCES, so it cannot see that case. */
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * A rendezvous node whose owner died WITHOUT unlinking it — the real shape of
 * a crashed holder, and the only honest source of ECONNREFUSED. A listener
 * closed in-process would take its node with it and yield ENOENT instead,
 * which is a different branch.
 */
async function abandonedRendezvous(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => process.stdout.write('ready'))`],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve());
  });
  // SIGKILL: the child gets no chance to clean up, so the socket node outlives
  // the process that bound it.
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

describe('probeRendezvous holds three outcomes, and claims the dangerous one only on proof', () => {
  let dir: string;
  const servers: Server[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-rendezvous-'));
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const listening = async (path: string): Promise<void> => {
    const server = createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
  };

  it('answers live for a socket with a listener behind it', async () => {
    const sock = join(dir, 'held');
    await listening(sock);
    await expect(probeRendezvous(sock)).resolves.toBe('live');
  });

  it('answers stale only on positive absence: a refused connect or no node at all', async () => {
    // ECONNREFUSED — the node is there and nobody is listening on it.
    const abandoned = join(dir, 'abandoned');
    await abandonedRendezvous(abandoned);
    expect(existsSync(abandoned)).toBe(true);
    await expect(probeRendezvous(abandoned)).resolves.toBe('stale');

    // ENOENT — connect(2) found no rendezvous object to reach.
    await expect(probeRendezvous(join(dir, 'never-existed'))).resolves.toBe('stale');
  });

  it('answers indeterminate for a LIVE holder it cannot reach, never stale', async () => {
    // The case that matters most and the one a lazy mapping loses: there IS a
    // listener, the probe simply has no permission to connect. Reading this as
    // absence would authorise unlinking the node and starting a second holder
    // over a live one — worse than never probing at all, because it strikes
    // only under permission trouble.
    if (isRoot) {
      // Root bypasses the permission check by design, so the condition cannot
      // exist here. The ELOOP case below covers the same branch uid-independently.
      return;
    }
    const sock = join(dir, 'unreachable');
    await listening(sock);
    chmodSync(sock, 0o000);
    try {
      await expect(probeRendezvous(sock)).resolves.toBe('indeterminate');
    } finally {
      chmodSync(sock, 0o700); // so afterEach can close/unlink it
    }
  });

  it('answers indeterminate when the path itself cannot be resolved', async () => {
    // ELOOP, from a symlink cycle at the rendezvous name. Path resolution, not
    // permissions, so this holds at every uid — the branch stays pinned even
    // where the EACCES case above cannot run.
    const looping = join(dir, 'looping');
    symlinkSync(join(dir, 'looping-other'), looping);
    symlinkSync(looping, join(dir, 'looping-other'));
    await expect(probeRendezvous(looping)).resolves.toBe('indeterminate');
  });

  it('does not unlink anything it probed, whatever the verdict (desk#42)', async () => {
    // The probe observes. Every unlink in this codebase belongs to a caller
    // that adds its own TOCTOU identity fence on top of a `stale` verdict.
    const abandoned = join(dir, 'left-behind');
    await abandonedRendezvous(abandoned);
    const notASocket = join(dir, 'regular-file');
    writeFileSync(notASocket, 'x');
    const held = join(dir, 'still-held');
    await listening(held);

    await Promise.all([abandoned, notASocket, held].map((path) => probeRendezvous(path)));

    expect(existsSync(abandoned)).toBe(true);
    expect(existsSync(notASocket)).toBe(true);
    expect(existsSync(held)).toBe(true);
  });
});
