import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MoorCodec, type MoorMessage } from '../src/shared/moorWire/codec.js';
import { MoorKind } from '../src/shared/moorWire/messages.js';
import { MoorMasterClient } from '../src/server/runtime/moorMasterClient.js';

const GENERATION = 7;
const INCARNATION = new Uint8Array(16).fill(0xa1);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

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
const identity = (path: string): Uint8Array => joined(Uint8Array.of(1), text(path));

function helloAckPayload(path: string): Uint8Array {
  return joined(Uint8Array.of(3), integer(GENERATION, 4), INCARNATION, wide(identity(path)));
}

function statusPayload(
  path: string,
  options: {
    ownsLease?: boolean;
    viewers?: boolean;
    leaseEpoch?: number;
    replay?: {
      first: bigint;
      last: bigint;
      start: bigint;
      end: bigint;
      complete: boolean;
    };
  } = {}
): Uint8Array {
  const tail = new Uint8Array(69);
  const view = new DataView(tail.buffer);
  const ownsLease = options.ownsLease ?? true;
  const viewers = options.viewers ?? true;
  const replay = options.replay ?? {
    first: 0n,
    last: 0n,
    start: 0n,
    end: 0n,
    complete: true
  };
  view.setBigUint64(0, replay.first, true);
  view.setBigUint64(8, replay.last, true);
  view.setBigUint64(16, replay.start, true);
  view.setBigUint64(24, replay.end, true);
  view.setUint8(
    32,
    (replay.complete ? 0x01 : 0) | (ownsLease ? 0x10 : 0) | (viewers ? 0x20 : 0) | 0x40
  );
  view.setUint32(33, options.leaseEpoch ?? 5, true);
  return joined(
    wide(identity(path)),
    integer(GENERATION, 4),
    INCARNATION,
    Uint8Array.of(0),
    wide(new Uint8Array(0)),
    Uint8Array.of(0xff),
    integer(0n, 8),
    integer(0n, 8),
    new Uint8Array(32),
    integer(1_000n, 8),
    integer(2_000n, 8),
    new Uint8Array(16).fill(0xb2),
    wide(text('/tmp/moor-holder')),
    integer(4321, 4),
    integer(1, 4),
    new Uint8Array(16).fill(0xc3),
    tail
  );
}

function leaseResultPayload(
  outcome: 0 | 1 | 2 | 3,
  reason: 0 | 1,
  epoch = 5
): Uint8Array {
  return joined(
    Uint8Array.of(outcome, reason, 0, 0),
    integer(epoch, 4),
    outcome <= 1 ? new Uint8Array(16).fill(0xd4) : new Uint8Array(16)
  );
}

function inputReceiptPayload(
  requestId: bigint,
  generation = GENERATION,
  incarnation: Uint8Array = INCARNATION,
  written = 1n,
  status = 0,
  result = 0
): Uint8Array {
  return joined(
    integer(5, 4),
    integer(requestId, 8),
    integer(generation, 4),
    incarnation,
    integer(written, 8),
    Uint8Array.of(status),
    integer(result, 2)
  );
}

class ReviewHolder {
  readonly root = mkdtempSync(join(tmpdir(), 'moor-client-review-'));
  readonly sockPath = join(this.root, 'session');
  private server: Server | undefined;
  peer: Socket | undefined;
  private readonly codec = new MoorCodec();
  private readonly inbox: MoorMessage[] = [];
  private waiters: Array<(message: MoorMessage) => void> = [];

  async listen(): Promise<void> {
    this.server = createServer((socket) => {
      this.peer = socket;
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
    const message = this.inbox.shift();
    return message ? Promise.resolve(message) : new Promise((resolve) => this.waiters.push(resolve));
  }

  send(kind: number, payload: Uint8Array): void {
    this.peer!.write(this.codec.encode(GENERATION, kind, payload));
  }

  close(): void {
    this.peer?.destroy();
    this.server?.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}

async function settle<T>(promise: Promise<T>, timeoutMs = 250): Promise<'resolved' | 'rejected' | 'pending'> {
  return Promise.race([
    promise.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), timeoutMs))
  ]);
}

