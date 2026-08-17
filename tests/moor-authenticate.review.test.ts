import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MoorMasterClient, posixMoorIdentity } from '../src/server/runtime/moorMasterClient.js';
import { MoorCodec, type MoorMessage } from '../src/shared/moorWire/codec.js';
import { MoorKind } from '../src/shared/moorWire/messages.js';

const GENERATION = 7;
const INCARNATION = new Uint8Array(16).fill(0xa1);

function joined(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function integer(value: number, bytes: 4): Uint8Array {
  const out = new Uint8Array(bytes);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function wide(bytes: Uint8Array): Uint8Array {
  return joined(integer(bytes.length, 4), bytes);
}

class ProbeHolder {
  readonly root = mkdtempSync(join(tmpdir(), 'moor-auth-review-'));
  readonly sockPath = join(this.root, 'session');
  private readonly codec = new MoorCodec();
  private readonly inbox: MoorMessage[] = [];
  private readonly waiters: Array<(message: MoorMessage) => void> = [];
  private server: Server | undefined;
  private connection: Socket | undefined;
  received = 0;

  async listen(): Promise<void> {
    this.server = createServer((socket) => {
      this.connection = socket;
      socket.on('data', (chunk: Buffer) => {
        const messages = this.codec.feed(
          Date.now(),
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        );
        for (const message of messages) {
          this.received += 1;
          const waiter = this.waiters.shift();
          if (waiter === undefined) this.inbox.push(message);
          else waiter(message);
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.sockPath, resolve));
  }

  next(): Promise<MoorMessage> {
    const message = this.inbox.shift();
    return message === undefined
      ? new Promise((resolve) => this.waiters.push(resolve))
      : Promise.resolve(message);
  }

  sendHelloAck(identity: Uint8Array): void {
    this.connection!.write(
      this.codec.encode(
        GENERATION,
        MoorKind.HELLO_ACK,
        joined(Uint8Array.of(4), integer(GENERATION, 4), INCARNATION, wide(identity))
      )
    );
  }

  close(): void {
    this.connection?.destroy();
    this.server?.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}

describe('MoorMasterClient authenticated liveness probe review', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
  });

  it('completes HELLO authentication without registering an ATTACH viewer', async () => {
    const holder = new ProbeHolder();
    await holder.listen();
    const identity = posixMoorIdentity(holder.sockPath);
    const client = new MoorMasterClient(holder.sockPath, GENERATION, {}, { attachDeadlineMs: 200 });
    cleanups.push(() => {
      client.close();
      holder.close();
    });
    await client.connect();

    const authenticated = client.authenticate();
    const hello = await holder.next();
    expect(hello.kind).toBe(MoorKind.HELLO);
    expect(hello.scope).toBe(GENERATION);

    holder.sendHelloAck(identity);
    await expect(authenticated).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(holder.received).toBe(1);
  });
});
