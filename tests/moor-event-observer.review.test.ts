import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MoorEventObserver } from '../src/server/runtime/moorEventObserver.js';
import { MoorStoreKind } from '../src/server/runtime/moorStore.js';
import { crc32c } from '../src/shared/moorWire/crc32c.js';

const encoder = new TextEncoder();
const roots: string[] = [];
const observers: MoorEventObserver[] = [];

afterEach(async () => {
  while (observers.length > 0) observers.pop()!.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function eventBody(): Uint8Array {
  const identity = Buffer.from(Uint8Array.of(1, 0x2f, ...encoder.encode('tmp/session'))).toString(
    'base64'
  );
  return encoder.encode(
    `{"v":2,"type":"header","ts":1,"session":"${identity}","generation":7,"epoch":1,"next_seq":3,"first_retained":1}\n` +
      '{"type":"ready","ts":1,"epoch":1,"seq":1,"kind":"transition"}\n' +
      '{"type":"link","ts":1,"epoch":1,"seq":2,"kind":"transition","uri":"https://example.test/","truncated":false}\n'
  );
}

function commit(bytes: Uint8Array): Uint8Array {
  const record = new Uint8Array(92);
  const view = new DataView(record.buffer);
  record.set(encoder.encode('MOORCMT1'), 0);
  record[8] = 1;
  record[9] = 0;
  record[10] = 0;
  record[11] = MoorStoreKind.Event;
  view.setUint32(12, 7, true);
  view.setUint32(16, 1, true);
  view.setBigUint64(24, 1n, true);
  view.setBigUint64(32, BigInt(bytes.length), true);
  view.setBigUint64(40, 1n, true);
  view.setBigUint64(48, 3n, true);
  record.set(createHash('sha256').update(bytes).digest(), 56);
  view.setUint32(88, crc32c(record.subarray(0, 88)), true);
  return record;
}

async function store(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desk-moor-observer-review-'));
  roots.push(root);
  await chmod(root, 0o700);
  const bytes = eventBody();
  await Promise.all([
    writeFile(join(root, 'body.0'), bytes, { mode: 0o600 }),
    writeFile(join(root, 'body.1'), new Uint8Array(), { mode: 0o600 }),
    writeFile(join(root, 'commit.0'), commit(bytes), { mode: 0o600 }),
    writeFile(join(root, 'commit.1'), new Uint8Array(), { mode: 0o600 })
  ]);
  return root;
}

describe('MoorEventObserver adversarial lifecycle review', () => {
  it('rejects a nonpositive polling interval instead of creating a hot loop', () => {
    expect(
      () =>
        new MoorEventObserver({
          directory: '/unused',
          generation: 7,
          pollIntervalMs: 0,
          onEvent: () => undefined,
          onDiagnostic: () => undefined
        })
    ).toThrow(/poll.*positive|interval/i);
  });

  it('is idempotent when start is called more than once', async () => {
    const directory = await store();
    const events: string[] = [];
    const observer = new MoorEventObserver({
      directory,
      generation: 7,
      onEvent: (event) => events.push(event.type),
      onDiagnostic: () => undefined
    });
    observers.push(observer);

    expect(await observer.start()).toBe(true);
    expect(await observer.start()).toBe(true);
    expect(events).toEqual(['ready', 'link']);
  });

  it('isolates a consumer failure and continues delivering committed events', async () => {
    const directory = await store();
    const events: string[] = [];
    const diagnostics: string[] = [];
    const observer = new MoorEventObserver({
      directory,
      generation: 7,
      onEvent: (event) => {
        if (event.type === 'ready') throw new Error('consumer failed');
        events.push(event.type);
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    observers.push(observer);

    expect(await observer.start()).toBe(true);
    expect(events).toEqual(['link']);
    expect(diagnostics.some((diagnostic) => diagnostic.includes('consumer failed'))).toBe(true);
  });

  it('does not keep the process alive solely for its polling timer', async () => {
    const directory = await store();
    const observer = new MoorEventObserver({
      directory,
      generation: 7,
      onEvent: () => undefined,
      onDiagnostic: () => undefined
    });
    observers.push(observer);

    expect(await observer.start()).toBe(true);
    const timer = (observer as unknown as { timer?: NodeJS.Timeout }).timer;
    expect(timer?.hasRef()).toBe(false);
  });
});
