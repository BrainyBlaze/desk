// #2 integration seam: the daemon-side MOOR controller client that replaces the
// ATV3 MasterClient. Verified against a fake MOOR holder built on the approved
// moorWire codec (byte conformance to moor 93d593a is pinned by the wire
// suites). The attach prefix is the frozen §6 order: TERMINAL_STATE (exactly
// once, before ATTACH_ACK) → ATTACH_ACK → lease/replay/live; a missing,
// second, or post-ACK preamble is refused; identity exchange + adoption run
// under one absolute deadline; every teardown path rejects pending work.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoorCodec, type MoorMessage } from '../src/shared/moorWire/codec.js';
import { MoorKind } from '../src/shared/moorWire/messages.js';
import {
  MoorMasterClient,
  posixMoorIdentity,
  windowsMoorIdentity
} from '../src/server/runtime/moorMasterClient.js';

const GENERATION = 7;
const INCARNATION = new Uint8Array(16).fill(0xa1);

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function joined(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
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

function helloAckPayload(identity: Uint8Array, incarnation = INCARNATION): Uint8Array {
  return joined(Uint8Array.of(3), integer(GENERATION, 4), incarnation, wide(identity));
}

/** Minimal valid §5 status descriptor: layout 0 (no event store), lease owned. */
function statusPayload(
  identity: Uint8Array,
  leaseEpoch: number,
  options: {
    ownsLease?: boolean;
    replay?: { first: bigint; last: bigint; start: bigint; end: bigint };
  } = {}
): Uint8Array {
  const tail = new Uint8Array(69);
  const view = new DataView(tail.buffer);
  const replay = options.replay ?? { first: 0n, last: 0n, start: 0n, end: 0n };
  // complete (bit0) is frozen to: empty-at-zero, or retained from record 1/byte 0.
  const complete = replay.first <= 1n && replay.start === 0n;
  const ownsLease = options.ownsLease ?? true;
  view.setBigUint64(0, replay.first, true);
  view.setBigUint64(8, replay.last, true);
  view.setBigUint64(16, replay.start, true);
  view.setBigUint64(24, replay.end, true);
  // viewers (0x20) reflects THIS fully attached viewer (§6 ACK cross-check).
  view.setUint8(32, (complete ? 0x01 : 0) | (ownsLease ? 0x10 : 0) | 0x20 | 0x40);
  view.setUint32(33, leaseEpoch, true);
  return joined(
    wide(identity),
    integer(GENERATION, 4),
    INCARNATION,
    Uint8Array.of(0), // layout 0
    wide(new Uint8Array(0)), // eventIdentity empty iff layout 0
    Uint8Array.of(0xff), // bodySlot
    integer(0n, 8), // commitIndex
    integer(0n, 8), // bodyLength
    new Uint8Array(32), // bodyHash zero
    integer(1_000n, 8), // wallStart
    integer(2_000n, 8), // monotonicStart
    new Uint8Array(16).fill(0xb2), // bootIdentity
    wide(text('/tmp/moor-holder')), // directory
    integer(4321, 4), // pid
    integer(1, 4), // containment
    new Uint8Array(16).fill(0xc3), // birthToken
    tail
  );
}

/** Zero-length preamble run (legal per §6) as a compact-prefixed payload. */
const emptyPreamble = (): Uint8Array => integer(0, 2);

/** Granted fresh-viewer lease result: outcome 0, epoch, nonzero token (24 bytes). */
function leaseResultPayload(epoch: number): Uint8Array {
  return joined(
    Uint8Array.of(0, 0, 0, 0), // outcome, reason, role, reserved
    integer(epoch, 4),
    new Uint8Array(16).fill(0xd4) // token
  );
}

function resumedLeaseResultPayload(epoch: number, tokenByte = 0xe5): Uint8Array {
  return joined(
    Uint8Array.of(1, 0, 0, 0),
    integer(epoch, 4),
    new Uint8Array(16).fill(tokenByte)
  );
}

/** In-process fake MOOR holder: one unix socket, one connection, own codec. */
class FakeHolder {
  readonly root = mkdtempSync(join(tmpdir(), 'moor-client-'));
  readonly sockPath = join(this.root, 'session');
  private server: Server | undefined;
  connection: Socket | undefined;
  private readonly codec = new MoorCodec();
  private readonly inbox: MoorMessage[] = [];
  private waiters: Array<(message: MoorMessage) => void> = [];

  async listen(): Promise<void> {
    this.server = createServer((socket) => {
      this.connection = socket;
      socket.on('data', (chunk: Buffer) => {
        const messages = this.codec.feed(
          Date.now(),
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        );
        for (const message of messages) {
          const waiter = this.waiters.shift();
          if (waiter) waiter(message);
          else this.inbox.push(message);
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.sockPath, resolve));
  }

  next(): Promise<MoorMessage> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  send(kind: number, payload: Uint8Array, scope: number = GENERATION): void {
    this.connection!.write(this.codec.encode(scope, kind, payload));
  }

  close(): void {
    this.connection?.destroy();
    this.server?.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}

function waitFor(predicate: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > 2_000) return reject(new Error(`timed out: ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('MoorMasterClient', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
    vi.useRealTimers();
  });

  async function start(
    handlers: ConstructorParameters<typeof MoorMasterClient>[2] = {},
    options: ConstructorParameters<typeof MoorMasterClient>[3] = {}
  ) {
    const holder = new FakeHolder();
    await holder.listen();
    const client = new MoorMasterClient(holder.sockPath, GENERATION, handlers, options);
    cleanups.push(() => {
      client.close();
      holder.close();
    });
    await client.connect();
    return { holder, client, identity: posixMoorIdentity(holder.sockPath) };
  }

  /** Drive the full frozen §6 prefix: HELLO→HELLO_ACK→ATTACH→preamble→ACK→LEASE_RESULT. */
  async function completeAttach(
    holder: FakeHolder,
    client: MoorMasterClient,
    identity: Uint8Array
  ): Promise<ReturnType<MoorMasterClient['attach']>> {
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next(); // HELLO
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next(); // ATTACH
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(MoorKind.ATTACH_ACK, statusPayload(identity, 5));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(5)); // requested prefix slot
    return attached;
  }

  it('refuses an unsupervised generation before connecting', () => {
    expect(() => new MoorMasterClient('/tmp/never', 1, {})).toThrowError(/generation/i);
    expect(() => new MoorMasterClient('/tmp/never', 0, {})).toThrowError(/generation/i);
  });

  it('close while connecting rejects the connect and prevents a late socket install', async () => {
    const holder = new FakeHolder();
    await holder.listen();
    const client = new MoorMasterClient(holder.sockPath, GENERATION);
    cleanups.push(() => {
      client.close();
      holder.close();
    });

    const connecting = client.connect();
    client.close();

    await expect(connecting).rejects.toThrow(/closed/i);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(client.connect()).rejects.toThrow(/closed/i);
  });

  it('validates the canonical identity: derived POSIX must be resolved, injected tags checked', () => {
    expect(() => new MoorMasterClient('relative/path', GENERATION, {})).toThrowError(/IDENTITY/);
    expect(() => new MoorMasterClient('/tmp/../etc/sock', GENERATION, {})).toThrowError(/IDENTITY/);
    expect(
      () => new MoorMasterClient('/tmp/x', GENERATION, {}, { identity: Uint8Array.of(9, 1, 2) })
    ).toThrowError(/IDENTITY/);
    // A well-formed injected Windows identity is accepted on any platform.
    const windows = windowsMoorIdentity(0x1122334455667788n, new Uint8Array(16).fill(7));
    expect(windows).toHaveLength(25);
    expect(new MoorMasterClient('/tmp/x', GENERATION, {}, { identity: windows })).toBeInstanceOf(
      MoorMasterClient
    );
  });

  it('sends supervised HELLO at the allocated generation scope with the tagged path identity', async () => {
    const { holder, client, identity } = await start();
    client.attach({ columns: 80, rows: 24, requestLease: true }).catch(() => undefined); // torn down before ack

    const hello = await holder.next();
    expect(hello.kind).toBe(MoorKind.HELLO);
    expect(hello.scope).toBe(GENERATION);
    expect(hello.payload).toEqual(joined(text('MOOR'), Uint8Array.of(3, 0, 0), wide(identity)));
  });

  it('walks the exact §6 prefix and resolves attach with the ACK status', async () => {
    const events: string[] = [];
    const { holder, client, identity } = await start({
      onHelloAck: () => events.push('hello-ack'),
      onTerminalState: () => events.push('terminal-state'),
      onAttachAck: () => events.push('attach-ack')
    });
    const status = await completeAttach(holder, client, identity);
    const resolved = await status;
    expect(resolved.generation).toBe(GENERATION);
    expect(resolved.ownsLease).toBe(true);
    expect(resolved.leaseEpoch).toBe(5);
    expect(events).toEqual(['hello-ack', 'terminal-state', 'attach-ack']);
    expect(client.terminalStatePreamble).toEqual(new Uint8Array(0));
  });

  it('accepts WAKEUP anywhere after adoption, including mid-attach (OB-30)', async () => {
    // §10.2.11: WAKEUP is an UNSOLICITED, coalescible notice that the durable
    // event stream advanced — it owes the §6 attach order no position. A child
    // that writes while ATTACH is in flight (every shell with a real TERM
    // prints its prompt immediately) makes the store commit right then, and
    // rejecting that frame made the whole attach fail: on a clean install no
    // such session could be attached at all.
    const wakeups: number[] = [];
    const protocolErrors: string[] = [];
    const { holder, client, identity } = await start({
      onWakeup: () => wakeups.push(1),
      onProtocolError: (error) => protocolErrors.push(error.code)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next(); // HELLO
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    holder.send(MoorKind.WAKEUP, new Uint8Array()); // adopted, ATTACH in flight
    await holder.next(); // ATTACH
    holder.send(MoorKind.WAKEUP, new Uint8Array()); // still before the preamble
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(MoorKind.WAKEUP, new Uint8Array()); // between preamble and ACK
    holder.send(MoorKind.ATTACH_ACK, statusPayload(identity, 5));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(5));
    await expect(attached).resolves.toMatchObject({ generation: GENERATION });
    expect(protocolErrors).toEqual([]);
    expect(wakeups.length).toBe(3);
  });

  it('still refuses WAKEUP before identity adoption', async () => {
    const protocolErrors: string[] = [];
    const wakeups: number[] = [];
    const { holder, client } = await start({
      onWakeup: () => wakeups.push(1),
      onProtocolError: (error) => protocolErrors.push(error.code)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next(); // HELLO, no HELLO_ACK yet
    holder.send(MoorKind.WAKEUP, new Uint8Array());
    await expect(attached).rejects.toThrow();
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    expect(wakeups).toEqual([]);
  });

  it('refuses an injected noncanonical POSIX identity', () => {
    const bytes = Buffer.from('/tmp/../session');
    const identity = new Uint8Array(1 + bytes.length);
    identity[0] = 1;
    identity.set(bytes, 1);
    expect(
      () => new MoorMasterClient('/tmp/session', GENERATION, {}, { identity })
    ).toThrowError(/IDENTITY_MISMATCH/);
  });

  it('refuses HEARTBEAT before identity adoption', async () => {
    const protocolErrors: string[] = [];
    const beats: bigint[] = [];
    const { holder, client } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onHeartbeat: (monotonicMs) => beats.push(monotonicMs)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next(); // HELLO, no HELLO_ACK yet
    holder.send(MoorKind.HEARTBEAT, joined(integer(9_000n, 8), Uint8Array.of(0)));
    await expect(attached).rejects.toThrow();
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    expect(beats).toEqual([]);
  });

  it('refuses output that overtakes the requested fresh-viewer LEASE_RESULT', async () => {
    const protocolErrors: string[] = [];
    const outputs: Uint8Array[] = [];
    const { holder, client, identity } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onOutput: (output) => outputs.push(output.bytes)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    attached.catch(() => undefined); // the overtake tears the attach down
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(MoorKind.ATTACH_ACK, statusPayload(identity, 5));

    holder.send(MoorKind.OUTPUT, joined(integer(1n, 8), integer(0n, 8), text('early')));
    await waitFor(() => protocolErrors.length === 1, 'early output refused');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    expect(outputs).toEqual([]);
    await expect(attached).rejects.toThrow();
  });

  it('keeps the attach deadline running until the requested LEASE_RESULT arrives', async () => {
    const { holder, client, identity } = await start({}, { attachDeadlineMs: 80 });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(MoorKind.ATTACH_ACK, statusPayload(identity, 5));
    // No LEASE_RESULT: the attach prefix is incomplete and must time out.
    await expect(attached).rejects.toThrow(/DEADLINE_EXCEEDED/);
  });

  it('keeps the fresh-lease attach deadline running through replay delivery', async () => {
    let closed = false;
    const { holder, client, identity } = await start(
      {
        onOutput: () => new Promise<void>(() => undefined),
        onClose: () => {
          closed = true;
        }
      },
      { attachDeadlineMs: 60 }
    );
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(identity, 5, { replay: { first: 1n, last: 1n, start: 0n, end: 1n } })
    );
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(5));
    holder.send(MoorKind.OUTPUT, joined(integer(1n, 8), integer(0n, 8), text('x')));

    await expect(attached).rejects.toThrow(/DEADLINE_EXCEEDED/);
    await waitFor(() => closed, 'fresh-lease replay deadline close');
  });

  it('refuses a LEASE_RESULT that contradicts the attach status', async () => {
    const protocolErrors: string[] = [];
    const { holder, client, identity } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    attached.catch(() => undefined);
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(MoorKind.ATTACH_ACK, statusPayload(identity, 5)); // ownsLease = true
    // Refused result contradicts the ACK's ownsLease bit.
    holder.send(
      MoorKind.LEASE_RESULT,
      joined(Uint8Array.of(3, 1, 0, 0), integer(5, 4), new Uint8Array(16))
    );
    await waitFor(() => protocolErrors.length === 1, 'contradictory lease result refused');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    await expect(attached).rejects.toThrow();
  });

  it('walks the discarded-prefix GAP baseline exactly and refuses stray gaps', async () => {
    const protocolErrors: string[] = [];
    const gaps: Array<{ first: bigint; last: bigint }> = [];
    const outputs: bigint[] = [];
    const { holder, client, identity } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onGap: (gap) => gaps.push({ first: gap.first, last: gap.last }),
      onOutput: (output) => outputs.push(output.sequence)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(identity, 5, { replay: { first: 3n, last: 4n, start: 100n, end: 120n } })
    );
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(5));

    holder.send(MoorKind.GAP, joined(integer(1n, 8), integer(2n, 8)));
    holder.send(MoorKind.OUTPUT, joined(integer(3n, 8), integer(100n, 8), text('0123456789')));
    holder.send(MoorKind.OUTPUT, joined(integer(4n, 8), integer(110n, 8), text('0123456789')));
    await attached;
    await waitFor(() => outputs.length === 2, 'replay after the baseline gap');
    expect(gaps).toEqual([{ first: 1n, last: 2n }]);
    expect(outputs).toEqual([3n, 4n]);

    // The baseline is consumed: any further GAP is a protocol breach.
    holder.send(MoorKind.GAP, joined(integer(5n, 8), integer(6n, 8)));
    await waitFor(() => protocolErrors.length === 1, 'stray gap refused');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
  });

  it('refuses resumed and released lease results answering the fresh attach shorthand', async () => {
    // Outcome 01 resumed and 02 released answer standalone lease operations
    // this client never sent; the attach slot admits only 00 granted / 03 refused.
    const stray: Array<{ label: string; payload: Uint8Array }> = [
      {
        label: 'resumed',
        payload: joined(Uint8Array.of(1, 0, 0, 0), integer(5, 4), new Uint8Array(16).fill(0xd4))
      },
      {
        label: 'released',
        payload: joined(Uint8Array.of(2, 0, 0, 0), integer(5, 4), new Uint8Array(16))
      }
    ];
    for (const { label, payload } of stray) {
      const protocolErrors: string[] = [];
      const { holder, client, identity } = await start({
        onProtocolError: (error) => protocolErrors.push(error.code)
      });
      const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
      attached.catch(() => undefined);
      await holder.next();
      holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
      await holder.next();
      holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
      holder.send(MoorKind.ATTACH_ACK, statusPayload(identity, 5));
      holder.send(MoorKind.LEASE_RESULT, payload);
      await waitFor(() => protocolErrors.length === 1, `${label} result refused`);
      expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
      await expect(attached).rejects.toThrow();
    }
  });

  it('refuses a refused lease result whose epoch is not the ACK current epoch', async () => {
    const protocolErrors: string[] = [];
    const { holder, client, identity } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    attached.catch(() => undefined);
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(MoorKind.ATTACH_ACK, statusPayload(identity, 5, { ownsLease: false }));
    holder.send(
      MoorKind.LEASE_RESULT,
      joined(Uint8Array.of(3, 1, 0, 0), integer(9, 4), new Uint8Array(16))
    );
    await waitFor(() => protocolErrors.length === 1, 'epoch-mismatched refusal refused');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    await expect(attached).rejects.toThrow();
  });

  it('requires the final replay record to end exactly at the ACK replay.end', async () => {
    const protocolErrors: string[] = [];
    const outputs: bigint[] = [];
    const { holder, client, identity } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onOutput: (output) => outputs.push(output.sequence)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    attached.catch(() => undefined);
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(identity, 5, { replay: { first: 3n, last: 4n, start: 100n, end: 121n } })
    );
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(5));

    holder.send(MoorKind.GAP, joined(integer(1n, 8), integer(2n, 8)));
    holder.send(MoorKind.OUTPUT, joined(integer(3n, 8), integer(100n, 8), text('0123456789')));
    // The boundary record ends at 120, but the ACK promised replay.end 121.
    holder.send(MoorKind.OUTPUT, joined(integer(4n, 8), integer(110n, 8), text('0123456789')));
    await waitFor(() => protocolErrors.length === 1, 'short replay boundary refused');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    expect(outputs).toEqual([3n]);
    await expect(attached).rejects.toThrow();
  });

  it('bounds OUTPUT_ACK to records actually delivered', async () => {
    const outputs: bigint[] = [];
    const { holder, client, identity } = await start({
      onOutput: (output) => outputs.push(output.sequence)
    });
    await completeAttach(holder, client, identity);
    expect(() => client.ackOutput(1n)).toThrow(/highest delivered/);

    holder.send(MoorKind.OUTPUT, joined(integer(1n, 8), integer(0n, 8), text('x')));
    await waitFor(() => outputs.length === 1, 'first output');
    client.ackOutput(0n); // zero = none consumed, always legal
    client.ackOutput(1n);
    expect(() => client.ackOutput(2n)).toThrow(/highest delivered/);
  });

  it('rejects a pending attach immediately on a holder ERROR refusal', async () => {
    const errors: number[] = [];
    const { holder, client } = await start({
      onHolderError: (code) => errors.push(code)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next(); // HELLO — refuse instead of HELLO_ACK
    holder.send(
      MoorKind.ERROR,
      joined(integer(9, 2), joined(integer(19, 2), text('generation mismatch')))
    );
    await expect(attached).rejects.toThrow(/error code 9/);
    expect(errors).toEqual([9]);
    expect(() => client.sendInput(text('x'))).toThrow(/not attached/);
  });

  it('drops the lease when the holder reports LEASE_NOT_HELD', async () => {
    const errors: number[] = [];
    const { holder, client, identity } = await start({
      onHolderError: (code) => errors.push(code)
    });
    await completeAttach(holder, client, identity);
    holder.send(
      MoorKind.ERROR,
      joined(integer(15, 2), joined(integer(14, 2), text('lease not held')))
    );
    await waitFor(() => errors.length === 1, 'lease-not-held delivered');
    expect(() => client.sendInput(text('x'))).toThrow(/lease/);
    expect(() => client.sendResize(80, 24)).toThrow(/lease/);
  });

  it('invalidates and restores verified-live evidence on the §10 heartbeat window', async () => {
    const transitions: string[] = [];
    const { holder, client, identity } = await start(
      {
        onLivenessLost: () => transitions.push('lost'),
        onLivenessRestored: () => transitions.push('restored')
      },
      { livenessWindowMs: 60 }
    );
    await completeAttach(holder, client, identity);
    expect(client.verifiedLive).toBe(true);

    await waitFor(() => transitions.length === 1, 'liveness lost');
    expect(transitions).toEqual(['lost']);
    expect(client.verifiedLive).toBe(false);

    holder.send(MoorKind.HEARTBEAT, joined(integer(9_000n, 8), Uint8Array.of(0)));
    await waitFor(() => transitions.length === 2, 'liveness restored');
    expect(transitions).toEqual(['lost', 'restored']);
    expect(client.verifiedLive).toBe(true);
  });

  it('retries the pending input with identical bytes for the cached receipt', async () => {
    const receipts: bigint[] = [];
    const { holder, client, identity } = await start({
      onInputReceipt: (receipt) => receipts.push(receipt.requestId)
    });
    await completeAttach(holder, client, identity);
    expect(client.retryPendingInput()).toBe(false); // nothing pending yet

    client.sendInput(text('ls\r'));
    const first = await holder.next();
    expect(client.retryPendingInput()).toBe(true);
    const retry = await holder.next();
    // §7.3: byte-identical replay — same kind, same payload (id/epoch/bytes).
    expect(retry.kind).toBe(MoorKind.INPUT);
    expect(retry.payload).toEqual(first.payload);

    const receipt = joined(
      integer(5, 4),
      integer(1n, 8),
      integer(GENERATION, 4),
      INCARNATION,
      integer(3n, 8),
      Uint8Array.of(0),
      integer(0, 2)
    );
    holder.send(MoorKind.INPUT_RECEIPT, receipt);
    await waitFor(() => receipts.length === 1, 'receipt after retry');
  });

  it('resumes the exact viewer lease before attach and restores one ambiguous input tuple', async () => {
    const first = await start();
    await completeAttach(first.holder, first.client, first.identity);
    first.client.sendInput(text('ambiguous'));
    const originalInput = await first.holder.next();
    const snapshot = first.client.reconnectSnapshot();
    expect(snapshot?.lease?.pendingInput).toMatchObject({ requestId: 1n });
    first.client.close();

    const holder = new FakeHolder();
    await holder.listen();
    const client = new MoorMasterClient(holder.sockPath, GENERATION, {}, {
      resumeCursor: snapshot?.output,
      resumeLease: snapshot?.lease,
      requireSameIncarnation: true
    });
    cleanups.push(() => {
      client.close();
      holder.close();
    });
    await client.connect();
    const attaching = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next(); // HELLO
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(posixMoorIdentity(holder.sockPath)));

    const resume = await holder.next();
    expect(resume.kind).toBe(MoorKind.LEASE_REQUEST);
    expect(resume.payload).toEqual(
      joined(
        Uint8Array.of(1, 0, 0, 0),
        integer(5, 4),
        INCARNATION,
        new Uint8Array(16).fill(0xd4)
      )
    );
    holder.send(MoorKind.LEASE_RESULT, resumedLeaseResultPayload(5));

    const attach = await holder.next();
    expect(attach.kind).toBe(MoorKind.ATTACH);
    expect(attach.payload[4]! & 1).toBe(0);
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(MoorKind.ATTACH_ACK, statusPayload(posixMoorIdentity(holder.sockPath), 5));
    await attaching;

    expect(client.retryPendingInput()).toBe(true);
    const retry = await holder.next();
    expect(retry.kind).toBe(MoorKind.INPUT);
    expect(retry.payload).toEqual(originalInput.payload);
  });

  it('surfaces ambiguous input and never replays it when resume falls back to a fresh epoch', async () => {
    const first = await start();
    await completeAttach(first.holder, first.client, first.identity);
    first.client.sendInput(text('must-not-cross-epochs'), 42);
    await first.holder.next();
    const snapshot = first.client.reconnectSnapshot()!;
    first.client.close();

    const losses: Array<{ requestId: bigint; bytes: Uint8Array; surfaceId?: number }> = [];
    const holder = new FakeHolder();
    await holder.listen();
    const client = new MoorMasterClient(
      holder.sockPath,
      GENERATION,
      { onInputContinuityLost: (pending) => losses.push(pending) },
      {
        resumeCursor: snapshot.output,
        resumeLease: snapshot.lease,
        requireSameIncarnation: true
      }
    );
    cleanups.push(() => {
      client.close();
      holder.close();
    });
    await client.connect();
    const attaching = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    const identity = posixMoorIdentity(holder.sockPath);
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    expect((await holder.next()).kind).toBe(MoorKind.LEASE_REQUEST);
    holder.send(
      MoorKind.LEASE_RESULT,
      joined(Uint8Array.of(3, 2, 0, 0), integer(6, 4), new Uint8Array(16))
    );
    const attach = await holder.next();
    expect(attach.kind).toBe(MoorKind.ATTACH);
    expect(attach.payload[4]! & 1).toBe(1);
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(MoorKind.ATTACH_ACK, statusPayload(identity, 6));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(6));
    await attaching;

    expect(losses).toEqual([
      { requestId: 1n, bytes: text('must-not-cross-epochs'), surfaceId: 42 }
    ]);
    expect(client.retryPendingInput()).toBe(false);
    client.sendInput(text('new'));
    const fresh = await holder.next();
    expect(new DataView(fresh.payload.buffer, fresh.payload.byteOffset).getBigUint64(4, true)).toBe(1n);
  });

  it('upgrades a busy attached observer with a fresh viewer lease without another attach baseline', async () => {
    const { holder, client, identity } = await start();
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(identity, 5, { ownsLease: false })
    );
    holder.send(
      MoorKind.LEASE_RESULT,
      joined(Uint8Array.of(3, 1, 0, 0), integer(5, 4), new Uint8Array(16))
    );
    await attached;

    const acquiring = client.acquireViewerLease();
    const request = await holder.next();
    expect(request.kind).toBe(MoorKind.LEASE_REQUEST);
    expect(request.payload).toEqual(new Uint8Array(40));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(6));
    await expect(acquiring).resolves.toBe('granted');
    client.sendInput(text('after-upgrade'));
    const input = await holder.next();
    expect(new DataView(input.payload.buffer, input.payload.byteOffset).getUint32(0, true)).toBe(6);
  });

  it('discards records at or below the reconnect cursor without re-delivering them', async () => {
    const outputs: bigint[] = [];
    const gaps: number[] = [];
    const { holder, client, identity } = await start(
      {
        onOutput: (output) => outputs.push(output.sequence),
        onGap: () => gaps.push(1)
      },
      { resumeCursor: { sequence: 3n, incarnation: INCARNATION } }
    );
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(identity, 5, { replay: { first: 3n, last: 5n, start: 100n, end: 130n } })
    );
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(5));

    // Baseline: GAP{1,2} names records the prior connection consumed — silent.
    holder.send(MoorKind.GAP, joined(integer(1n, 8), integer(2n, 8)));
    holder.send(MoorKind.OUTPUT, joined(integer(3n, 8), integer(100n, 8), text('0123456789')));
    holder.send(MoorKind.OUTPUT, joined(integer(4n, 8), integer(110n, 8), text('0123456789')));
    holder.send(MoorKind.OUTPUT, joined(integer(5n, 8), integer(120n, 8), text('0123456789')));
    await attached;
    await waitFor(() => outputs.length === 2, 'only fresh records delivered');
    expect(outputs).toEqual([4n, 5n]); // 3n is the cursor duplicate
    expect(gaps).toEqual([]);
    client.ackOutput(5n); // received records bound the ack even when discarded
  });

  it('cumulatively acknowledges validated replay suppressed by the reconnect cursor', async () => {
    const outputs: bigint[] = [];
    const { holder, client, identity } = await start(
      { onOutput: (output) => outputs.push(output.sequence) },
      { resumeCursor: { sequence: 3n, incarnation: INCARNATION } }
    );
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(identity, 5, { replay: { first: 1n, last: 3n, start: 0n, end: 3n } })
    );
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(5));

    const next = holder.next();
    holder.send(MoorKind.OUTPUT, joined(integer(1n, 8), integer(0n, 8), text('a')));
    holder.send(MoorKind.OUTPUT, joined(integer(2n, 8), integer(1n, 8), text('b')));
    holder.send(MoorKind.OUTPUT, joined(integer(3n, 8), integer(2n, 8), text('c')));
    await attached;
    const ack = await Promise.race([
      next,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50))
    ]);
    expect(ack?.kind).toBe(MoorKind.OUTPUT_ACK);
    expect(new DataView(ack!.payload.buffer, ack!.payload.byteOffset).getBigUint64(0, true)).toBe(3n);
    expect(outputs).toEqual([]);
  });

  it('fails recovery closed when retained replay starts beyond the delivered cursor', async () => {
    const protocolErrors: string[] = [];
    const { holder, client, identity } = await start(
      { onProtocolError: (error) => protocolErrors.push(error.code) },
      {
        resumeCursor: { sequence: 3n, incarnation: INCARNATION },
        requireReplayContinuity: true
      }
    );
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    attached.catch(() => undefined);
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(identity, 5, { replay: { first: 5n, last: 5n, start: 100n, end: 110n } })
    );
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(5));
    holder.send(MoorKind.GAP, joined(integer(1n, 8), integer(4n, 8)));
    await waitFor(() => protocolErrors.length === 1, 'unsafe recovery gap refused');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    expect(() => client.sendInput(text('never-on-stale-screen'))).toThrow(/attached|closed/i);
    await expect(attached).rejects.toThrow();
  });

  it('sends one coalesced auto-ack per delivered batch when the policy is enabled', async () => {
    const outputs: bigint[] = [];
    const { holder, client, identity } = await start(
      { onOutput: (output) => outputs.push(output.sequence) },
      { autoAckOutput: true }
    );
    await completeAttach(holder, client, identity);
    holder.send(
      MoorKind.OUTPUT,
      joined(integer(1n, 8), integer(0n, 8), text('a'))
    );
    holder.send(
      MoorKind.OUTPUT,
      joined(integer(2n, 8), integer(1n, 8), text('b'))
    );
    await waitFor(() => outputs.length === 2, 'both records delivered');
    const ack = await holder.next();
    expect(ack.kind).toBe(MoorKind.OUTPUT_ACK);
    expect(new DataView(ack.payload.buffer, ack.payload.byteOffset).getBigUint64(0, true)).toBe(2n);
  });

  it('closes the connection when an emitted keepalive is refused with LEASE_NOT_HELD', async () => {
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const { holder, client, identity } = await start({
      onClose: markClosed
    });
    vi.useFakeTimers();
    await completeAttach(holder, client, identity);
    const next = holder.next();
    await vi.advanceTimersByTimeAsync(3_000);
    const keepalive = await next;
    expect(keepalive.kind).toBe(MoorKind.LEASE_KEEPALIVE);
    holder.send(
      MoorKind.ERROR,
      joined(integer(15, 2), joined(integer(14, 2), text('lease not held')))
    );
    await closed;
    expect(() => client.requestStatus()).toThrow(/not attached/);
  });

  it('refuses a nonzero resume cursor that does not carry its source incarnation', () => {
    expect(
      () => new MoorMasterClient('/tmp/x', GENERATION, {}, { resumeCursor: { sequence: 5n } })
    ).toThrowError(/incarnation/);
    // A zero cursor claims nothing and needs no binding.
    expect(
      new MoorMasterClient('/tmp/x', GENERATION, {}, { resumeCursor: { sequence: 0n } })
    ).toBeInstanceOf(MoorMasterClient);
  });

  it('fails the attach closed when the resume cursor exceeds the incarnation high-water', async () => {
    const protocolErrors: string[] = [];
    const { holder, client, identity } = await start(
      { onProtocolError: (error) => protocolErrors.push(error.code) },
      { resumeCursor: { sequence: 5n, incarnation: INCARNATION } }
    );
    const attached = client.attach({ columns: 80, rows: 24, requestLease: false });
    attached.catch(() => undefined);
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(MoorKind.ATTACH_ACK, statusPayload(identity, 5)); // empty history: high-water 0
    await waitFor(() => protocolErrors.length === 1, 'impossible cursor refused');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    await expect(attached).rejects.toThrow();
  });

  it('voids a cursor bound to a different holder incarnation instead of suppressing', async () => {
    const outputs: bigint[] = [];
    const { holder, client, identity } = await start(
      { onOutput: (output) => outputs.push(output.sequence) },
      { resumeCursor: { sequence: 5n, incarnation: new Uint8Array(16).fill(0x77) } }
    );
    await completeAttach(holder, client, identity); // holder incarnation differs: cursor void
    holder.send(MoorKind.OUTPUT, joined(integer(1n, 8), integer(0n, 8), text('fresh')));
    await waitFor(() => outputs.length === 1, 'new-incarnation record delivered');
    expect(outputs).toEqual([1n]);
  });

  it('keeps recovery indeterminate when the holder incarnation changed', async () => {
    const protocolErrors: string[] = [];
    const { holder, client, identity } = await start(
      { onProtocolError: (error) => protocolErrors.push(error.code) },
      {
        resumeCursor: { sequence: 1n, incarnation: INCARNATION },
        requireSameIncarnation: true
      }
    );
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity, new Uint8Array(16).fill(0x77)));
    await expect(attached).rejects.toThrow(/incarnation changed/i);
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
  });

  it('invalidates the local lease when STATUS_REPLY owns a different epoch', async () => {
    let replies = 0;
    const { holder, client, identity } = await start({
      onStatusReply: () => {
        replies += 1;
      }
    });
    await completeAttach(holder, client, identity);
    client.requestStatus();
    await holder.next();
    holder.send(MoorKind.STATUS_REPLY, statusPayload(identity, 6, { ownsLease: true }));
    await waitFor(() => replies === 1, 'status reply consumed');
    expect(() => client.sendInput(text('stale epoch'))).toThrow(/lease/);
  });

  it('does not poison the request slot when INPUT encoding rejects locally', async () => {
    const { holder, client, identity } = await start();
    await completeAttach(holder, client, identity);
    expect(() => client.sendInput(new Uint8Array((16 << 20) + 1))).toThrow(/OVERSIZED/);
    // The slot and request id are untouched: the next valid input is id 1.
    client.sendInput(text('x'));
    const input = await holder.next();
    expect(input.kind).toBe(MoorKind.INPUT);
    const view = new DataView(input.payload.buffer, input.payload.byteOffset);
    expect(view.getBigUint64(4, true)).toBe(1n);
  });

  it('drops the local lease when a STATUS_REPLY reports ownership loss', async () => {
    let replies = 0;
    const { holder, client, identity } = await start({
      onStatusReply: () => {
        replies += 1;
      }
    });
    await completeAttach(holder, client, identity);
    client.requestStatus();
    await holder.next(); // STATUS request
    holder.send(MoorKind.STATUS_REPLY, statusPayload(identity, 5, { ownsLease: false }));
    await waitFor(() => replies === 1, 'status reply consumed');
    expect(() => client.sendInput(text('stale'))).toThrow(/lease/);
    expect(() => client.sendResize(80, 24)).toThrow(/lease/);
  });

  it('refuses a receipt whose byte count contradicts the sent input', async () => {
    const protocolErrors: string[] = [];
    const receipts: bigint[] = [];
    const { holder, client, identity } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onInputReceipt: (receipt) => receipts.push(receipt.requestId)
    });
    await completeAttach(holder, client, identity);
    client.sendInput(text('ls\r')); // 3 bytes
    await holder.next();

    // Written receipt claiming 2 of 3 bytes: "written" means the COMPLETE write.
    const shortReceipt = joined(
      integer(5, 4),
      integer(1n, 8),
      integer(GENERATION, 4),
      INCARNATION,
      integer(2n, 8),
      Uint8Array.of(0),
      integer(0, 2)
    );
    holder.send(MoorKind.INPUT_RECEIPT, shortReceipt);
    await waitFor(() => protocolErrors.length === 1, 'short written receipt refused');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    expect(receipts).toEqual([]);
  });

  it('refuses an unsolicited LEASE_RESULT when the attach requested no lease', async () => {
    const protocolErrors: string[] = [];
    const { holder, client, identity } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: false });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());
    holder.send(MoorKind.ATTACH_ACK, statusPayload(identity, 5));
    await attached;

    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(5));
    await waitFor(() => protocolErrors.length === 1, 'unsolicited lease result refused');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
  });

  it('refuses ATTACH_ACK when the required terminal-state preamble is missing', async () => {
    const protocolErrors: string[] = [];
    let closed = false;
    const { holder, client, identity } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onClose: () => {
        closed = true;
      }
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.ATTACH_ACK, statusPayload(identity, 5)); // no preamble: refused
    await expect(attached).rejects.toThrow();
    await waitFor(() => closed, 'fail-closed close');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
  });

  it('refuses a second or post-ATTACH_ACK preamble', async () => {
    const protocolErrors: string[] = [];
    const { holder, client, identity } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code)
    });
    await completeAttach(holder, client, identity);
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble()); // post-ACK: refused
    await waitFor(() => protocolErrors.length === 1, 'post-ACK preamble refused');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
  });

  it('enforces one absolute identity/adoption deadline against a silent holder', async () => {
    const { client } = await start({}, { attachDeadlineMs: 60 });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await expect(attached).rejects.toThrow(/DEADLINE_EXCEEDED/);
    expect(() => client.sendInput(text('x'))).toThrow(/not attached/);
  });

  it('rejects a pending attach when the holder closes cleanly', async () => {
    const { holder, client } = await start();
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.connection!.end();
    await expect(attached).rejects.toThrow(/closed/);
  });

  it('delivers output after attach, sends input at the lease epoch, and acks output', async () => {
    const outputs: Array<{ sequence: bigint; bytes: Uint8Array }> = [];
    const receipts: number[] = [];
    const { holder, client, identity } = await start({
      onOutput: (output) => outputs.push({ sequence: output.sequence, bytes: output.bytes }),
      onInputReceipt: (receipt) => receipts.push(receipt.status)
    });
    await completeAttach(holder, client, identity);

    holder.send(
      MoorKind.OUTPUT,
      joined(integer(1n, 8), integer(0n, 8), text('hello from moor'))
    );
    await waitFor(() => outputs.length === 1, 'live output');
    expect(new TextDecoder().decode(outputs[0]!.bytes)).toBe('hello from moor');

    client.ackOutput(1n);
    const ack = await holder.next();
    expect(ack.kind).toBe(MoorKind.OUTPUT_ACK);

    client.sendInput(text('ls\r'));
    const input = await holder.next();
    expect(input.kind).toBe(MoorKind.INPUT);
    const view = new DataView(input.payload.buffer, input.payload.byteOffset);
    expect(view.getUint32(0, true)).toBe(5); // lease epoch from attach status
    expect(view.getBigUint64(4, true)).toBe(1n); // first request id

    // receipt: epoch u32, requestId u64, generation u32, incarnation 16, written u64, status u8, result u16 = 43
    const receipt = joined(
      integer(5, 4),
      integer(1n, 8),
      integer(GENERATION, 4),
      INCARNATION,
      integer(3n, 8),
      Uint8Array.of(0),
      integer(0, 2)
    );
    holder.send(MoorKind.INPUT_RECEIPT, receipt);
    await waitFor(() => receipts.length === 1, 'input receipt');
  });

  it('routes holder errors and heartbeats without closing, and resize carries the lease epoch', async () => {
    const errors: number[] = [];
    const beats: bigint[] = [];
    let closed = false;
    const { holder, client, identity } = await start({
      onHolderError: (code) => errors.push(code),
      onHeartbeat: (monotonicMs) => beats.push(monotonicMs),
      onClose: () => {
        closed = true;
      }
    });
    await completeAttach(holder, client, identity);

    holder.send(MoorKind.HEARTBEAT, joined(integer(9_000n, 8), Uint8Array.of(0)));
    holder.send(
      MoorKind.ERROR,
      joined(integer(20, 2), joined(integer(12, 2), text('write failed')))
    );
    await waitFor(() => errors.length === 1 && beats.length === 1, 'error + heartbeat');
    expect(errors[0]).toBe(20);
    expect(closed).toBe(false);

    client.sendResize(120, 40);
    const resize = await holder.next();
    expect(resize.kind).toBe(MoorKind.RESIZE);
    const view = new DataView(resize.payload.buffer, resize.payload.byteOffset);
    expect(view.getUint32(0, true)).toBe(5); // lease epoch
    expect(view.getUint16(4, true)).toBe(120);
    expect(view.getUint16(6, true)).toBe(40);
  });

  it('fails closed on a scope mismatch: protocol error, socket closed, no silent resync', async () => {
    const protocolErrors: string[] = [];
    let closed = false;
    const { holder, client, identity } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onClose: () => {
        closed = true;
      }
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    attached.catch(() => undefined); // rejection observed via handlers below
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(identity));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, emptyPreamble());

    // Holder replies at the WRONG generation scope: fail closed, never adopt.
    holder.send(MoorKind.ATTACH_ACK, statusPayload(identity, 5), GENERATION + 1);
    await waitFor(() => protocolErrors.length === 1 && closed, 'fail-closed close');
    await expect(attached).rejects.toThrow();
    expect(() => client.sendInput(text('x'))).toThrow();
  });

  it('makes writes fail after an attached holder closes cleanly', async () => {
    let closed = false;
    const { holder, client, identity } = await start({
      onClose: () => {
        closed = true;
      }
    });
    await completeAttach(holder, client, identity);
    holder.connection!.end();
    await waitFor(() => closed, 'close observed');
    expect(() => client.sendInput(text('x'))).toThrow(/not attached/);
  });
});