describe('MoorMasterClient adversarial lifecycle replay', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    while (cleanup.length > 0) cleanup.pop()!();
  });

  async function start(
    handlers: ConstructorParameters<typeof MoorMasterClient>[2] = {},
    options: ConstructorParameters<typeof MoorMasterClient>[3] = {}
  ) {
    const holder = new ReviewHolder();
    await holder.listen();
    const client = new MoorMasterClient(holder.sockPath, GENERATION, handlers, options);
    cleanup.push(() => {
      client.close();
      holder.close();
    });
    await client.connect();
    return { holder, client };
  }

  async function attachWithLease(
    handlers: ConstructorParameters<typeof MoorMasterClient>[2] = {}
  ) {
    const { holder, client } = await start(handlers);
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(0, 0));
    await attached;
    return { holder, client };
  }

  it('refuses an injected noncanonical POSIX identity', () => {
    expect(
      () =>
        new MoorMasterClient('/tmp/session', GENERATION, {}, {
          identity: identity('/tmp/../session')
        })
    ).toThrow(/IDENTITY_MISMATCH/);
  });

  it('requires every nonzero reconnect cursor to carry its holder incarnation', () => {
    expect(
      () =>
        new MoorMasterClient('/tmp/session', GENERATION, {}, {
          resumeCursor: { sequence: 1n }
        })
    ).toThrow(/cursor.*incarnation/i);
  });

  it('refuses HEARTBEAT before identity adoption and attachment', async () => {
    const protocolErrors: string[] = [];
    const heartbeats: bigint[] = [];
    const { holder, client } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onHeartbeat: (monotonicMs) => heartbeats.push(monotonicMs)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next(); // HELLO, but no HELLO_ACK yet
    holder.send(MoorKind.HEARTBEAT, joined(integer(9_000n, 8), Uint8Array.of(0)));
    expect(await settle(attached)).toBe('rejected');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    expect(heartbeats).toEqual([]);
  });

  it('refuses output that overtakes the required fresh-viewer LEASE_RESULT', async () => {
    const protocolErrors: string[] = [];
    const outputs: Uint8Array[] = [];
    const { holder, client } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onOutput: (output) => outputs.push(output.bytes)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath));
    holder.send(MoorKind.OUTPUT, joined(integer(1n, 8), integer(0n, 8), text('early')));
    expect(await settle(attached)).toBe('rejected');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    expect(outputs).toEqual([]);
  });

  it('requires ATTACH_ACK to reflect this fully attached viewer', async () => {
    const { holder, client } = await start();
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath, { viewers: false }));
    expect(await settle(attached)).toBe('rejected');
  });

  it('keeps a granted viewer lease alive every three seconds', async () => {
    const { holder, client } = await start();
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(0, 0));
    await attached;

    const keepalive = await Promise.race([
      holder.next(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3_400))
    ]);
    expect(keepalive?.kind).toBe(MoorKind.LEASE_KEEPALIVE);
    expect(keepalive?.payload).toEqual(
      joined(integer(5, 4), new Uint8Array(16).fill(0xd4))
    );
  });

  it('does not postpone lease keepalive for non-owner STATUS traffic', async () => {
    const { holder, client } = await start();
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(0, 0));
    await attached;
    await new Promise((resolve) => setTimeout(resolve, 2_400));

    client.requestStatus();
    expect((await holder.next()).kind).toBe(MoorKind.STATUS);
    const keepalive = await Promise.race([
      holder.next(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1_000))
    ]);
    expect(keepalive?.kind).toBe(MoorKind.LEASE_KEEPALIVE);
  });

  it('refuses a granted lease result when ATTACH_ACK says this viewer does not own it', async () => {
    const protocolErrors: string[] = [];
    const leaseResults: number[] = [];
    const { holder, client } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onLeaseResult: (result) => leaseResults.push(result.outcome)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(holder.sockPath, { ownsLease: false, viewers: true, leaseEpoch: 5 })
    );
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(0, 0));
    expect(await settle(attached)).toBe('rejected');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    expect(leaseResults).toEqual([]);
  });

  it.each([1, 2] as const)(
    'refuses LEASE_RESULT outcome %i after a fresh attach request',
    async (outcome) => {
      const protocolErrors: string[] = [];
      const leaseResults: number[] = [];
      const { holder, client } = await start({
        onProtocolError: (error) => protocolErrors.push(error.code),
        onLeaseResult: (result) => leaseResults.push(result.outcome)
      });
      const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
      await holder.next();
      holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
      await holder.next();
      holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
      holder.send(
        MoorKind.ATTACH_ACK,
        statusPayload(holder.sockPath, {
          ownsLease: outcome === 1,
          viewers: true,
          leaseEpoch: 5
        })
      );
      holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(outcome, 0));

      expect(await settle(attached)).toBe('rejected');
      expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
      expect(leaseResults).toEqual([]);
    }
  );

  it('refuses a fresh-lease refusal whose epoch disagrees with ATTACH_ACK', async () => {
    const protocolErrors: string[] = [];
    const { holder, client } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(holder.sockPath, { ownsLease: false, viewers: true, leaseEpoch: 5 })
    );
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(3, 1, 6));

    expect(await settle(attached)).toBe('rejected');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
  });

  it('does not let an attached observer send lease-owned input or resize', async () => {
    const { holder, client } = await start();
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(holder.sockPath, { ownsLease: false, viewers: true })
    );
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(3, 1));
    await attached;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(() => client.sendInput(text('x'))).toThrow(/lease/i);
    expect(() => client.sendResize(120, 40)).toThrow(/lease/i);
  });

  it('permits only one input request in flight until its exact receipt', async () => {
    const { holder, client } = await start();
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(0, 0));
    await attached;
    await new Promise((resolve) => setTimeout(resolve, 20));

    client.sendInput(text('a'));
    expect(() => client.sendInput(text('b'))).toThrow(/in flight|receipt/i);
  });

  it('refuses a receipt that does not match the pending request generation', async () => {
    const protocolErrors: string[] = [];
    const receipts: bigint[] = [];
    const { holder, client } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onInputReceipt: (receipt) => receipts.push(receipt.requestId)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(0, 0));
    await attached;
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.sendInput(text('x'));
    await holder.next();

    holder.send(MoorKind.INPUT_RECEIPT, inputReceiptPayload(1n, GENERATION + 1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(protocolErrors).not.toHaveLength(0);
    expect(receipts).toEqual([]);
  });

  it('refuses a noncontiguous first live output record', async () => {
    const protocolErrors: string[] = [];
    const outputs: bigint[] = [];
    const { holder, client } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onOutput: (output) => outputs.push(output.sequence)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: false });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(holder.sockPath, { ownsLease: false, viewers: true, leaseEpoch: 0 })
    );
    await attached;

    holder.send(MoorKind.OUTPUT, joined(integer(2n, 8), integer(0n, 8), text('skipped')));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(protocolErrors).not.toHaveLength(0);
    expect(outputs).toEqual([]);
  });

  it('enforces the ACK retained byte start after the frozen GAP', async () => {
    const protocolErrors: string[] = [];
    const outputs: bigint[] = [];
    const { holder, client } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onOutput: (output) => outputs.push(output.offset)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: false });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(holder.sockPath, {
        ownsLease: false,
        leaseEpoch: 0,
        replay: { first: 3n, last: 3n, start: 100n, end: 101n, complete: false }
      })
    );
    await attached;
    holder.send(MoorKind.GAP, joined(integer(1n, 8), integer(2n, 8)));
    holder.send(MoorKind.OUTPUT, joined(integer(3n, 8), integer(999n, 8), text('x')));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    expect(outputs).toEqual([]);
  });

  it('enforces the ACK retained byte end on the final replay record', async () => {
    const protocolErrors: string[] = [];
    const outputs: bigint[] = [];
    const { holder, client } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onOutput: (output) => outputs.push(output.sequence)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: false });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(holder.sockPath, {
        ownsLease: false,
        leaseEpoch: 0,
        replay: { first: 1n, last: 1n, start: 0n, end: 1n, complete: true }
      })
    );
    await attached;
    holder.send(MoorKind.OUTPUT, joined(integer(1n, 8), integer(0n, 8), text('xx')));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    expect(outputs).toEqual([]);
  });

  it('does not emit OUTPUT_ACK above the highest record delivered', async () => {
    const { holder, client } = await start();
    const attached = client.attach({ columns: 80, rows: 24, requestLease: false });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(holder.sockPath, { ownsLease: false, viewers: true, leaseEpoch: 0 })
    );
    await attached;

    expect(() => client.ackOutput(1n)).toThrow(/sequence|output|ack/i);
  });

  it('refuses a successful receipt that did not write the complete input', async () => {
    const protocolErrors: string[] = [];
    const receipts: bigint[] = [];
    const { holder, client } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code),
      onInputReceipt: (receipt) => receipts.push(receipt.written)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(0, 0));
    await attached;
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.sendInput(text('complete'));
    await holder.next();
    holder.send(MoorKind.INPUT_RECEIPT, inputReceiptPayload(1n, GENERATION, INCARNATION, 0n));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
    expect(receipts).toEqual([]);
  });

  it('drops a locally held lease when STATUS_REPLY reports ownership loss', async () => {
    const { holder, client } = await start();
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(0, 0));
    await attached;
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.requestStatus();
    await holder.next();
    holder.send(
      MoorKind.STATUS_REPLY,
      statusPayload(holder.sockPath, { ownsLease: false, viewers: true, leaseEpoch: 5 })
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(() => client.sendInput(text('stale'))).toThrow(/lease/i);
  });

  it('closes this connection when an emitted keepalive receives LEASE_NOT_HELD', async () => {
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const { holder, client } = await start({ onClose: markClosed });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(0, 0));
    await attached;

    const keepalive = await holder.next();
    expect(keepalive.kind).toBe(MoorKind.LEASE_KEEPALIVE);
    holder.send(
      MoorKind.ERROR,
      joined(integer(15, 2), joined(integer(14, 2), text('lease not held')))
    );

    expect(await settle(closed)).toBe('resolved');
    expect(() => client.requestStatus()).toThrow(/not attached|not connected|closed/i);
  });

  it('refuses a reconnect cursor above the current incarnation high-water', async () => {
    const protocolErrors: string[] = [];
    const { holder, client } = await start(
      { onProtocolError: (error) => protocolErrors.push(error.code) },
      { resumeCursor: { sequence: 5n, incarnation: INCARNATION } }
    );
    const attached = client.attach({ columns: 80, rows: 24, requestLease: false });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(
      MoorKind.ATTACH_ACK,
      statusPayload(holder.sockPath, { ownsLease: false, leaseEpoch: 0 })
    );

    expect(await settle(attached)).toBe('rejected');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
  });

  it('invalidates a local lease when STATUS_REPLY reports a different owned epoch', async () => {
    const { holder, client } = await start();
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(0, 0));
    await attached;
    client.requestStatus();
    await holder.next();
    holder.send(
      MoorKind.STATUS_REPLY,
      statusPayload(holder.sockPath, { ownsLease: true, viewers: true, leaseEpoch: 6 })
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(() => client.sendInput(text('stale epoch'))).toThrow(/lease|sequence|attached/i);
  });

  it('does not poison the request slot when INPUT encoding rejects locally', async () => {
    const { holder, client } = await start();
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(0, 0));
    await attached;

    expect(() => client.sendInput(new Uint8Array((16 << 20) + 1))).toThrow(
      /OVERSIZED_MESSAGE|payload/i
    );
    expect(() => client.sendInput(text('x'))).not.toThrow();
    const input = await holder.next();
    expect(input.kind).toBe(MoorKind.INPUT);
    expect(new DataView(input.payload.buffer, input.payload.byteOffset).getBigUint64(4, true)).toBe(1n);
  });

  it('rejects a pending attach when the holder closes cleanly', async () => {
    const { holder, client } = await start();
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.peer!.end();
    expect(await settle(attached)).toBe('rejected');
  });

  it('enforces the two-second identity/adoption deadline against a silent holder', async () => {
    const { client } = await start();
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    expect(await settle(attached, 2_250)).toBe('rejected');
  });

  it('refuses ATTACH_ACK when the required terminal-state frame is missing', async () => {
    const protocolErrors: string[] = [];
    const { holder, client } = await start({
      onProtocolError: (error) => protocolErrors.push(error.code)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath));
    expect(await settle(attached)).toBe('rejected');
    expect(protocolErrors).not.toHaveLength(0);
  });

  it('makes writes fail after an attached holder closes cleanly', async () => {
    let closed = false;
    const protocolErrors: string[] = [];
    const { holder, client } = await start({
      onClose: () => (closed = true),
      onProtocolError: (error) => protocolErrors.push(error.code)
    });
    const attached = client.attach({ columns: 80, rows: 24, requestLease: true });
    await holder.next();
    holder.send(MoorKind.HELLO_ACK, helloAckPayload(holder.sockPath));
    await holder.next();
    holder.send(MoorKind.TERMINAL_STATE, integer(0, 2));
    holder.send(MoorKind.ATTACH_ACK, statusPayload(holder.sockPath));
    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(0, 0));
    await attached.catch((error: Error) => {
      throw new Error(`attach failed with protocol errors ${protocolErrors.join(',')}`, {
        cause: error
      });
    });
    holder.peer!.end();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('close callback timed out')), 1_000);
      const poll = () => {
        if (closed) {
          clearTimeout(timeout);
          resolve();
        } else setTimeout(poll, 5);
      };
      poll();
    });
    expect(() => client.sendInput(text('x'))).toThrow(/not attached|not connected|closed/i);
  });

  it('rejects a released result for a different lease epoch', async () => {
    const protocolErrors: string[] = [];
    const { holder, client } = await attachWithLease({
      onProtocolError: (error) => protocolErrors.push(error.code)
    });

    const released = client.releaseLease();
    const request = await holder.next();
    expect(request.kind).toBe(MoorKind.LEASE_RELEASE);
    expect(new DataView(request.payload.buffer, request.payload.byteOffset).getUint32(0, true)).toBe(5);

    holder.send(MoorKind.LEASE_RESULT, leaseResultPayload(2, 0, 6));
    expect(await settle(released)).toBe('rejected');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
  });

  it('rejects a log-clear result that does not echo the submitted observed index', async () => {
    const protocolErrors: string[] = [];
    const { holder, client } = await attachWithLease({
      onProtocolError: (error) => protocolErrors.push(error.code)
    });

    const cleared = client.clearLog();
    const request = await holder.next();
    expect(request.kind).toBe(MoorKind.LOG_CLEAR);
    const observed = new DataView(
      request.payload.buffer,
      request.payload.byteOffset,
      request.payload.byteLength
    ).getBigUint64(16, true);

    holder.send(
      MoorKind.LOG_CLEAR_RESULT,
      joined(
        Uint8Array.of(1, 0, 0, 0),
        integer(0, 4),
        integer(observed + 1n, 8),
        integer(0n, 8),
        integer(0n, 8)
      )
    );
    expect(await settle(cleared)).toBe('rejected');
    expect(protocolErrors).toEqual(['BAD_SEQUENCE']);
  });
});
