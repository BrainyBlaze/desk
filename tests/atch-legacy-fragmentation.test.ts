import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ATCH_BIN = process.env.ATCH_BIN ?? join(__dirname, '..', 'libexec', 'atch');
const LEGACY_PACKET_BYTES = 4 + 4096;

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

describe.skipIf(!existsSync(ATCH_BIN))('atch legacy packet framing', () => {
  it('accumulates a packet split after the four-byte protocol discriminator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atch-legacy-fragment-'));
    const socketPath = join(root, 'fragment.sock');
    const logPath = `${socketPath}.log`;
    const marker = `legacy-fragment-${Date.now().toString(36)}`;
    const launcher = spawn(
      ATCH_BIN,
      ['start', socketPath, 'sh', '-c', 'stty -echo; exec cat'],
      { stdio: 'ignore', detached: true }
    );

    try {
      expect(await until(() => existsSync(socketPath), 8000), 'atch socket').toBe(true);
      const socket = connect(socketPath);
      socket.on('error', () => {});
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });

      const payload = Buffer.from(`${marker}\n`);
      const packet = Buffer.alloc(LEGACY_PACKET_BYTES);
      packet[0] = 0;
      packet.writeUInt16LE(payload.length, 2);
      payload.copy(packet, 4);

      await new Promise<void>((resolve) => socket.write(packet.subarray(0, 4), resolve));
      await wait(250);
      if (!socket.destroyed) socket.write(packet.subarray(4));

      expect(
        await until(
          () =>
            existsSync(logPath) &&
            readFileSync(logPath, 'utf8').includes(marker),
          5000
        ),
        'fragmented MSG_PUSH reaches the child'
      ).toBe(true);
      socket.destroy();
    } finally {
      spawnSync(ATCH_BIN, ['kill', '-f', socketPath], { stdio: 'ignore' });
      if (launcher.pid) {
        try {
          process.kill(launcher.pid, 'SIGKILL');
        } catch {
          // The daemonizing launcher normally exits before cleanup.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
