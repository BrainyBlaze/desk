// THE REAL JOIN (spec §7.1 / §4) — the first true end-to-end against the REAL
// atch binary. The daemon spawns a real atch session (`atch start NAME cat`) with
// ATCH_GENERATION injected, attaches its MasterClient over the v3 socket, types
// input, and asserts the output round-trips through the real binary. Skips
// cleanly when the binary is absent (set ATCH_BIN to run it).

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MasterClient } from '../src/server/runtime/masterClient.js';
import { spawnMaster } from '../src/server/runtime/spawnMaster.js';
import { Role } from '../src/shared/atchWire/frames.js';
import { type RecordEnvelope } from '../src/shared/atchWire/messages.js';
import { RecordType } from '../src/shared/atchWire/frames.js';

const ATCH_BIN = process.env.ATCH_BIN ?? '/home/dev/.config/superpowers/worktrees/atch/phase-a-implementation/atch';
const AVAILABLE = existsSync(ATCH_BIN);
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
function killSession(name: string): void {
  try {
    spawn(ATCH_BIN, ['kill', '-f', name], { stdio: 'ignore' });
  } catch {
    /* best effort */
  }
  rmSync(join(SOCK_DIR, name), { force: true });
}

describe.skipIf(!AVAILABLE)('REAL join — daemon ↔ real atch master (§7.1)', () => {
  let sessionName = '';
  afterEach(() => {
    if (sessionName) killSession(sessionName);
    sessionName = '';
  });

  it('spawns a real atch session with ATCH_GENERATION, attaches, and round-trips input→output', { timeout: 25000 }, async () => {
    sessionName = `deskjoin${Date.now().toString(36)}`;
    const sockPath = join(SOCK_DIR, sessionName);

    // Daemon spawns the real atch master, injecting the ledger generation.
    await spawnMaster({ binPath: ATCH_BIN, args: ['start', sessionName, 'cat'], sockPath, generation: 1, detached: true, readyTimeoutMs: 6000 });
    expect(existsSync(sockPath), 'session socket exists').toBe(true);

    // The daemon's MasterClient attaches over the v3 socket.
    const output: number[] = [];
    let ackGeneration = -1;
    const client = new MasterClient(sockPath, {
      onRecord: (rec: RecordEnvelope) => {
        if (rec.record_type === RecordType.OUTPUT) output.push(...rec.body);
      },
      onAttachAck: (ack) => {
        ackGeneration = (ack as { generation: number }).generation;
      }
    });
    try {
      await client.connect();
      client.handshake({ role: Role.CONTROLLER, sessionId: sessionName, rows: 40, cols: 120 });
      expect(await until(() => ackGeneration >= 0, 4000), 'ATTACH_ACK received').toBe(true);
      // The generation the master reports is the one the daemon injected via env.
      expect(ackGeneration).toBe(1);

      // Type input; `cat` (and the PTY echo) send it back as OUTPUT.
      await wait(150); // let the child settle
      client.sendInput(new TextEncoder().encode('hello-join\n'), false, 1);

      const got = await until(() => new TextDecoder().decode(Uint8Array.from(output)).includes('hello-join'), 5000);
      const text = new TextDecoder().decode(Uint8Array.from(output));
      expect(got, `output round-trip (got: ${JSON.stringify(text)})`).toBe(true);
    } finally {
      client.close();
    }
  });
});
