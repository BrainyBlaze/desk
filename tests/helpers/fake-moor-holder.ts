// Test-double moor binary for join-path witnesses (#2b). Speaks the REAL MOOR
// wire v3 (via the approved moorWire codec) over a REAL unix socket, consumes
// the REAL fd-3 launch channel, and materializes a REAL four-slot committed
// event store — so sessionManager/terminalDaemon orchestration is exercised
// against the same contracts the production holder enforces.
//
// Modes (argv[2] after `tsx <script>`):
//   start [-T <storeDir>] <sessionPath> <cmd...>  — launcher: validate the
//     launch record + carriers, fork the holder detached, wait for the socket,
//     exit 0 (moor's launcher awaits adoption→ready internally; exit 0 IS the
//     readiness signal).
//   --holder <generation> <storeDir|-> <sessionPath> <cmd...> — the holder.
//   kill <sessionPath>   — SIGTERM the holder via its pidfile, wait, exit 0.
//   rm <sessionPath>     — unlink a stale socket node.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { createServer, Socket as NetSocket, type Socket } from 'node:net';
import { basename as basenameOf, join as joinPath, resolve as resolvePath } from 'node:path';
import { MoorCodec, type MoorMessage } from '../../src/shared/moorWire/codec.js';
import { crc32c } from '../../src/shared/moorWire/crc32c.js';
import { MoorKind } from '../../src/shared/moorWire/messages.js';
import {
  MOOR_SESSION_GENERATION,
  decodeMoorLaunchRecord,
  moorGenerationEnvKey,
  moorLaunchChannelEnvKey
} from '../../src/server/runtime/moorLaunchChannel.js';

const HEARTBEAT_MS = Number(process.env.FAKE_MOOR_HEARTBEAT_MS ?? 1000);

function fail(message: string): never {
  process.stderr.write(`fake-moor: ${message}\n`);
  process.exit(1);
}

function pidfileOf(sessionPath: string): string {
  return `${sessionPath}.holder-pid`;
}

// ---- byte builders (mirror the approved wire fixtures) ----------------------

const encoder = new TextEncoder();

function joined(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function integer(value: number | bigint, bytes: 2 | 4 | 8): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  if (bytes === 2) view.setUint16(0, Number(value), true);
  else if (bytes === 4) view.setUint32(0, Number(value), true);
  else view.setBigUint64(0, BigInt(value), true);
  return out;
}

const wide = (bytes: Uint8Array): Uint8Array => joined(integer(bytes.length, 4), bytes);

function tag01Identity(path: string): Uint8Array {
  const bytes = Buffer.from(path);
  const identity = new Uint8Array(1 + bytes.length);
  identity[0] = 1;
  identity.set(bytes, 1);
  return identity;
}

function helloAckPayload(generation: number, incarnation: Uint8Array, identity: Uint8Array): Uint8Array {
  return joined(Uint8Array.of(3), integer(generation, 4), incarnation, wide(identity));
}

/** Minimal valid §5 status: lease owned, viewers, running; layout 2 with the
 *  real event-store descriptor when the holder carries a store, layout 0
 *  otherwise (OB-39: the ACK is the store authority, never a guess). */
