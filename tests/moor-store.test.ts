import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { crc32c } from '../src/shared/moorWire/crc32c.js';
import { MoorKind, decodeMoorHolderMessage } from '../src/shared/moorWire/messages.js';
import { MoorWireError } from '../src/shared/moorWire/schema.js';
import {
  MoorStoreError,
  MoorStoreKind,
  decodeMoorEventSnapshot,
  eventsAfterMoorCursor,
  readMoorStoreSnapshot,
  type MoorCommit,
  type MoorEventCursor
} from '../src/server/runtime/moorStore.js';

const roots: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sessionIdentity(): Uint8Array {
  return Uint8Array.of(1, 0x2f, ...encoder.encode('tmp/session'));
}

function joined(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function integer(value: number | bigint, bytes: 2 | 4 | 8): Uint8Array {
  const result = new Uint8Array(bytes);
  const view = new DataView(result.buffer);
  if (bytes === 2) view.setUint16(0, Number(value), true);
  if (bytes === 4) view.setUint32(0, Number(value), true);
  if (bytes === 8) view.setBigUint64(0, BigInt(value), true);
  return result;
}

const wide = (bytes: Uint8Array): Uint8Array => joined(integer(bytes.length, 4), bytes);

function legacyLayoutOneStatusPayload(): {
  payload: Uint8Array;
  identity: Uint8Array;
  incarnation: Uint8Array;
} {
  const identity = sessionIdentity();
  const incarnation = new Uint8Array(16).fill(0x11);
  const eventIdentity = Uint8Array.of(...identity, ...encoder.encode('/events'));
  const emptyCommit = joined(
    Uint8Array.of(0xff), // bodySlot
    integer(0n, 8), // commitIndex
    integer(0n, 8), // bodyLength
    new Uint8Array(32) // bodyHash
  );
  const replayTail = joined(new Uint8Array(32), Uint8Array.of(1), new Uint8Array(36));

  return {
    identity,
    incarnation,
    payload: joined(
      wide(identity),
      integer(7, 4),
      incarnation,
      Uint8Array.of(1),
      wide(eventIdentity),
      emptyCommit,
      integer(100n, 8),
      integer(50n, 8),
      new Uint8Array(16).fill(0x33),
      wide(encoder.encode('/tmp/session')),
      integer(1234, 4),
      integer(5678, 4),
      new Uint8Array(16).fill(0x44),
      integer(80, 2),
      integer(24, 2),
      replayTail
    )
  };
}

const V24_LIFECYCLE_BODY = encoder.encode(
  '{"v":2,"type":"lifecycle","phase":"running","session":"AS9z","generation":7,"wire_generation":7,"incarnation":"AgICAgICAgICAgICAgICAg==","start_wall_ms":"1","start_mono_ms":"2","boot_id":"AwMDAwMDAwMDAwMDAwMDAw==","path_encoding":"posix-bytes","event_path":null,"instrument_path":null}\n'
);

function exitedLifecycleBody(options: {
  ended?: 'exited' | 'signalled' | 'terminated';
  method?: 'none' | 'graceful' | 'forced' | 'unknown' | null;
  code?: number;
  signal?: number;
} = {}): Uint8Array {
  const identity = sessionIdentity();
  const ended = options.ended ?? 'exited';
  const mechanism =
    ended === 'signalled'
      ? `,"signal":${options.signal ?? 15}`
      : `,"code":${options.code ?? 0}`;
  const method = options.method === null ? '' : `,"method":"${options.method ?? 'none'}"`;
  return encoder.encode(
    `{"v":2,"type":"lifecycle","phase":"exited","session":"${Buffer.from(identity).toString('base64')}","generation":7,"wire_generation":7,"incarnation":"AgICAgICAgICAgICAgICAg==","start_wall_ms":"1","start_mono_ms":"2","boot_id":"AwMDAwMDAwMDAwMDAwMDAw==","path_encoding":"posix-bytes","event_path":null,"instrument_path":null,"end_wall_ms":"3","output_end":"12","ended":"${ended}"${mechanism}${method}}\n`
  );
}

function header(generation: number, epoch: number, first: bigint, next: bigint): string {
  const encodedGeneration = generation === 1 ? 'null' : String(generation);
  return `{"v":2,"type":"header","ts":1,"session":"${Buffer.from(sessionIdentity()).toString('base64')}","generation":${encodedGeneration},"epoch":${epoch},"next_seq":${next},"first_retained":${first}}\n`;
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

function eventBody(options: {
  generation?: number;
  epoch?: number;
  first?: bigint;
  records?: string[];
} = {}): Uint8Array {
  const generation = options.generation ?? 7;
  const epoch = options.epoch ?? 1;
  const first = options.first ?? 1n;
  const records = options.records ?? [event('ready', epoch, first)];
  return encoder.encode(header(generation, epoch, first, first + BigInt(records.length)) + records.join(''));
}

function eventBodyAtLength(length: number): { body: Uint8Array; nextSequence: bigint } {
  const title = 'x'.repeat(255);
  const records: string[] = [];
  let body = eventBody({ records });
  while (body.length < length) {
    const sequence = 1n + BigInt(records.length);
    records.push(
      event(
        'state',
        1,
        sequence,
        'transition',
        `,"state":"idle","title":"${title}","truncated":false`
      )
    );
    body = eventBody({ records });
  }

  let excess = body.length - length;
  for (let index = records.length - 1; index >= 0 && excess > 0; index -= 1) {
    const removed = Math.min(title.length, excess);
    records[index] = event(
      'state',
      1,
      1n + BigInt(index),
      'transition',
      `,"state":"idle","title":"${title.slice(removed)}","truncated":false`
    );
    excess -= removed;
  }
  body = eventBody({ records });
  if (body.length !== length) throw new Error(`unable to build ${length}-byte event body`);
  return { body, nextSequence: 1n + BigInt(records.length) };
}

interface CommitOptions {
  slot: 0 | 1;
  body?: 0 | 1;
  kind?: MoorStoreKind;
  generation?: number;
  epoch?: number;
  index?: bigint;
  start?: bigint;
  end?: bigint;
  bytes: Uint8Array;
}

function commitRecord(options: CommitOptions): Uint8Array {
  const body = options.body ?? options.slot;
  const kind = options.kind ?? MoorStoreKind.Event;
  const generation = options.generation ?? 7;
  const epoch = options.epoch ?? 1;
  const index = options.index ?? BigInt(options.slot + 1);
  const start = options.start ?? 1n;
  const end = options.end ?? 2n;
  const record = new Uint8Array(92);
  const view = new DataView(record.buffer);
  record.set(encoder.encode('MOORCMT1'), 0);
  record[8] = 1;
  record[9] = options.slot;
  record[10] = body;
  record[11] = kind;
  view.setUint32(12, generation, true);
  view.setUint32(16, epoch, true);
  view.setBigUint64(24, index, true);
  view.setBigUint64(32, BigInt(options.bytes.length), true);
  view.setBigUint64(40, start, true);
  view.setBigUint64(48, end, true);
  record.set(createHash('sha256').update(options.bytes).digest(), 56);
  view.setUint32(88, crc32c(record.subarray(0, 88)), true);
  return record;
}

async function store(options: {
  body0?: Uint8Array;
  body1?: Uint8Array;
  commit0?: Uint8Array;
  commit1?: Uint8Array;
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desk-moor-store-'));
  roots.push(root);
  await chmod(root, 0o700);
  const empty = new Uint8Array();
  await Promise.all([
    writeFile(join(root, 'body.0'), options.body0 ?? empty, { mode: 0o600 }),
    writeFile(join(root, 'body.1'), options.body1 ?? empty, { mode: 0o600 }),
    writeFile(join(root, 'commit.0'), options.commit0 ?? empty, { mode: 0o600 }),
    writeFile(join(root, 'commit.1'), options.commit1 ?? empty, { mode: 0o600 })
  ]);
  return root;
}

function asCommit(
  body: Uint8Array,
  overrides: Partial<MoorCommit> = {}
): MoorCommit {
  return {
    slot: 0,
    bodySlot: 0,
    kind: MoorStoreKind.Event,
    generation: 7,
    epoch: 1,
    index: 1n,
    length: BigInt(body.length),
    start: 1n,
    end: 2n,
    hash: new Uint8Array(createHash('sha256').update(body).digest()),
    ...overrides
  };
}

describe('Moor committed-store descriptor grammar', () => {
  it('rejects legacy layout 1 with event identity present and empty commit fields', () => {
    const { payload, identity, incarnation } = legacyLayoutOneStatusPayload();

    expect(() =>
      decodeMoorHolderMessage(
        { scope: 7, kind: MoorKind.STATUS_REPLY, payload },
        { identity, generation: 7, incarnation }
      )
    ).toThrowError(expect.objectContaining<MoorWireError>({ code: 'MALFORMED' }));
  });
});

describe('Moor committed store selection', () => {
  it('reads the exact commit layout and only the committed body prefix', async () => {
    const body = eventBody();
    const suffix = encoder.encode('uncommitted suffix');
    const directory = await store({
      body0: Uint8Array.of(...body, ...suffix),
      commit0: commitRecord({ slot: 0, bytes: body })
    });
    const selected = await readMoorStoreSnapshot(directory, MoorStoreKind.Event, 7);
    expect(selected.commit).toMatchObject({
      slot: 0,
      bodySlot: 0,
      kind: MoorStoreKind.Event,
      generation: 7,
      epoch: 1,
      index: 1n,
      length: BigInt(body.length),
      start: 1n,
      end: 2n
    });
    expect(selected.bytes).toEqual(body);
  });

  it('honors body-slot indirection independently of the commit filename', async () => {
    const body = eventBody();
    const directory = await store({
      body0: encoder.encode('wrong body'),
      body1: body,
      commit0: commitRecord({ slot: 0, body: 1, bytes: body })
    });
    const selected = await readMoorStoreSnapshot(directory, MoorStoreKind.Event, 7);
    expect(selected.commit).toMatchObject({ slot: 0, bodySlot: 1 });
    expect(selected.bytes).toEqual(body);
  });

  it('discards a corrupt newer body before selection and falls back to the valid older commit', async () => {
    const valid = eventBody();
    const malformed = encoder.encode('not canonical event data\n');
    const directory = await store({
      body0: valid,
      body1: malformed,
      commit0: commitRecord({ slot: 0, index: 4n, bytes: valid }),
      commit1: commitRecord({ slot: 1, index: 5n, bytes: malformed })
    });
    const selected = await readMoorStoreSnapshot(directory, MoorStoreKind.Event, 7);
    expect(selected.commit.index).toBe(4n);
    expect(selected.bytes).toEqual(valid);
  });

  it('selects the greater valid index and treats equal indexes as corruption', async () => {
    const body = eventBody();
    const greater = await store({
      body0: body,
      body1: body,
      commit0: commitRecord({ slot: 0, index: 9n, bytes: body }),
      commit1: commitRecord({ slot: 1, index: 10n, bytes: body })
    });
    expect((await readMoorStoreSnapshot(greater, MoorStoreKind.Event)).commit.index).toBe(10n);

    const equal = await store({
      body0: body,
      body1: body,
      commit0: commitRecord({ slot: 0, index: 9n, bytes: body }),
      commit1: commitRecord({ slot: 1, index: 9n, bytes: body })
    });
    await expect(readMoorStoreSnapshot(equal, MoorStoreKind.Event)).rejects.toMatchObject({
      code: 'CORRUPT'
    });
  });

  it('treats differing valid generations as corruption only without an expected generation', async () => {
    const seven = eventBody({ generation: 7 });
    const eight = eventBody({ generation: 8 });
    const directory = await store({
      body0: seven,
      body1: eight,
      commit0: commitRecord({ slot: 0, generation: 7, index: 9n, bytes: seven }),
      commit1: commitRecord({ slot: 1, generation: 8, index: 10n, bytes: eight })
    });
    await expect(readMoorStoreSnapshot(directory, MoorStoreKind.Event)).rejects.toMatchObject({
      code: 'CORRUPT'
    });
    expect(
      (await readMoorStoreSnapshot(directory, MoorStoreKind.Event, 7)).commit.generation
    ).toBe(7);
    await expect(readMoorStoreSnapshot(directory, MoorStoreKind.Event, 9)).rejects.toMatchObject({
      code: 'GENERATION_MISMATCH'
    });
  });

  it('rejects bad CRC, reserved bytes, kind, and no valid candidate', async () => {
    const body = eventBody();
    for (const mutate of [
      (record: Uint8Array) => {
        record[20] = 1;
      },
      (record: Uint8Array) => {
        record[11] = MoorStoreKind.Log;
      },
      (record: Uint8Array) => {
        record[88] ^= 1;
      }
    ]) {
      const record = commitRecord({ slot: 0, bytes: body });
      mutate(record);
      const directory = await store({ body0: body, commit0: record });
      await expect(readMoorStoreSnapshot(directory, MoorStoreKind.Event)).rejects.toMatchObject({
        code: 'CORRUPT'
      });
    }
  });

  it('applies exact kind limits while leaving Log without an Event-sized cap', async () => {
    const log = new Uint8Array(330_000).fill(0x61);
    const directory = await store({
      body0: log,
      commit0: commitRecord({
        slot: 0,
        kind: MoorStoreKind.Log,
        epoch: 1,
        start: 0n,
        end: BigInt(log.length),
        bytes: log
      })
    });
    expect((await readMoorStoreSnapshot(directory, MoorStoreKind.Log)).bytes).toHaveLength(log.length);

    await expect(readMoorStoreSnapshot(directory, MoorStoreKind.Event)).rejects.toMatchObject({
      code: 'CORRUPT'
    });
  });
});

describe('Moor store filesystem trust boundary', () => {
  it('rejects missing, extra, symlinked, hard-linked, and incorrectly protected slots', async () => {
    const body = eventBody();
    const cases: Array<(directory: string) => Promise<void>> = [
      async (directory) => unlink(join(directory, 'body.1')),
      async (directory) => writeFile(join(directory, 'extra'), 'x', { mode: 0o600 }),
      async (directory) => {
        await unlink(join(directory, 'body.1'));
        await symlink(join(directory, 'body.0'), join(directory, 'body.1'));
      },
      async (directory) => {
        await unlink(join(directory, 'body.1'));
        await link(join(directory, 'body.0'), join(directory, 'body.1'));
      },
      async (directory) => chmod(join(directory, 'body.1'), 0o644)
    ];
    for (const alter of cases) {
      const directory = await store({
        body0: body,
        commit0: commitRecord({ slot: 0, bytes: body })
      });
      await alter(directory);
      await expect(readMoorStoreSnapshot(directory, MoorStoreKind.Event)).rejects.toMatchObject({
        code: 'CORRUPT'
      });
    }
  });

  it('distinguishes an unprotected directory from an unavailable directory', async () => {
    const unprotected = await store();
    await chmod(unprotected, 0o755);
    await expect(readMoorStoreSnapshot(unprotected, MoorStoreKind.Event)).rejects.toMatchObject({
      code: 'CORRUPT'
    });
    const missing = join(tmpdir(), `desk-moor-missing-${process.pid}-${Date.now()}`);
    await expect(readMoorStoreSnapshot(missing, MoorStoreKind.Event)).rejects.toMatchObject({
      code: 'UNAVAILABLE'
    });
  });
});

describe('Moor event snapshots and cursors', () => {
  it('decodes canonical newline-terminated NDJSON and supports generation-one null', () => {
    const body = eventBody({ generation: 1 });
    const snapshot = decodeMoorEventSnapshot(body, asCommit(body, { generation: 1 }));
    expect(snapshot).toMatchObject({
      generation: 1,
      epoch: 1,
      firstRetained: 1n,
      nextSequence: 2n,
      streamExhausted: false
    });
    expect(snapshot.records).toHaveLength(1);
  });

  it('applies the uncompacted event cap after stripping the terminal newline', () => {
    const accepted = eventBodyAtLength(256 << 10);
    expect(() =>
      decodeMoorEventSnapshot(
        accepted.body,
        asCommit(accepted.body, { end: accepted.nextSequence })
      )
    ).not.toThrow();

    const rejected = eventBodyAtLength((256 << 10) + 1);
    expect(() =>
      decodeMoorEventSnapshot(
        rejected.body,
        asCommit(rejected.body, { end: rejected.nextSequence })
      )
    ).toThrowError(expect.objectContaining({ code: 'CORRUPT' }));
  });

  it('rejects noncanonical, nonterminated, mismatched, or discontinuous event bodies', () => {
    const valid = eventBody();
    const cases = [
      valid.subarray(0, valid.length - 1),
      encoder.encode(new TextDecoder().decode(valid).replace('{"v":2', '{ "v":2')),
      eventBody({ records: [event('ready', 1, 2n)] }),
      eventBody({ epoch: 2 }),
      eventBody({ generation: 8 })
    ];
    for (const body of cases) {
      expect(() => decodeMoorEventSnapshot(body, asCommit(valid))).toThrowError(
        expect.objectContaining<MoorStoreError>({ code: 'CORRUPT' })
      );
    }
  });

  it.each([
    ['a bogus', ',"ended":"exited","code":0,"method":"bogus"'],
    ['a missing', ',"ended":"exited","code":0']
  ] as const)('rejects v4 exit events with %s method', (_label, tail) => {
    const body = eventBody({ records: [event('exit', 1, 1n, 'transition', tail)] });

    expect(() => decodeMoorEventSnapshot(body, asCommit(body))).toThrowError(
      expect.objectContaining<MoorStoreError>({ code: 'CORRUPT' })
    );
  });

  it('emits all records initially and only unseen records after append', () => {
    const initialBody = eventBody({
      records: [event('ready', 1, 1n), event('link', 1, 2n, 'transition', ',"uri":"x","truncated":false')]
    });
    const initial = decodeMoorEventSnapshot(
      initialBody,
      asCommit(initialBody, { index: 2n, end: 3n })
    );
    const first = eventsAfterMoorCursor(initial);
    expect(first.events.map((record) => record.sequence)).toEqual([1n, 2n]);

    const appendedBody = eventBody({
      records: [
        event('ready', 1, 1n),
        event('link', 1, 2n, 'transition', ',"uri":"x","truncated":false'),
        event('ready', 1, 3n)
      ]
    });
    const appended = decodeMoorEventSnapshot(
      appendedBody,
      asCommit(appendedBody, { index: 3n, end: 4n })
    );
    const next = eventsAfterMoorCursor(appended, first.cursor);
    expect(next.events.map((record) => record.sequence)).toEqual([3n]);
    expect(next.cursor.nextSequence).toBe(4n);
  });

  it('recovers across compaction by sequence range even when epoch advances', () => {
    const compactedBody = eventBody({
      epoch: 2,
      first: 3n,
      records: [
        event('state', 2, 3n, 'snapshot', ',"state":"idle","title":"","truncated":false'),
        event('ready', 2, 4n)
      ]
    });
    const snapshot = decodeMoorEventSnapshot(
      compactedBody,
      asCommit(compactedBody, { epoch: 2, index: 10n, start: 3n, end: 5n })
    );
    const cursor: MoorEventCursor = {
      generation: 7,
      epoch: 1,
      nextSequence: 3n,
      commitIndex: 9n,
      commitHash: nonzeroHash(1)
    };
    const resumed = eventsAfterMoorCursor(snapshot, cursor);
    expect(resumed.events.map((record) => record.sequence)).toEqual([3n, 4n]);
    expect(resumed.cursor).toMatchObject({ epoch: 2, nextSequence: 5n, commitIndex: 10n });
  });

  it.each([
    ['GENERATION_MISMATCH', { generation: 8 }],
    ['CORRUPT', { epoch: 3 }],
    ['CORRUPT', { commitIndex: 11n }],
    ['COMPACTION_GAP', { nextSequence: 0n }],
    ['CURSOR_AHEAD', { nextSequence: 3n }]
  ] as const)('rejects %s cursor discontinuity', (code, override) => {
    const body = eventBody();
    const snapshot = decodeMoorEventSnapshot(body, asCommit(body, { index: 10n }));
    const cursor: MoorEventCursor = {
      generation: 7,
      epoch: 1,
      nextSequence: 1n,
      commitIndex: 9n,
      commitHash: nonzeroHash(1),
      ...override
    };
    expect(() => eventsAfterMoorCursor(snapshot, cursor)).toThrowError(
      expect.objectContaining<MoorStoreError>({ code })
    );
  });

  it('requires the same hash at the same bigint commit index and emits nothing', () => {
    const body = eventBody();
    const snapshot = decodeMoorEventSnapshot(
      body,
      asCommit(body, { index: 2n ** 60n })
    );
    const same: MoorEventCursor = {
      generation: 7,
      epoch: 1,
      nextSequence: 2n,
      commitIndex: 2n ** 60n,
      commitHash: snapshot.commitHash.slice()
    };
    expect(eventsAfterMoorCursor(snapshot, same).events).toEqual([]);
    expect(() =>
      eventsAfterMoorCursor(snapshot, { ...same, commitHash: nonzeroHash(0xff) })
    ).toThrowError(expect.objectContaining<MoorStoreError>({ code: 'CORRUPT' }));
  });

  it('surfaces stream-exhausted as a terminal event', () => {
    const body = eventBody({
      records: [
        event('ready', 1, 1n),
        event('stream-exhausted', 1, 2n, 'transition', ',"axis":"seq"')
      ]
    });
    const snapshot = decodeMoorEventSnapshot(body, asCommit(body, { end: 3n }));
    const result = eventsAfterMoorCursor(snapshot);
    expect(result.streamExhausted).toBe(true);
    expect(result.events.at(-1)).toMatchObject({ type: 'stream-exhausted', sequence: 2n });
  });

  it('accepts the exact 286-byte V24 canonical running lifecycle body', async () => {
    expect(V24_LIFECYCLE_BODY).toHaveLength(286);
    const directory = await store({
      body0: V24_LIFECYCLE_BODY,
      commit0: commitRecord({
        slot: 0,
        kind: MoorStoreKind.Exit,
        generation: 7,
        epoch: 1,
        index: 1n,
        start: 0n,
        end: 0n,
        bytes: V24_LIFECYCLE_BODY
      })
    });

    await expect(readMoorStoreSnapshot(directory, MoorStoreKind.Exit, 7)).resolves.toMatchObject({
      bytes: V24_LIFECYCLE_BODY
    });
  });

  it.each([
    ['exited', 'none'],
    ['exited', 'graceful'],
    ['exited', 'forced'],
    ['signalled', 'none'],
    ['signalled', 'graceful'],
    ['signalled', 'forced']
  ] as const)('accepts canonical POSIX %s lifecycle outcomes with method %s', async (ended, method) => {
    const body = exitedLifecycleBody({ ended, method });
    const directory = await store({
      body0: body,
      commit0: commitRecord({
        slot: 0,
        kind: MoorStoreKind.Exit,
        generation: 7,
        epoch: 1,
        index: 2n,
        start: 12n,
        end: 12n,
        bytes: body
      })
    });

    await expect(readMoorStoreSnapshot(directory, MoorStoreKind.Exit, 7)).resolves.toMatchObject({
      bytes: body
    });
  });

  it.each([
    ['missing method', exitedLifecycleBody({ method: null })],
    ['unknown method', exitedLifecycleBody({ method: 'unknown' })],
    [
      'noncanonical extra key',
      encoder.encode(
        new TextDecoder().decode(exitedLifecycleBody()).replace('}\n', ',"extra":0}\n')
      )
    ],
    [
      'retired v1 schema',
      encoder.encode(new TextDecoder().decode(exitedLifecycleBody()).replace('{"v":2', '{"v":1'))
    ],
    ['POSIX exit code 256', exitedLifecycleBody({ code: 256 })]
  ] as const)('rejects %s lifecycle records', async (_label, body) => {
    const directory = await store({
      body0: body,
      commit0: commitRecord({
        slot: 0,
        kind: MoorStoreKind.Exit,
        generation: 7,
        epoch: 1,
        index: 2n,
        start: 12n,
        end: 12n,
        bytes: body
      })
    });

    await expect(readMoorStoreSnapshot(directory, MoorStoreKind.Exit, 7)).rejects.toMatchObject({
      code: 'CORRUPT'
    });
  });

  it('rejects the retired ended:=terminated branch in a v2 lifecycle record', async () => {
    const body = exitedLifecycleBody({ ended: 'terminated', method: 'forced' });
    expect(new TextDecoder().decode(body)).toContain('{"v":2,"type":"lifecycle"');
    const directory = await store({
      body0: body,
      commit0: commitRecord({
        slot: 0,
        kind: MoorStoreKind.Exit,
        generation: 7,
        epoch: 1,
        index: 2n,
        start: 12n,
        end: 12n,
        bytes: body
      })
    });

    await expect(readMoorStoreSnapshot(directory, MoorStoreKind.Exit, 7)).rejects.toMatchObject({
      code: 'CORRUPT'
    });
  });

  it('accepts the canonical platform numeric boundaries', async () => {
    const bodies = [
      exitedLifecycleBody({ code: 255 }),
      exitedLifecycleBody({ ended: 'signalled', signal: 0xffff_ffff, method: 'forced' })
    ];

    for (const body of bodies) {
      const directory = await store({
        body0: body,
        commit0: commitRecord({
          slot: 0,
          kind: MoorStoreKind.Exit,
          generation: 7,
          epoch: 1,
          index: 2n,
          start: 12n,
          end: 12n,
          bytes: body
        })
      });
      await expect(readMoorStoreSnapshot(directory, MoorStoreKind.Exit, 7)).resolves.toBeDefined();
    }
  });
});

function nonzeroHash(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}
