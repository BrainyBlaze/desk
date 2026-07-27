// A controller that re-attaches to a RUNNING master must be told the child's
// live terminal-mode state: it arrives with a fresh emulator that never
// witnessed the child enabling those modes.
//
// The mode that bites is bracketed paste (DECSET 2004). Without it the channels
// transport stops wrapping pasted prompts, the agent TUI ingests them line by
// line, and the submit Enter is taken as a literal newline — the delivered
// message then sits unsent in the composer until a human presses Enter. The
// legacy MSG_ATTACH path emitted a preamble; v3 ATTACH omitted it.
//
// This pins the C/master half of the contract: TERMINAL_STATE (frame 84) is
// emitted BEFORE ATTACH_ACK, connection-local (generation 0), carrying a blob32
// ANSI preamble. It reads raw frames rather than going through MasterClient's
// dispatch, so it holds regardless of when the TS runtime learns to apply it.
//
// A second attach == a daemon restart: same master, brand-new controller.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { MasterClient } from '../src/server/runtime/masterClient.js';
import { spawnMaster } from '../src/server/runtime/spawnMaster.js';
import { decodeFrame } from '../src/shared/atchWire/codec.js';
import { FrameType, Role } from '../src/shared/atchWire/frames.js';

const ATCH_BIN = process.env.ATCH_BIN ?? join(__dirname, '..', 'libexec', 'atch');
// Opt-in like the other real-binary tests: it spawns a live PTY session.
const AVAILABLE = existsSync(ATCH_BIN) && process.env.RUN_REAL_JOIN === '1';
const UID = typeof process.getuid === 'function' ? process.getuid() : 1000;
const SOCK_DIR = `/tmp/.atch-${UID}`;
const TERMINAL_STATE = 84;
const ATTACH_ACK = 3;
const RECORD = FrameType.RECORD;
const BRACKETED_PASTE_ON = '[?2004h';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, timeoutMs: number, stepMs = 30): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(stepMs);
  }
  return predicate();
}

/** Decode every complete frame in the captured stream, in arrival order. */
function framesOf(raw: number[]): { type: number; generation: number; sequence: bigint; payload: Uint8Array }[] {
  let buf = Uint8Array.from(raw);
  const out: { type: number; generation: number; sequence: bigint; payload: Uint8Array }[] = [];
  for (;;) {
    let decoded: ReturnType<typeof decodeFrame>;
    try {
      decoded = decodeFrame(buf);
    } catch {
      return out; // a partial tail is expected while the stream is live
    }
    if (!decoded) return out;
    const frame = decoded.frame as unknown as {
      type: number;
      generation: number;
      sequence: bigint;
      payload: Uint8Array;
    };
    out.push({ type: frame.type, generation: frame.generation, sequence: frame.sequence, payload: frame.payload });
    buf = buf.subarray(decoded.consumed);
  }
}

describe.skipIf(!AVAILABLE)('v3 ATTACH restates the terminal-mode preamble', () => {
  const sessions: string[] = [];

  afterEach(async () => {
    for (const name of sessions.splice(0)) {
      spawn(ATCH_BIN, ['kill', '-f', join(SOCK_DIR, name)], { stdio: 'ignore' }).unref();
      rmSync(join(SOCK_DIR, name), { force: true });
    }
    await wait(150);
  });

  /** Attach a controller, capturing the raw frame stream it receives. */
  async function attach(name: string): Promise<{ client: MasterClient; raw: number[]; acked: () => boolean }> {
    const raw: number[] = [];
    let acked = false;
    const client = new MasterClient(join(SOCK_DIR, name), {
      onRaw: (chunk) => raw.push(...chunk),
      onAttachAck: () => (acked = true)
    });
    await client.connect();
    client.handshake({ role: Role.CONTROLLER, sessionId: name, rows: 40, cols: 120 });
    expect(await until(() => acked, 6000), 'ATTACH_ACK received').toBe(true);
    return { client, raw, acked: () => acked };
  }

  it('a re-attaching controller is told DECSET 2004 without the child re-emitting it', async () => {
    const name = `deskpre${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    sessions.push(name);
    // The child turns bracketed paste ON once, then goes quiet — exactly how an
    // agent TUI behaves: modes are set at startup and never repeated.
    await spawnMaster({
      binPath: ATCH_BIN,
      args: ['start', name, 'sh', '-c', `printf '\\033[?2004h'; sleep 30`],
      sockPath: join(SOCK_DIR, name),
      generation: 1,
      detached: true,
      readyTimeoutMs: 6000
    });

    const first = await attach(name);
    // Let the child's own DECSET reach the master's mode tracker.
    await wait(400);
    first.client.close();
    await wait(200);

    // The daemon restarts: a brand-new controller, and the child stays silent.
    const second = await attach(name);
    // Provoke one live RECORD so the header sequence can be checked past the ACK.
    second.client.sendInput(new TextEncoder().encode('\n'), false, 1);
    await wait(400);
    second.client.close();

    const frames = framesOf(second.raw);
    const stateIndex = frames.findIndex((f) => f.type === TERMINAL_STATE);
    const ackIndex = frames.findIndex((f) => f.type === ATTACH_ACK);

    expect(stateIndex, 'TERMINAL_STATE frame present').toBeGreaterThanOrEqual(0);
    expect(ackIndex, 'ATTACH_ACK frame present').toBeGreaterThanOrEqual(0);
    // Before the ACK: the daemon must have the modes applied by the time the
    // attach resolves and live output can start arriving.
    expect(stateIndex).toBeLessThan(ackIndex);
    // Connection-local: outside the generation fence, so it carries no session
    // generation of its own.
    expect(frames[stateIndex].generation).toBe(0);

    const payload = frames[stateIndex].payload;
    const blobLen = payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24);
    expect(blobLen, 'blob32 length prefix matches the payload').toBe(payload.length - 4);
    expect(new TextDecoder().decode(payload.subarray(4))).toContain(BRACKETED_PASTE_ON);

    // Spec §1.1: the header `sequence` is PER-DIRECTION monotonic, so every
    // master→client frame must consume the same connection counter — the
    // durable record_seq lives inside the RECORD envelope, not in the header.
    expect(frames[stateIndex].sequence).toBeLessThan(frames[ackIndex].sequence);
    const recordIndex = frames.findIndex((f, i) => i > ackIndex && f.type === RECORD);
    expect(recordIndex, 'a live RECORD followed the ACK').toBeGreaterThan(ackIndex);
    expect(frames[recordIndex].sequence).toBeGreaterThan(frames[ackIndex].sequence);
  }, 40_000);
});