function statusPayload(
  generation: number,
  incarnation: Uint8Array,
  identity: Uint8Array,
  leaseEpoch: number,
  replay: { first: bigint; last: bigint; start: bigint; end: bigint },
  store?: {
    directory: string;
    bodySlot: 0 | 1;
    commitIndex: bigint;
    bodyLength: bigint;
    bodyHash: Uint8Array;
  }
): Uint8Array {
  const tail = new Uint8Array(69);
  const view = new DataView(tail.buffer);
  const complete = replay.first <= 1n && replay.start === 0n;
  view.setBigUint64(0, replay.first, true);
  view.setBigUint64(8, replay.last, true);
  view.setBigUint64(16, replay.start, true);
  view.setBigUint64(24, replay.end, true);
  view.setUint8(32, (complete ? 0x01 : 0) | 0x10 | 0x20 | 0x40);
  view.setUint32(33, leaseEpoch, true);
  // Real-binary parity: the EVENT identity is the handed-off path's RAW
  // posix bytes — no tag byte (the tag-01 form is the session identity only).
  const eventIdentity =
    store === undefined ? new Uint8Array(0) : new Uint8Array(Buffer.from(store.directory));
  return joined(
    wide(identity),
    integer(generation, 4),
    incarnation,
    Uint8Array.of(store === undefined ? 0 : 2),
    wide(eventIdentity),
    Uint8Array.of(store === undefined ? 0xff : store.bodySlot),
    integer(store === undefined ? 0n : store.commitIndex, 8),
    integer(store === undefined ? 0n : store.bodyLength, 8),
    store === undefined ? new Uint8Array(32) : store.bodyHash,
    integer(1_000n, 8),
    integer(2_000n, 8),
    new Uint8Array(16).fill(0xb2),
    wide(encoder.encode('/tmp/fake-moor-holder')),
    integer(process.pid, 4),
    integer(1, 4),
    new Uint8Array(16).fill(0xc3),
    tail
  );
}

function leaseGrantPayload(epoch: number): Uint8Array {
  return joined(Uint8Array.of(0, 0, 0, 0), integer(epoch, 4), new Uint8Array(16).fill(0xd4));
}

// ---- committed event store (four slots, 92-byte commit, CRC + SHA) ----------

function storeHeader(generation: number, epoch: number, first: bigint, next: bigint, identity: Uint8Array): string {
  return `{"v":2,"type":"header","ts":1,"session":"${Buffer.from(identity).toString('base64')}","generation":${generation},"epoch":${epoch},"next_seq":${next},"first_retained":${first}}\n`;
}

function storeEvent(type: string, epoch: number, sequence: bigint, tail = ''): string {
  const now = Date.now();
  const milliseconds = now % 1_000;
  const timestamp =
    process.env.FAKE_MOOR_EVENT_TS_SECONDS === '1'
      ? milliseconds === 0
        ? String(Math.floor(now / 1_000))
        : `${Math.floor(now / 1_000)}.${String(milliseconds).padStart(3, '0')}`
      : String(now);
  return `{"type":"${type}","ts":${timestamp},"epoch":${epoch},"seq":${sequence},"kind":"transition"${tail}}\n`;
}

function commitRecord(slot: 0 | 1, kind: number, generation: number, epoch: number, index: bigint, start: bigint, end: bigint, body: Uint8Array): Uint8Array {
  const record = new Uint8Array(92);
  const view = new DataView(record.buffer);
  record.set(encoder.encode('MOORCMT1'), 0);
  record[8] = 1;
  record[9] = slot;
  record[10] = slot;
  record[11] = kind;
  view.setUint32(12, generation, true);
  view.setUint32(16, epoch, true);
  view.setBigUint64(24, index, true);
  view.setBigUint64(32, BigInt(body.length), true);
  view.setBigUint64(40, start, true);
  view.setBigUint64(48, end, true);
  record.set(createHash('sha256').update(body).digest(), 56);
  view.setUint32(88, crc32c(record.subarray(0, 88)), true);
  return record;
}

class EventStore {
  private readonly records: string[] = [];
  private index = 0n;
  private slot: 0 | 1 = 0;
  private lastBodyLength = 0n;
  private lastBodyHash: Uint8Array = new Uint8Array(32);

  /** The FULL portable selection the holder acknowledges: slot + index + length + hash. */
  frontier(): { bodySlot: 0 | 1; commitIndex: bigint; bodyLength: bigint; bodyHash: Uint8Array } {
    return {
      bodySlot: this.slot,
      commitIndex: this.index,
      bodyLength: this.lastBodyLength,
      bodyHash: this.lastBodyHash.slice()
    };
  }

