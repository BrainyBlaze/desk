/**
 * A momentarily unreadable store is not a dead session.
 *
 * The observer's poll treated EVERY failure as terminal, with no second
 * attempt: one unlucky read reported a diagnostic, stopped the observer, and
 * fired onTerminal — which the daemon answers by retiring that exact
 * generation, and a retire over a live link sends the holder a graceful
 * TERMINATE. So a single failed `open`/`readdir` on the store was enough to
 * SIGTERM a healthy agent mid-work.
 *
 * The two failure classes are not the same thing and must not share a fate:
 *
 * - A STRUCTURAL error is a completed decision about committed content — a
 *   compaction gap, a rolled-back epoch or index, a generation/identity
 *   mismatch. Reading again can only re-derive the same answer, so these stay
 *   terminal on the FIRST observation, exactly as before.
 * - A TRANSIENT read failure says nothing about content: the directory was
 *   briefly unreachable, a syscall was interrupted, the holder was mid-commit.
 *   These get a bounded number of consecutive attempts before the observer
 *   gives up, and any successful read clears the count.
 *
 * The bound is what keeps this honest: a store that is genuinely gone still
 * terminates the observer, just not on the first stumble.
 */
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
  // Permissions are restored before removal: a test that leaves a store
  // unreadable would otherwise defeat its own cleanup.
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    })
  );
});

function sessionIdentity(): Uint8Array {
  return Uint8Array.of(1, 0x2f, ...encoder.encode('tmp/session'));
}

function header(generation: number, epoch: number, first: bigint, next: bigint): string {
  return `{"v":2,"type":"header","ts":1,"session":"${Buffer.from(sessionIdentity()).toString('base64')}","generation":${generation},"epoch":${epoch},"next_seq":${next},"first_retained":${first}}\n`;
}

function event(type: string, epoch: number, sequence: bigint, tail = ''): string {
  return `{"type":"${type}","ts":1,"epoch":${epoch},"seq":${sequence},"kind":"transition"${tail}}\n`;
}

function eventBody(records: string[], first = 1n): Uint8Array {
  return encoder.encode(header(7, 1, first, first + BigInt(records.length)) + records.join(''));
}

function commitRecord(options: {
  slot: 0 | 1;
  bytes: Uint8Array;
  index: bigint;
  start: bigint;
  end: bigint;
}): Uint8Array {
  const record = new Uint8Array(92);
  const view = new DataView(record.buffer);
  record.set(encoder.encode('MOORCMT1'), 0);
  record[8] = 1;
  record[9] = options.slot;
  record[10] = options.slot;
  record[11] = MoorStoreKind.Event;
  view.setUint32(12, 7, true);
  view.setUint32(16, 1, true);
  view.setBigUint64(24, options.index, true);
  view.setBigUint64(32, BigInt(options.bytes.length), true);
  view.setBigUint64(40, options.start, true);
  view.setBigUint64(48, options.end, true);
  record.set(createHash('sha256').update(options.bytes).digest(), 56);
  view.setUint32(88, crc32c(record.subarray(0, 88)), true);
  return record;
}

