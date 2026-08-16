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

  it('projects a signalled exit to 128+signal independently of method', async () => {
    for (const method of ['none', 'graceful', 'forced'] as const) {
      const root = await makeStore();
      const body = eventBody([
        event('ready', 1, 1n),
        event(
          'exit',
          1,
          2n,
          'transition',
          `,"ended":"signalled","signal":15,"method":"${method}"`
        )
      ]);
      await writeSlot(
        root,
        0,
        body,
        commitRecord({ slot: 0, bytes: body, index: 1n, start: 1n, end: 3n })
      );

      const { seen, handlers } = collector();
      await startObserver(root, handlers);
      expect(seen[1]!.event).toMatchObject({
        type: 'exit',
        code: 143,
        outcome: { kind: 'signalled', signal: 15, method }
      });
    }
  });

  it('preserves the raw Moor outcome instead of folding it to one number (desk#59)', async () => {
    // The observer used to collapse {ended, signal, code} into a single
    // number before the event ever entered Desk, so a SIGTERM death and a
    // child that exited 143 on its own became indistinguishable -- and the
    // durable record could no longer say which happened. The tagged outcome
    // must survive to the durable model; the legacy number is derived only at
    // the browser compatibility boundary.
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        ',"ended":"signalled","signal":15,"method":"forced"',
        { kind: 'signalled', signal: 15, method: 'forced' }
      ],
      [
        ',"ended":"exited","code":7,"method":"none"',
        { kind: 'exited', code: 7, method: 'none' }
      ]
    ];
    for (const [tail, expected] of cases) {
      const root = await makeStore();
      const body = eventBody([event('exit', 1, 1n, 'transition', tail)]);
      await writeSlot(root, 0, body, commitRecord({ slot: 0, bytes: body, index: 1n, start: 1n, end: 2n }));

      const { seen, handlers } = collector();
      await startObserver(root, handlers);
      expect(seen[0]!.event).toMatchObject({ type: 'exit', outcome: expected });
    }
  });

  it('drains a committed exit that landed after the last poll (desk#59)', async () => {
    // The holder commits its lifecycle BEFORE unlinking, so at teardown the
    // exit is routinely already on disk and unread. Stopping the observer at
    // that moment is what discarded the cause of death.
    const root = await makeStore();
    const first = eventBody([event('ready', 1, 1n)]);
    await writeSlot(root, 0, first, commitRecord({ slot: 0, bytes: first, index: 1n, start: 1n, end: 2n }));

    const { seen, handlers } = collector();
    const observer = await startObserver(root, handlers);
    expect(seen).toHaveLength(1);

    // Written after the observer's last read, exactly like a real death.
    const second = eventBody([event('ready', 1, 1n), event('exit', 1, 2n, 'transition', ',"ended":"signalled","signal":15,"method":"forced"')]);
    await writeSlot(root, 1, second, commitRecord({ slot: 1, bytes: second, index: 2n, start: 1n, end: 3n }));

    await expect(observer.drain()).resolves.toBe('drained');
    expect(seen.at(-1)!.event).toMatchObject({
      type: 'exit',
      outcome: { kind: 'signalled', signal: 15, method: 'forced' }
    });
  });

  it('performs at most one store read when two callers drain concurrently (desk#59)', async () => {
    // The control wrapper and the transition microtask can both ask. Reading
    // twice over one cursor would deliver the same exit twice or skip a commit.
    const root = await makeStore();
    const first = eventBody([event('ready', 1, 1n)]);
    await writeSlot(root, 0, first, commitRecord({ slot: 0, bytes: first, index: 1n, start: 1n, end: 2n }));

    const { seen, handlers } = collector();
    const observer = await startObserver(root, handlers);

    const second = eventBody([event('ready', 1, 1n), event('exit', 1, 2n, 'transition', ',"ended":"signalled","signal":15,"method":"forced"')]);
    await writeSlot(root, 1, second, commitRecord({ slot: 1, bytes: second, index: 2n, start: 1n, end: 3n }));

    await Promise.all([observer.drain(), observer.drain()]);

    expect(seen.filter((entry) => entry.event.type === 'exit')).toHaveLength(1);
  });

  it('a stopped observer drains nothing — why the retired path must drain BEFORE stopping', async () => {
    // The daemon schedules stopEventObserver on EVERY lifecycle-exited
    // transition, including the retired placeholder that beginRetire emits
    // synchronously. That microtask runs while retireAwaited is still awaiting
    // the kill, so by the time the control path drains, the observer is
    // already stopped and the drain returns without reading anything. This
    // pins the mechanism: whoever stops first wins, and the exit is lost.
    const root = await makeStore();
    const first = eventBody([event('ready', 1, 1n)]);
    await writeSlot(root, 0, first, commitRecord({ slot: 0, bytes: first, index: 1n, start: 1n, end: 2n }));

    const { seen, handlers } = collector();
    const observer = await startObserver(root, handlers);

    const second = eventBody([event('ready', 1, 1n), event('exit', 1, 2n, 'transition', ',"ended":"signalled","signal":15,"method":"forced"')]);
    await writeSlot(root, 1, second, commitRecord({ slot: 1, bytes: second, index: 2n, start: 1n, end: 3n }));

    // Pinned deliberately: stopping first is irreversible, so the retired
    // teardown path schedules the drain instead of a bare stop, and the
    // control wrapper joins that same memoized work.
    observer.stop();
    await observer.drain();

    expect(seen.some((entry) => entry.event.type === 'exit')).toBe(false);
  });

  it('gives up on a drain that will not settle instead of hanging teardown (desk#59)', async () => {
    // Reading the committed store is a local filesystem operation: a read that
    // has not settled is stuck, and holding a session's retirement open for it
    // trades one lost record for a session that never finishes dying.
    const root = await makeStore();
    const body = eventBody([event('ready', 1, 1n)]);
    await writeSlot(root, 0, body, commitRecord({ slot: 0, bytes: body, index: 1n, start: 1n, end: 2n }));

    const { handlers } = collector();
    const observer = await startObserver(root, handlers);

    await expect(observer.drain(0)).resolves.toBe('unobservable');
  });

  it('reports an unreadable store as unobservable instead of inventing an exit (desk#59)', async () => {
    const root = await makeStore();
    const body = eventBody([event('ready', 1, 1n)]);
    await writeSlot(root, 0, body, commitRecord({ slot: 0, bytes: body, index: 1n, start: 1n, end: 2n }));

    const { seen, handlers } = collector();
    // The claim under test is what drain() says about a store that is GONE.
    // The background poll must not get to read the store while `rm` is
    // half-way through it: on a slow runner a 20 ms poll fires mid-removal,
    // reads a directory with fewer than four slots, and takes the TERMINAL
    // (corrupt-content) path — after which drain() honestly reports
    // 'drained' because the observer already stopped. That is a different
    // (also honest) claim; parking the poll keeps this test on the one it
    // names.
    const observer = new MoorEventObserver({
      directory: root,
      generation: 7,
      pollIntervalMs: 60_000,
      ...handlers
    });
    observers.push(observer);
    expect(await observer.start()).toBe(true);
    await rm(root, { recursive: true, force: true });

    await expect(observer.drain()).resolves.toBe('unobservable');
    // Nothing was fabricated for the missing evidence.
    expect(seen.some((entry) => entry.event.type === 'exit')).toBe(false);
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