  constructor(
    private readonly directory: string,
    private readonly generation: number,
    private readonly identity: Uint8Array
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Exclusive store initialization: the handed-off directory must be EMPTY —
    // any pre-existing entry belongs to another lifetime and must never be
    // truncated or adopted (moor fails the launch with Corrupt instead of
    // clobbering a nonempty handoff).
    if (readdirSync(directory).length > 0) {
      throw new Error('event store directory is not empty');
    }
    // The canonical EMPTY snapshot is committed into slot 0 at initialization:
    // an all-empty directory is not a committed store (moor: Corrupt), so the
    // store is readable from the instant it exists.
    const body = encoder.encode(storeHeader(generation, 0, 0n, 0n, identity));
    writeFileSync(`${directory}/body.0`, body, { mode: 0o600, flag: 'wx' });
    writeFileSync(
      `${directory}/commit.0`,
      commitRecord(0, 1, generation, 0, 1n, 0n, 0n, body),
      { mode: 0o600, flag: 'wx' }
    );
    writeFileSync(`${directory}/body.1`, new Uint8Array(), { mode: 0o600, flag: 'wx' });
    writeFileSync(`${directory}/commit.1`, new Uint8Array(), { mode: 0o600, flag: 'wx' });
    this.index = 1n;
    this.slot = 0;
    this.lastBodyLength = BigInt(body.length);
    this.lastBodyHash = new Uint8Array(createHash('sha256').update(body).digest());
  }

  append(type: string, tail = ''): void {
    const sequence = BigInt(this.records.length); // sequences are consumed from 0
    this.records.push(storeEvent(type, 0, sequence, tail));
    const next = BigInt(this.records.length);
    const body = encoder.encode(
      storeHeader(this.generation, 0, 0n, next, this.identity) + this.records.join('')
    );
    this.index += 1n;
    this.slot = this.slot === 0 ? 1 : 0;
    const commit = commitRecord(this.slot, 1, this.generation, 0, this.index, 0n, next, body);
    writeFileSync(`${this.directory}/body.${this.slot}`, body, { mode: 0o600 });
    writeFileSync(`${this.directory}/commit.${this.slot}`, commit, { mode: 0o600 });
    this.lastBodyLength = BigInt(body.length);
    this.lastBodyHash = new Uint8Array(createHash('sha256').update(body).digest());
  }
}

// ---- launcher ---------------------------------------------------------------

/**
 * Read an inherited launch-channel fd to EOF. Node's child stdio 'pipe' slots
 * are libuv socketpairs, so fs read syscalls EINVAL — wrap the fd as a socket.
 */
function readChannelToEof(fd: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const channel = new NetSocket({ fd, readable: true, writable: false });
    channel.on('data', (chunk: Buffer) => chunks.push(chunk));
    channel.on('end', () => resolve(Buffer.concat(chunks)));
    channel.on('error', reject);
  });
}

function parseStart(argv: string[]): { storeDir: string | undefined; sessionPath: string; command: string[] } {
  let storeDir: string | undefined;
  let index = 0;
  if (argv[index] === '-T') {
    storeDir = argv[index + 1];
    index += 2;
  }
  const sessionPath = argv[index];
  if (sessionPath === undefined) fail('start: missing session path');
  return { storeDir, sessionPath, command: argv.slice(index + 1) };
}

