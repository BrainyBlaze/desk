// #3 integration seam: the moor committed-store event observer that replaces
// the NDJSON MoorSessionEventTailer. Replay phase = initial snapshot read (retained
// records, snapshots first); live phase = poll re-selection + cursor advance.
// Gap/corruption is terminal: diagnostic + stop, never a silent reset.
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { crc32c } from '../src/shared/moorWire/crc32c.js';
import { MoorStoreKind } from '../src/server/runtime/moorStore.js';
import {
  MoorEventObserver,
  type MoorSessionEvent
} from '../src/server/runtime/moorEventObserver.js';

const roots: string[] = [];
const encoder = new TextEncoder();
const observers: MoorEventObserver[] = [];

afterEach(async () => {
  while (observers.length > 0) observers.pop()!.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sessionIdentity(): Uint8Array {
  return Uint8Array.of(1, 0x2f, ...encoder.encode('tmp/session'));
}

function header(generation: number, epoch: number, first: bigint, next: bigint): string {
  return `{"v":2,"type":"header","ts":1,"session":"${Buffer.from(sessionIdentity()).toString('base64')}","generation":${generation},"epoch":${epoch},"next_seq":${next},"first_retained":${first}}\n`;
}

function event(
  type: string,
  epoch: number,
  sequence: bigint,
  kind: 'transition' | 'snapshot' = 'transition',
  tail = ''
): string {
  return `{"type":"${type}","ts":1,"epoch":${epoch},"seq":${sequence},"kind":"${kind}"${tail}}\n`;
}

function eventBody(records: string[], options: { generation?: number; epoch?: number; first?: bigint } = {}): Uint8Array {
  const generation = options.generation ?? 7;
  const epoch = options.epoch ?? 1;
  const first = options.first ?? 1n;
  return encoder.encode(
    header(generation, epoch, first, first + BigInt(records.length)) + records.join('')
  );
}

function commitRecord(options: {
  slot: 0 | 1;
  bytes: Uint8Array;
  index?: bigint;
  start?: bigint;
  end?: bigint;
  epoch?: number;
  generation?: number;
}): Uint8Array {
  const record = new Uint8Array(92);
  const view = new DataView(record.buffer);
  record.set(encoder.encode('MOORCMT1'), 0);
  record[8] = 1;
  record[9] = options.slot;
  record[10] = options.slot;
  record[11] = MoorStoreKind.Event;
  view.setUint32(12, options.generation ?? 7, true);
  view.setUint32(16, options.epoch ?? 1, true);
  view.setBigUint64(24, options.index ?? 1n, true);
  view.setBigUint64(32, BigInt(options.bytes.length), true);
  view.setBigUint64(40, options.start ?? 1n, true);
  view.setBigUint64(48, options.end ?? 2n, true);
  record.set(createHash('sha256').update(options.bytes).digest(), 56);
  view.setUint32(88, crc32c(record.subarray(0, 88)), true);
  return record;
}

async function makeStore(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desk-moor-observer-'));
  roots.push(root);
  await chmod(root, 0o700);
  const empty = new Uint8Array();
  await Promise.all(
    ['body.0', 'body.1', 'commit.0', 'commit.1'].map((name) =>
      writeFile(join(root, name), empty, { mode: 0o600 })
    )
  );
  return root;
}

async function writeSlot(root: string, slot: 0 | 1, body: Uint8Array, commit: Uint8Array): Promise<void> {
  await writeFile(join(root, `body.${slot}`), body, { mode: 0o600 });
  await writeFile(join(root, `commit.${slot}`), commit, { mode: 0o600 });
}

interface Seen {
  event: MoorSessionEvent;
  phase: 'replay' | 'live';
}

function collector() {
  const seen: Seen[] = [];
  const diagnostics: string[] = [];
  return {
    seen,
    diagnostics,
    handlers: {
      onEvent: (event: MoorSessionEvent, context: { phase: 'replay' | 'live' }) =>
        seen.push({ event, phase: context.phase }),
      onDiagnostic: (diagnostic: string) => diagnostics.push(diagnostic)
    }
  };
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

async function startObserver(
  directory: string,
  handlers: ReturnType<typeof collector>['handlers']
): Promise<MoorEventObserver> {
  const observer = new MoorEventObserver({
    directory,
    generation: 7,
    pollIntervalMs: 20,
    ...handlers
  });
  observers.push(observer);
  expect(await observer.start()).toBe(true);
  return observer;
}

describe('MoorEventObserver', () => {
  it('replays retained records on start, then delivers only unseen records live', async () => {
    const root = await makeStore();
    const initial = eventBody([
      event('ready', 1, 1n),
      event('state', 1, 2n, 'transition', ',"state":"busy","title":"vim","truncated":false')
    ]);
    await writeSlot(root, 0, initial, commitRecord({ slot: 0, bytes: initial, index: 1n, start: 1n, end: 3n }));

    const { seen, handlers } = collector();
    await startObserver(root, handlers);
    expect(seen.map((entry) => [entry.event.type, entry.phase])).toEqual([
      ['ready', 'replay'],
      ['state', 'replay']
    ]);
    expect(seen[1]!.event).toMatchObject({ type: 'state', state: 'busy', title: 'vim' });

    const appended = eventBody([
      event('ready', 1, 1n),
      event('state', 1, 2n, 'transition', ',"state":"busy","title":"vim","truncated":false'),
      event('link', 1, 3n, 'transition', ',"uri":"https://example.test/x","truncated":false')
    ]);
    await writeSlot(root, 1, appended, commitRecord({ slot: 1, bytes: appended, index: 2n, start: 1n, end: 4n }));

    await waitFor(() => seen.length === 3, 'live link event');
    expect(seen[2]).toMatchObject({
      phase: 'live',
      event: { type: 'link', uri: 'https://example.test/x' }
    });
  });

  it('maps exit endings onto Desk exit codes (exited passthrough, signalled 128+signal)', async () => {
    const root = await makeStore();
    const body = eventBody([
      event('ready', 1, 1n),
      event('exit', 1, 2n, 'transition', ',"ended":"signalled","signal":15')
    ]);
    await writeSlot(root, 0, body, commitRecord({ slot: 0, bytes: body, index: 1n, start: 1n, end: 3n }));

    const { seen, handlers } = collector();
    await startObserver(root, handlers);
    expect(seen[1]!.event).toMatchObject({ type: 'exit', code: 143 });
  });

  it('fails closed on commit-index rollback: diagnostic, polling stops, no silent reset', async () => {
    const root = await makeStore();
    const first = eventBody([event('ready', 1, 1n)]);
    await writeSlot(root, 0, first, commitRecord({ slot: 0, bytes: first, index: 5n, start: 1n, end: 2n }));

    const { seen, diagnostics, handlers } = collector();
    await startObserver(root, handlers);
    expect(seen).toHaveLength(1);

    // Rollback: a fresh store state whose highest commit index is LOWER.
    const rollback = eventBody([event('ready', 1, 1n)]);
    await writeSlot(root, 1, rollback, commitRecord({ slot: 1, bytes: rollback, index: 2n, start: 1n, end: 2n }));
    await writeSlot(root, 0, rollback, commitRecord({ slot: 0, bytes: rollback, index: 1n, start: 1n, end: 2n }));

    await waitFor(() => diagnostics.length >= 1, 'rollback diagnostic');

    // Later valid progress must NOT be consumed: the observer is terminal.
    const later = eventBody([event('ready', 1, 1n), event('link', 1, 2n, 'transition', ',"uri":"https://x.test/","truncated":false')]);
    await writeSlot(root, 1, later, commitRecord({ slot: 1, bytes: later, index: 9n, start: 1n, end: 3n }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(seen).toHaveLength(1);
  });

  it('rejects a non-positive poll interval before any I/O', () => {
    for (const pollIntervalMs of [0, -5, 1.5]) {
      expect(
        () =>
          new MoorEventObserver({
            directory: '/tmp/never',
            generation: 7,
            pollIntervalMs,
            onEvent: () => undefined,
            onDiagnostic: () => undefined
          })
      ).toThrowError(/poll interval/);
    }
  });

  it('returns false from start() when the store cannot be read', async () => {
    const { diagnostics, handlers } = collector();
    const observer = new MoorEventObserver({
      directory: join(tmpdir(), 'desk-moor-observer-missing', 'nope'),
      generation: 7,
      pollIntervalMs: 20,
      ...handlers
    });
    observers.push(observer);
    expect(await observer.start()).toBe(false);
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
