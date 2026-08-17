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
 *   declares itself unavailable, and any successful read clears the state.
 *
 * The threshold is what keeps this honest: persistent loss is reported as an
 * explicit observer outage, while low-level polling continues so observation
 * can recover without retiring or relaunching the live holder.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crc32c } from '../src/shared/moorWire/crc32c.js';
import { MoorStoreKind } from '../src/server/runtime/moorStore.js';
import {
  MoorEventObserver,
  type MoorEventObserverAvailability,
  type MoorSessionEvent
} from '../src/server/runtime/moorEventObserver.js';

const roots: string[] = [];
const encoder = new TextEncoder();
const observers: MoorEventObserver[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
  const availability: MoorEventObserverAvailability[] = [];
  let terminal = 0;
  return {
    seen,
    diagnostics,
    availability,
    terminalCount: () => terminal,
    handlers: {
      onEvent: (value: MoorSessionEvent) => seen.push(value),
      onDiagnostic: (diagnostic: string) => diagnostics.push(diagnostic),
      onAvailabilityChange: (value: MoorEventObserverAvailability) => availability.push(value),
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
    const records = [event('ready', 1, 1n)];

    // The store goes unreachable for a moment — exactly what an interrupted
    // syscall or a directory in flux looks like from here — and does so TWICE,
    // three failures each time. Six failures against a threshold of five: the
    // session survives only if a successful read in between genuinely clears
    // the count, rather than the observer merely tolerating six in total.
    for (const outage of [1, 2]) {
      const before = diagnostics.length;
      await chmod(root, 0o000);
      await waitFor(() => diagnostics.length >= before + 3, `three failed polls (outage ${outage})`);
      await chmod(root, 0o700);
      // Event delivery is the causal witness that a successful store read
      // landed and reset the consecutive-failure count before another outage.
      records.push(
        event(
          'link',
          1,
          BigInt(records.length + 1),
          `,"uri":"https://example.test/recovery-${outage}","truncated":false`
        )
      );
      const recoveredBody = eventBody(records);
      const recoveredSlot = (outage % 2) as 0 | 1;
      await writeSlot(
        root,
        recoveredSlot,
        recoveredBody,
        commitRecord({
          slot: recoveredSlot,
          bytes: recoveredBody,
          index: BigInt(outage + 1),
          start: 1n,
          end: BigInt(records.length + 1)
        })
      );
      await waitFor(
        () => seen.length === records.length,
        `successful recovery read (outage ${outage})`
      );
    }

    // It is readable again, and the holder commits another event. A live
    // observer MUST deliver it; a terminated one never will.
    records.push(
      event(
        'link',
        1,
        BigInt(records.length + 1),
        ',"uri":"https://example.test/x","truncated":false'
      )
    );
    const body = eventBody(records);
    await writeSlot(root, 1, body, commitRecord({ slot: 1, bytes: body, index: 4n, start: 1n, end: 5n }));

    await waitFor(() => seen.length === 4, 'live event after the store recovered');
    expect(seen[3]).toMatchObject({ type: 'link', uri: 'https://example.test/x' });
    // And the session was never declared dead over a stumble it recovered from.
    expect(terminalCount()).toBe(0);
  });

  it('declares persistent unreadability and resumes observation after recovery', async () => {
    const root = await readyStore();
    const { seen, diagnostics, availability, terminalCount, handlers } = collector();
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
    await waitFor(
      () => availability.some((value) => value.status === 'unavailable'),
      'explicit unavailable state after the bounded attempts'
    );
    expect(availability[0]).toMatchObject({
      status: 'unavailable',
      consecutiveReadFailures: 3
    });
    expect(diagnostics).toHaveLength(3);
    expect(terminalCount()).toBe(0);

    await chmod(root, 0o700);
    const body = eventBody([
      event('ready', 1, 1n),
      event('link', 1, 2n, ',\"uri\":\"https://example.test/recovered\",\"truncated\":false')
    ]);
    await writeSlot(root, 1, body, commitRecord({ slot: 1, bytes: body, index: 2n, start: 1n, end: 3n }));

    await waitFor(() => seen.length === 2, 'live event after persistent outage recovery');
    expect(seen[1]).toMatchObject({ type: 'link', uri: 'https://example.test/recovered' });
    expect(availability[1]).toEqual({ status: 'available' });
    expect(terminalCount()).toBe(0);
  });

  it('defaults to five consecutive failures before declaring unavailability', async () => {
    const root = await readyStore();
    const { diagnostics, availability, terminalCount, handlers } = collector();
    const observer = new MoorEventObserver({
      directory: root,
      generation: 7,
      pollIntervalMs: 10,
      ...handlers
    });
    observers.push(observer);
    expect(await observer.start()).toBe(true);

    await chmod(root, 0o000);
    await waitFor(
      () => availability.some((value) => value.status === 'unavailable'),
      'unavailable at the default threshold'
    );
    expect(availability[0]).toMatchObject({
      status: 'unavailable',
      consecutiveReadFailures: 5
    });
    expect(diagnostics).toHaveLength(5);
    expect(terminalCount()).toBe(0);
  });

  it('recovers when a rotation exposes a partial commit and no valid candidate', async () => {
    const root = await readyStore();
    const { seen, diagnostics, terminalCount, handlers } = collector();
    const observer = new MoorEventObserver({
      directory: root,
      generation: 7,
      // Keep the timer out of the mutation window; this test invokes the poll
      // directly so the filesystem state at the read is deterministic.
      pollIntervalMs: 10_000,
      maxConsecutiveReadFailures: 5,
      ...handlers
    });
    observers.push(observer);
    expect(await observer.start()).toBe(true);

    const rotatedBody = eventBody([
      event('ready', 1, 1n),
      event('link', 1, 2n, ',\"uri\":\"https://example.test/rotation\",\"truncated\":false')
    ]);
    const rotatedCommit = commitRecord({
      slot: 1,
      bytes: rotatedBody,
      index: 2n,
      start: 1n,
      end: 3n
    });
    const invalidatedOldBody = eventBody([event('ready', 1, 1n)]);
    invalidatedOldBody[0] = invalidatedOldBody[0]! ^ 0x01;

    // A fast replace can invalidate the body referenced by the old commit while
    // the replacement commit file is only partly written. There is briefly no
    // valid candidate, but the in-progress commit is direct evidence that this
    // is a transient read window rather than a completed corruption decision.
    await writeFile(join(root, 'body.1'), rotatedBody, { mode: 0o600 });
    await writeFile(join(root, 'body.0'), invalidatedOldBody, { mode: 0o600 });
    await writeFile(join(root, 'commit.1'), rotatedCommit.subarray(0, 17), { mode: 0o600 });

    const poll = () =>
      (observer as unknown as { poll: () => Promise<void> }).poll();
    await poll();
    expect(diagnostics[0]).toMatch(/UNAVAILABLE/);
    expect(terminalCount()).toBe(0);

    await writeFile(join(root, 'commit.1'), rotatedCommit, { mode: 0o600 });
    await poll();
    expect(seen.some((value) => value.type === 'link')).toBe(true);
    expect(seen.at(-1)).toMatchObject({ type: 'link', uri: 'https://example.test/rotation' });
    expect(terminalCount()).toBe(0);
  });

  it('treats a stable committed body hash mismatch as terminal corruption', async () => {
    const root = await readyStore();
    const { diagnostics, availability, terminalCount, handlers } = collector();
    const observer = new MoorEventObserver({
      directory: root,
      generation: 7,
      pollIntervalMs: 10_000,
      maxConsecutiveReadFailures: 3,
      ...handlers
    });
    observers.push(observer);
    expect(await observer.start()).toBe(true);

    const corrupted = eventBody([event('ready', 1, 1n)]);
    corrupted[0] = corrupted[0]! ^ 0x01;
    await writeFile(join(root, 'body.0'), corrupted, { mode: 0o600 });

    const poll = () =>
      (observer as unknown as { poll: () => Promise<void> }).poll();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    await poll();

    expect(terminalCount()).toBe(0);
    expect(availability).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/UNAVAILABLE/);

    now.mockReturnValue(5_000);
    await poll();

    expect(terminalCount()).toBe(1);
    expect(availability).toEqual([]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[1]).toMatch(/CORRUPT/);
  });

  it('keeps observing when two identical mismatch samples are followed by a valid commit', async () => {
    const root = await readyStore();
    const { seen, diagnostics, availability, terminalCount, handlers } = collector();
    const observer = new MoorEventObserver({
      directory: root,
      generation: 7,
      pollIntervalMs: 10_000,
      maxConsecutiveReadFailures: 5,
      ...handlers
    });
    observers.push(observer);
    expect(await observer.start()).toBe(true);

    const validBody = eventBody([event('ready', 1, 1n)]);
    const transientBody = validBody.slice();
    transientBody[0] = transientBody[0]! ^ 0x01;
    await writeFile(join(root, 'body.0'), transientBody, { mode: 0o600 });

    const poll = () =>
      (observer as unknown as { poll: () => Promise<void> }).poll();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    await poll();
    now.mockReturnValue(200);
    await poll();

    expect(terminalCount()).toBe(0);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((diagnostic) => diagnostic.includes('UNAVAILABLE'))).toBe(true);

    await writeFile(join(root, 'body.0'), validBody, { mode: 0o600 });
    await poll();

    expect(seen.map((value) => value.type)).toEqual(['ready']);
    expect(terminalCount()).toBe(0);
    expect(availability).toEqual([]);
  });

  it('keeps changing two-slot hash mismatch fingerprints retryable', async () => {
    const root = await readyStore();
    const { seen, diagnostics, availability, terminalCount, handlers } = collector();
    const observer = new MoorEventObserver({
      directory: root,
      generation: 7,
      pollIntervalMs: 10_000,
      maxConsecutiveReadFailures: 5,
      ...handlers
    });
    observers.push(observer);
    expect(await observer.start()).toBe(true);

    const rotatedBody = eventBody([
      event('ready', 1, 1n),
      event('link', 1, 2n, ',\"uri\":\"https://example.test/two-rotation\",\"truncated\":false')
    ]);
    const rotatedCommit = commitRecord({
      slot: 1,
      bytes: rotatedBody,
      index: 2n,
      start: 1n,
      end: 3n
    });
    await writeSlot(root, 1, rotatedBody, rotatedCommit);

    const oldBodyMismatch = eventBody([event('ready', 1, 1n)]);
    oldBodyMismatch[0] = oldBodyMismatch[0]! ^ 0x01;
    const rotatedBodyMismatch = rotatedBody.slice();
    rotatedBodyMismatch[0] = rotatedBodyMismatch[0]! ^ 0x01;
    await Promise.all([
      writeFile(join(root, 'body.0'), oldBodyMismatch, { mode: 0o600 }),
      writeFile(join(root, 'body.1'), rotatedBodyMismatch, { mode: 0o600 })
    ]);

    const poll = () =>
      (observer as unknown as { poll: () => Promise<void> }).poll();
    await poll();
    expect(terminalCount()).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/UNAVAILABLE/);

    rotatedBodyMismatch[1] = rotatedBodyMismatch[1]! ^ 0x01;
    await writeFile(join(root, 'body.1'), rotatedBodyMismatch, { mode: 0o600 });
    await poll();
    expect(terminalCount()).toBe(0);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[1]).toMatch(/UNAVAILABLE/);

    await writeFile(join(root, 'body.1'), rotatedBody, { mode: 0o600 });
    await poll();

    expect(seen.at(-1)).toMatchObject({
      type: 'link',
      uri: 'https://example.test/two-rotation'
    });
    expect(terminalCount()).toBe(0);
    expect(availability).toEqual([]);
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

  it('treats committed structural corruption as terminal on the FIRST read', async () => {
    const root = await readyStore();
    const { diagnostics, availability, terminalCount, handlers } = collector();
    const observer = new MoorEventObserver({
      directory: root,
      generation: 7,
      pollIntervalMs: 20,
      maxConsecutiveReadFailures: 3,
      ...handlers
    });
    observers.push(observer);
    expect(await observer.start()).toBe(true);

    // This commit is readable and self-consistent at the commit-record layer,
    // but its selected body is not a valid event snapshot. With no valid
    // fallback slot, the store has established corruption rather than an I/O
    // outage, so retrying cannot change the answer.
    const body = encoder.encode('{"v":2}\n');
    await writeSlot(
      root,
      0,
      body,
      commitRecord({ slot: 0, bytes: body, index: 2n, start: 1n, end: 1n })
    );

    await waitFor(
      () => terminalCount() === 1 || availability.length > 0,
      'terminal corruption decision'
    );
    expect(terminalCount()).toBe(1);
    expect(availability).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/CORRUPT/);
  });
});