async function launcher(argv: string[]): Promise<never> {
  const { storeDir, sessionPath, command } = parseStart(argv);
  // The selector key derives from THIS process's invoked name (spec §10.1.1) —
  // the fake models an independent moor holder with zero Desk vocabulary.
  const selectorKey = moorLaunchChannelEnvKey(process.execPath);
  const selector = process.env[selectorKey];
  if (selector === undefined || String(Number.parseInt(selector, 10)) !== selector) {
    fail(`launcher: missing/malformed ${selectorKey}`);
  }
  const bytes = await readChannelToEof(Number.parseInt(selector, 10));
  // The PRODUCTION decoder is the launch-record truth: full 32-byte layout,
  // reserved [9..12) zero, generation >= 2, nonzero nonce.
  let generation: number;
  try {
    ({ generation } = decodeMoorLaunchRecord(bytes));
  } catch (error) {
    fail(`launcher: ${(error as Error).message}`);
  }
  const expected = String(generation);
  // The fixed child-visible carrier (spec §10.1). The holder validates ONLY
  // its own carriers: any DESK_* variable is opaque application env that must
  // pass through untouched (the spawn-master tests assert that passthrough).
  if (process.env[MOOR_SESSION_GENERATION] !== expected) {
    fail('launcher: MOOR_SESSION_GENERATION does not match the record');
  }
  // The second carrier is EXACTLY the invocation-derived key for this binary
  // (a stray *_GENERATION from another name is a conflicting authority).
  if (process.env[moorGenerationEnvKey(process.execPath)] !== expected) {
    fail('launcher: invocation-derived generation carrier does not match the record');
  }
  if (existsSync(sessionPath)) fail('launcher: session already exists');
  // Root fence parity (moor unix.rs `validate_event_target`): the event store
  // must live STRICTLY inside `temp_dir()/.{invoked-basename}-{euid}` — equal
  // to the root or outside it is rejected BEFORE anything is published. The
  // invoked basename here is this process's execPath basename (what a spawn
  // of the fake sees), the uid is the EFFECTIVE uid, and TMPDIR follows Rust
  // `std::env::temp_dir()` (env TMPDIR, else /tmp).
  if (storeDir !== undefined) {
    const invoked = basenameOf(process.execPath);
    const root = joinPath(
      process.env.TMPDIR ?? '/tmp',
      `.${invoked.length > 0 ? invoked : 'moor'}-${process.geteuid!()}`
    );
    const resolved = resolvePath(storeDir);
    if (resolved === root || !(resolved + '/').startsWith(root + '/')) {
      fail(`event store rejected: ${storeDir} (outside-root)`);
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  const holderEnv: NodeJS.ProcessEnv = { ...process.env };
  delete holderEnv[selectorKey];
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      process.argv[1]!,
      '--holder',
      String(generation),
      storeDir ?? '-',
      sessionPath,
      ...command
    ],
    { detached: true, stdio: 'ignore', env: holderEnv }
  );
  child.unref();
  const marker = failedMarkerOf(sessionPath);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      const reason = readFileSync(marker, 'utf8');
      try {
        unlinkSync(marker);
      } catch {
        /* best effort */
      }
      fail(`launcher: holder failed before publication: ${reason}`);
    }
    if (existsSync(sessionPath)) process.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fail('launcher: holder never published its session socket');
}

// ---- holder -----------------------------------------------------------------

function failedMarkerOf(sessionPath: string): string {
  return `${sessionPath}.launch-failed`;
}

/** Pre-publication failure: leave NO rendezvous, tell the launcher, exit 1. */
function holderLaunchFailure(sessionPath: string, message: string): never {
  try {
    writeFileSync(failedMarkerOf(sessionPath), message);
  } catch {
    /* the launcher will time out instead */
  }
  fail(`holder: ${message}`);
}