async function makeStore(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desk-moor-transient-'));
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

async function writeSlot(
  root: string,
  slot: 0 | 1,
  body: Uint8Array,
  commit: Uint8Array
): Promise<void> {
  await writeFile(join(root, `body.${slot}`), body, { mode: 0o600 });
  await writeFile(join(root, `commit.${slot}`), commit, { mode: 0o600 });
}

function collector() {
  const seen: MoorSessionEvent[] = [];
  const diagnostics: string[] = [];
  let terminal = 0;
  return {
    seen,
    diagnostics,
    terminalCount: () => terminal,
    handlers: {
      onEvent: (value: MoorSessionEvent) => seen.push(value),
      onDiagnostic: (diagnostic: string) => diagnostics.push(diagnostic),
      onTerminal: () => {
        terminal += 1;
      }
    }
  };
}

function waitFor(predicate: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > 3_000) return reject(new Error(`timed out: ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** A store holding `ready` at sequence 1, already committed. */
async function readyStore(): Promise<string> {
  const root = await makeStore();
  const body = eventBody([event('ready', 1, 1n)]);
  await writeSlot(root, 0, body, commitRecord({ slot: 0, bytes: body, index: 1n, start: 1n, end: 2n }));
  return root;
}

describe('a transient store read failure must not kill a live session', () => {
  it('keeps observing after the store becomes readable again', async () => {
    const root = await readyStore();
    const { seen, diagnostics, terminalCount, handlers } = collector();
    const observer = new MoorEventObserver({
      directory: root,
      generation: 7,
      pollIntervalMs: 20,
      maxConsecutiveReadFailures: 5,
      ...handlers
    });
    observers.push(observer);
    expect(await observer.start()).toBe(true);
    expect(seen.map((value) => value.type)).toEqual(['ready']);

    // The store goes unreachable for a moment — exactly what an interrupted
    // syscall or a directory in flux looks like from here — and does so TWICE,
    // three failures each time. Six failures against a budget of five: the
    // session survives only if a successful read in between genuinely clears
    // the count, rather than the observer merely tolerating six in total.
    for (const outage of [1, 2]) {
      const before = diagnostics.length;
      await chmod(root, 0o000);
      await waitFor(() => diagnostics.length >= before + 3, `three failed polls (outage ${outage})`);
      await chmod(root, 0o700);
      // Prove the recovery is real before the next outage begins: one clean
      // poll must land, or the two outages were never actually separated.
      const recovered = diagnostics.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(diagnostics.length).toBe(recovered);
    }

    // It is readable again, and the holder commits another event. A live
    // observer MUST deliver it; a terminated one never will.
    const body = eventBody([
      event('ready', 1, 1n),
      event('link', 1, 2n, ',"uri":"https://example.test/x","truncated":false')
    ]);
    await writeSlot(root, 1, body, commitRecord({ slot: 1, bytes: body, index: 2n, start: 1n, end: 3n }));

    await waitFor(() => seen.length === 2, 'live event after the store recovered');
    expect(seen[1]).toMatchObject({ type: 'link', uri: 'https://example.test/x' });
    // And the session was never declared dead over a stumble it recovered from.
    expect(terminalCount()).toBe(0);
  });

  it('still gives up — bounded — when the store never becomes readable', async () => {
    const root = await readyStore();
    const { diagnostics, terminalCount, handlers } = collector();
    const observer = new MoorEventObserver({
      directory: root,
      generation: 7,
      pollIntervalMs: 20,
      maxConsecutiveReadFailures: 3,
      ...handlers
    });
    observers.push(observer);
    expect(await observer.start()).toBe(true);

    await chmod(root, 0o000);
    await waitFor(() => terminalCount() === 1, 'terminal after the bounded attempts');
    // Exactly the configured budget of attempts, each one reported: a retry
    // that hides its failures would make an unreadable store look healthy.
    expect(diagnostics.length).toBe(3);

    // Bounded means bounded: nothing keeps polling after it gave up.
    const settled = diagnostics.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(diagnostics.length).toBe(settled);
    expect(terminalCount()).toBe(1);
  });

  it('defaults to five consecutive attempts before giving up', async () => {
    const root = await readyStore();
    const { diagnostics, terminalCount, handlers } = collector();
    const observer = new MoorEventObserver({
      directory: root,
      generation: 7,
      pollIntervalMs: 10,
      ...handlers
    });
    observers.push(observer);
    expect(await observer.start()).toBe(true);

    await chmod(root, 0o000);
    await waitFor(() => terminalCount() === 1, 'terminal at the default budget');
    expect(diagnostics.length).toBe(5);
  });

  it('treats a compaction gap as terminal on the FIRST read, with no retry', async () => {
    const root = await readyStore();
    const { diagnostics, terminalCount, handlers } = collector();
    const observer = new MoorEventObserver({
      directory: root,
      generation: 7,
      pollIntervalMs: 20,
      maxConsecutiveReadFailures: 3,
      ...handlers
    });
    observers.push(observer);
    expect(await observer.start()).toBe(true);

    // The holder compacted away events this observer had not read yet. That
    // is a fact about committed content, not a stumble — reading again can
    // only re-derive it, so the retry budget must not apply.
    const body = eventBody([event('state', 1, 9n, ',"state":"idle","title":"x","truncated":false')], 9n);
    await writeSlot(root, 1, body, commitRecord({ slot: 1, bytes: body, index: 2n, start: 9n, end: 10n }));

    await waitFor(() => terminalCount() === 1, 'terminal on the compaction gap');
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]).toMatch(/COMPACTION_GAP/);
  });
});