async function holder(argv: string[]): Promise<void> {
  const generation = Number(argv[0]);
  const storeDir = argv[1] === '-' ? undefined : argv[1];
  const sessionPath = argv[2];
  const command = argv.slice(3);
  if (!Number.isInteger(generation) || sessionPath === undefined) fail('holder: bad argv');

  const incarnation = randomBytes(16);
  const identity = tag01Identity(sessionPath);
  // Store initialization is exclusive and happens BEFORE any publication:
  // a failure leaves no session behind (moor: adoption precedes ready).
  let store: EventStore | undefined;
  try {
    store = storeDir === undefined ? undefined : new EventStore(storeDir, generation, identity);
  } catch (error) {
    holderLaunchFailure(sessionPath, (error as Error).message);
  }

  // The requested child must actually start before anything is published:
  // a spawn failure (missing executable) fails the launch with no rendezvous.
  const child = command.length > 0
    ? spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] })
    : undefined;
  // EPIPE from a child that closed fd 0 surfaces on the write callback; the
  // stream-level 'error' event must not crash the holder.
  child?.stdin?.on('error', () => undefined);
  if (child !== undefined) {
    const started = await new Promise<Error | undefined>((resolve) => {
      child.once('spawn', () => resolve(undefined));
      child.once('error', (error) => resolve(error));
    });
    if (started !== undefined) {
      holderLaunchFailure(sessionPath, `child failed to start: ${started.message}`);
    }
  }
  store?.append('ready');

  let outputSequence = 0n;
  let outputOffset = 0n;
  /** Retained records for the §6.1 attach replay baseline. */
  const retained: Array<{ sequence: bigint; offset: bigint; bytes: Buffer }> = [];
  const connections = new Set<{ socket: Socket; codec: MoorCodec; attached: boolean }>();

  child?.stdout?.on('data', (chunk: Buffer) => {
    outputSequence += 1n;
    const record = { sequence: outputSequence, offset: outputOffset, bytes: Buffer.from(chunk) };
    retained.push(record);
    outputOffset += BigInt(chunk.byteLength);
    const payload = joined(
      integer(record.sequence, 8),
      integer(record.offset, 8),
      new Uint8Array(record.bytes)
    );
    for (const conn of connections) {
      if (conn.attached) conn.socket.write(conn.codec.encode(generation, MoorKind.OUTPUT, payload));
    }
  });
  child?.on('exit', (code, signal) => {
    store?.append(
      'exit',
      signal !== null ? `,"ended":"signalled","signal":${15}` : `,"ended":"exited","code":${code ?? 0}`
    );
    for (const conn of connections) {
      const wakeup = conn.codec.encode(generation, MoorKind.WAKEUP, new Uint8Array());
      if (conn.attached) conn.socket.write(wakeup);
    }
  });

  const server = createServer((socket) => {
    const conn = { socket, codec: new MoorCodec(), attached: false };
    connections.add(conn);
    const inbound = new MoorCodec();
    let heartbeat: NodeJS.Timeout | undefined;
    socket.on('close', () => {
      connections.delete(conn);
      if (heartbeat !== undefined) clearInterval(heartbeat);
    });
    socket.on('data', (chunk: Buffer) => {
      let messages: MoorMessage[];
      try {
        messages = inbound.feed(Date.now(), new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      } catch {
        socket.destroy();
        return;
      }
      for (const message of messages) {
        if (message.scope !== generation && !(message.kind === MoorKind.HELLO && message.scope === 0)) {
          socket.destroy();
          return;
        }
        switch (message.kind) {
          case MoorKind.HELLO:
            socket.write(conn.codec.encode(generation, MoorKind.HELLO_ACK, helloAckPayload(generation, incarnation, identity)));
            break;
          case MoorKind.ATTACH: {
            // desk#64 knob: a holder that is demonstrably ALIVE (it answered
            // the HELLO above) but refuses this controller's adoption, for as
            // long as the named file exists. Drops the adopting connection
            // without touching the child — the restart-time attach failure a
            // daemon must never read as "the session ended".
            const refuseAttachFile = process.env.FAKE_MOOR_REFUSE_ATTACH_FILE;
            if (refuseAttachFile !== undefined && existsSync(refuseAttachFile)) {
              socket.destroy();
              return;
            }
            // Frozen §6 prefix: TERMINAL_STATE → ATTACH_ACK → LEASE_RESULT
            // when requested → the retained replay baseline → live output.
            const replay = {
              first: retained.length > 0 ? 1n : 0n,
              last: retained.length > 0 ? retained[retained.length - 1]!.sequence : 0n,
              start: 0n,
              end: outputOffset
            };
            socket.write(conn.codec.encode(generation, MoorKind.TERMINAL_STATE, integer(0, 2)));
            socket.write(
              conn.codec.encode(
                generation,
                MoorKind.ATTACH_ACK,
                statusPayload(
                  generation,
                  incarnation,
                  identity,
                  1,
                  replay,
                  store === undefined || storeDir === undefined
                    ? undefined
                    : { directory: storeDir, ...store.frontier() }
                )
              )
            );
            const wantsLease = (message.payload[4]! & 1) === 1;
            if (wantsLease) {
              socket.write(conn.codec.encode(generation, MoorKind.LEASE_RESULT, leaseGrantPayload(1)));
            }
            for (const record of retained) {
              socket.write(
                conn.codec.encode(
                  generation,
                  MoorKind.OUTPUT,
                  joined(integer(record.sequence, 8), integer(record.offset, 8), new Uint8Array(record.bytes))
                )
              );
            }
            conn.attached = true;
            heartbeat = setInterval(() => {
              socket.write(conn.codec.encode(generation, MoorKind.HEARTBEAT, joined(integer(BigInt(Date.now()), 8), Uint8Array.of(0x01))));
            }, HEARTBEAT_MS);
            heartbeat.unref?.();
            // §8 arbitration harness: when asked via env, delegate one query
            // to the freshly attached lease viewer (correlation 1, epoch 1)
            // and persist its raw QUERY_REPLY bytes for the witness.
            if (wantsLease && process.env.FAKE_MOOR_QUERY === '5') {
              setTimeout(() => {
                socket.write(
                  conn.codec.encode(
                    generation,
                    MoorKind.QUERY,
                    joined(
                      integer(1n, 8),
                      integer(1, 4),
                      Uint8Array.of(5),
                      integer(4, 2),
                      encoder.encode('[6n')
                    )
                  )
                );
              }, 50);
            }
            break;
          }
          case MoorKind.QUERY_REPLY: {
            // u64 correlation + u32 epoch + u8 class + compact reply bytes.
            const view = new DataView(message.payload.buffer, message.payload.byteOffset);
            const correlation = view.getBigUint64(0, true);
            const epoch = view.getUint32(8, true);
            const replyClass = message.payload[12]!;
            const replyLength = view.getUint16(13, true);
            const reply = message.payload.subarray(15, 15 + replyLength);
            if (correlation === 1n && epoch === 1 && replyClass === 5) {
              writeFileSync(`${sessionPath}.query-reply`, Buffer.from(reply));
            }
            break;
          }
          case MoorKind.TERMINATE: {
            // wide identity + u32 generation + 16-byte incarnation + 1 flags.
            const view = new DataView(message.payload.buffer, message.payload.byteOffset);
            const identityLength = view.getUint32(0, true);
            const requestedIdentity = message.payload.subarray(4, 4 + identityLength);
            const generationAt = 4 + identityLength;
            const requestedGeneration = view.getUint32(generationAt, true);
            const requestedIncarnation = message.payload.subarray(generationAt + 4, generationAt + 20);
            const identityMatches =
              requestedIdentity.length === identity.length &&
              requestedIdentity.every((byte, index) => byte === identity[index]) &&
              requestedGeneration === generation &&
              requestedIncarnation.every((byte, index) => byte === incarnation[index]);
            const respond = (outcome: number, method: number, diagnostic: string): void => {
              const diagnosticBytes = encoder.encode(diagnostic);
              socket.write(
                conn.codec.encode(
                  generation,
                  MoorKind.TERMINATE_RESULT,
                  joined(
                    Uint8Array.of(outcome, outcome === 0 ? 0b10 : 0, method),
                    integer(diagnosticBytes.length, 2),
                    diagnosticBytes
                  )
                )
              );
            };
            if (!identityMatches) {
              // §9.1: any mismatch is REFUSED_IDENTITY and NOTHING is done.
              respond(2, 0, 'terminate identity mismatch');
              break;
            }
            // Graceful §9 termination: child ends (SIGTERM → 1.2 s SIGKILL
            // escalation), the exit transition commits, the rendezvous is
            // unlinked, and ONLY THEN does TERMINATED go out — the outcome
            // means "the socket or marker is unlinked", so the order is the
            // contract. The established connection survives the unlink long
            // enough to carry the result.
            const finish = (): void => {
              try {
                unlinkSync(sessionPath);
              } catch {
                /* already gone */
              }
              try {
                unlinkSync(pidfileOf(sessionPath));
              } catch {
                /* already gone */
              }
              respond(0, 1, '');
              setTimeout(() => process.exit(0), 100).unref?.();
            };
            if (child !== undefined && child.exitCode === null && child.signalCode === null) {
              child.once('exit', () => setImmediate(finish));
              child.kill('SIGTERM');
              const escalate = setTimeout(() => {
                try {
                  child.kill('SIGKILL');
                } catch {
                  /* already gone */
                }
              }, 1_200);
              escalate.unref?.();
            } else {
              finish();
            }
            break;
          }
          case MoorKind.LEASE_RELEASE: {
            // Exactly 20 bytes: u32 epoch + 16-byte token, checked against the
            // one grant this holder ever issues (epoch 1, 0xd4 token).
            const view = new DataView(message.payload.buffer, message.payload.byteOffset);
            const epoch = view.getUint32(0, true);
            const token = message.payload.subarray(4, 20);
            const exact = epoch === 1 && token.every((byte) => byte === 0xd4);
            if (exact) writeFileSync(`${sessionPath}.lease-released`, '1');
            socket.write(
              conn.codec.encode(
                generation,
                MoorKind.LEASE_RESULT,
                exact
                  ? joined(Uint8Array.of(2, 0, 0, 0), integer(1, 4), new Uint8Array(16))
                  : joined(Uint8Array.of(3, 5, 0, 0), integer(1, 4), new Uint8Array(16))
              )
            );
            break;
          }
          case MoorKind.LOG_CLEAR: {
            // 16-byte incarnation + u64 observed selected log commit index.
            const view = new DataView(message.payload.buffer, message.payload.byteOffset);
            const requestedIncarnation = message.payload.subarray(0, 16);
            const observed = view.getBigUint64(16, true);
            const cleared = requestedIncarnation.every((byte, index) => byte === incarnation[index]);
            socket.write(
              conn.codec.encode(
                generation,
                MoorKind.LOG_CLEAR_RESULT,
                cleared
                  ? joined(Uint8Array.of(0, 0), integer(0, 2), integer(1, 4), integer(observed, 8), integer(observed, 8), integer(0n, 8))
                  : joined(Uint8Array.of(2, 1), integer(0, 2), integer(0, 4), integer(observed, 8), integer(observed, 8), integer(0n, 8))
              )
            );
            break;
          }
          case MoorKind.INPUT: {
            const view = new DataView(message.payload.buffer, message.payload.byteOffset);
            const epoch = view.getUint32(0, true);
            const requestId = view.getBigUint64(4, true);
            const bytes = message.payload.subarray(13); // epoch(4) + id(8) + application flag(1)=0
            // §7.2: a success receipt exists only after the COMPLETE write
            // finished; a failed/partial terminal write is refused with
            // INPUT_WRITE_FAILED (20). The stdin write callback is the truth.
            const respond = (written: bigint, status: number, result: number): void => {
              const receipt = joined(
                integer(epoch, 4),
                integer(requestId, 8),
                integer(generation, 4),
                incarnation,
                integer(written, 8),
                Uint8Array.of(status),
                integer(result, 2)
              );
              socket.write(conn.codec.encode(generation, MoorKind.INPUT_RECEIPT, receipt));
            };
            const stdin = child?.stdin;
            if (stdin === undefined || stdin.destroyed || !stdin.writable) {
              respond(0n, 1, 20);
              break;
            }
            stdin.write(Buffer.from(bytes), (error) => {
              if (error) respond(0n, 1, 20);
              else respond(BigInt(bytes.length), 0, 0);
            });
            break;
          }
          case MoorKind.STATUS:
            socket.write(
              conn.codec.encode(
                generation,
                MoorKind.STATUS_REPLY,
                statusPayload(
                  generation,
                  incarnation,
                  identity,
                  1,
                  {
                    first: retained.length > 0 ? 1n : 0n,
                    last: retained.length > 0 ? retained[retained.length - 1]!.sequence : 0n,
                    start: 0n,
                    end: outputOffset
                  },
                  store === undefined || storeDir === undefined
                    ? undefined
                    : { directory: storeDir, ...store.frontier() }
                )
              )
            );
            break;
          default:
            break; // RESIZE / OUTPUT_ACK / LEASE_KEEPALIVE: accepted silently
        }
      }
    });
  });

  server.listen(sessionPath, () => {
    writeFileSync(pidfileOf(sessionPath), String(process.pid));
  });

  const shutdown = (): void => {
    const finish = (): void => {
      try {
        unlinkSync(sessionPath);
      } catch {
        /* already gone */
      }
      try {
        unlinkSync(pidfileOf(sessionPath));
      } catch {
        /* already gone */
      }
      process.exit(0);
    };
    // The child's exit transition must be durably committed BEFORE the
    // rendezvous disappears (kill waits on the socket, so kill's return then
    // implies the exit record is readable). The earlier-registered child
    // 'exit' listener appends the signalled record; finish runs after it.
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.once('exit', () => setImmediate(finish));
      child.kill('SIGTERM');
      // A child that ignores SIGTERM is escalated to SIGKILL — uncatchable, so
      // the exit (and its store transition) always arrives before the
      // rendezvous is unpublished; the child can never be leaked past kill.
      const escalate = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 1_200);
      escalate.unref?.();
    } else {
      finish();
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ---- kill / rm --------------------------------------------------------------

async function killMode(argv: string[]): Promise<never> {
  const sessionPath = argv.filter((arg) => arg !== '-f' && arg !== 'force')[0];
  if (sessionPath === undefined) fail('kill: missing session path');
  // Killing a session that is not live is a reported failure, not a no-op:
  // the caller asked to stop something that does not exist.
  try {
    const pid = Number(readFileSync(pidfileOf(sessionPath), 'utf8'));
    process.kill(pid, 'SIGTERM');
  } catch {
    fail('kill: session is not live');
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!existsSync(sessionPath)) process.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fail('kill: holder did not exit');
}

function rmMode(argv: string[]): never {
  const sessionPath = argv[0];
  if (sessionPath === undefined) fail('rm: missing session path');
  // rm reclaims STALE nodes only: a live holder owns its rendezvous and rm
  // must refuse to pull it out from under it.
  try {
    const pid = Number(readFileSync(pidfileOf(sessionPath), 'utf8'));
    process.kill(pid, 0); // throws ESRCH when the holder is gone
    fail('rm: session is live'); // exits 1 — a live holder owns its node
  } catch {
    // No pidfile or dead holder: the node is stale and ours to reclaim.
  }
  try {
    unlinkSync(sessionPath);
  } catch {
    /* already gone */
  }
  try {
    unlinkSync(pidfileOf(sessionPath));
  } catch {
    /* already gone */
  }
  process.exit(0);
}

// ---- dispatch ---------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'start') void launcher(rest);
else if (mode === '--holder') void holder(rest);
else if (mode === 'kill') void killMode(rest);
else if (mode === 'rm') rmMode(rest);
else fail(`unknown mode ${mode}`);
