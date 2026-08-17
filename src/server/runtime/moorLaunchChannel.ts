// Moor's fixed child-visible semantic carrier (moor spec §10.1): read
// name-agnostically by a semantic producer inside the session child, so it is
// a FIXED literal, never derived from the holder's invoked name.
export const MOOR_SESSION_GENERATION = 'MOOR_SESSION_GENERATION';
// Desk's OWN application variable (hooks/agent-host fencing). Moor never
// names, validates, strips, or injects it — it rides the child environment as
// opaque application env. Genuinely distinct from the moor carrier above.
export const DESK_SESSION_GENERATION = 'DESK_SESSION_GENERATION';

const GENERATION_SUFFIX = '_GENERATION';
const LAUNCH_CHANNEL_SUFFIX = '_LAUNCH_CHANNEL';
const LAUNCH_RECORD_MAGIC = Uint8Array.of(0x4d, 0x4f, 0x4f, 0x52, 0x4c, 0x43, 0x48, 0x33, 1);
const LAUNCH_RESULT_MAGIC = Uint8Array.of(0x4d, 0x4f, 0x52, 0x52, 1);

export type MoorLaunchChannelErrorCode =
  | 'MALFORMED_RECORD'
  | 'MALFORMED_RESULT'
  | 'INVALID_SEQUENCE'
  | 'INCOMPLETE';

export class MoorLaunchChannelError extends Error {
  constructor(
    readonly code: MoorLaunchChannelErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'MoorLaunchChannelError';
  }
}

export interface MoorLaunchRecord {
  readonly generation: number;
  readonly nonce: Uint8Array;
}

export type MoorLaunchResult =
  | { readonly type: 'adopted'; readonly result: 0; readonly generation: number }
  | { readonly type: 'ready'; readonly result: 0; readonly generation: number }
  | { readonly type: 'failed'; readonly result: number; readonly generation: number };

export type MoorLaunchSequenceEnd =
  | { readonly type: 'terminal-eof' }
  | { readonly type: 'adopted-eof'; readonly generation: number };

export function encodeMoorLaunchRecord(generation: number, nonce: Uint8Array): Uint8Array {
  assertGeneration(generation, 2, 'MALFORMED_RECORD');
  if (nonce.length !== 16 || isZero(nonce)) {
    throw new MoorLaunchChannelError(
      'MALFORMED_RECORD',
      'launch nonce must be exactly 16 nonzero bytes'
    );
  }
  const record = new Uint8Array(32);
  record.set(LAUNCH_RECORD_MAGIC, 0);
  new DataView(record.buffer).setUint32(12, generation, true);
  record.set(nonce, 16);
  return record;
}

export function decodeMoorLaunchRecord(bytes: Uint8Array): MoorLaunchRecord {
  if (bytes.length !== 32) malformedRecord('launch record must be exactly 32 bytes');
  const generation = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    12,
    true
  );
  const nonce = bytes.slice(16, 32);
  if (
    !equal(bytes.subarray(0, 9), LAUNCH_RECORD_MAGIC) ||
    !isZero(bytes.subarray(9, 12)) ||
    generation < 2 ||
    isZero(nonce)
  ) {
    malformedRecord('invalid Moor launch record');
  }
  return { generation, nonce };
}

export function decodeMoorLaunchResult(bytes: Uint8Array): MoorLaunchResult {
  if (bytes.length !== 12) malformedResult('launch result must be exactly 12 bytes');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const state = view.getUint8(5);
  const result = view.getUint16(6, true);
  const generation = view.getUint32(8, true);
  if (!equal(bytes.subarray(0, 5), LAUNCH_RESULT_MAGIC) || generation === 0) {
    malformedResult('invalid Moor launch result');
  }
  if (state === 1 && result === 0) return { type: 'adopted', result: 0, generation };
  if (state === 2 && result === 0) return { type: 'ready', result: 0, generation };
  if (state === 3 && result !== 0) return { type: 'failed', result, generation };
  malformedResult('invalid Moor launch result state');
}

export class MoorLaunchResultDecoder {
  private buffer = new Uint8Array();
  private phase: 'initial' | 'adopted' | 'terminal' = 'initial';
  private generation: number | undefined;
  private ended = false;
  private failure: MoorLaunchChannelError | undefined;

  get terminal(): boolean {
    return this.phase === 'terminal';
  }

  get adoptedGeneration(): number | undefined {
    return this.generation;
  }

  feed(bytes: Uint8Array): MoorLaunchResult[] {
    this.assertOpen();
    try {
      if (this.phase === 'terminal' && bytes.length !== 0) {
        throw new MoorLaunchChannelError('INVALID_SEQUENCE', 'bytes followed a terminal launch result');
      }
      this.append(bytes);
      const events: MoorLaunchResult[] = [];
      while (this.buffer.length >= 12) {
        const event = decodeMoorLaunchResult(this.buffer.subarray(0, 12));
        this.buffer = this.buffer.slice(12);
        this.accept(event);
        events.push(event);
        if (this.phase === 'terminal' && this.buffer.length !== 0) {
          throw new MoorLaunchChannelError(
            'INVALID_SEQUENCE',
            'bytes followed a terminal launch result'
          );
        }
      }
      return events;
    } catch (error) {
      throw this.fail(error);
    }
  }

  end(): MoorLaunchSequenceEnd {
    this.assertOpen();
    try {
      if (this.buffer.length !== 0) {
        throw new MoorLaunchChannelError('INCOMPLETE', 'partial Moor launch result at EOF');
      }
      if (this.phase === 'initial') {
        throw new MoorLaunchChannelError('INCOMPLETE', 'holder failed before launch');
      }
      this.ended = true;
      return this.phase === 'adopted'
        ? { type: 'adopted-eof', generation: this.generation! }
        : { type: 'terminal-eof' };
    } catch (error) {
      throw this.fail(error);
    }
  }

  private append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const combined = new Uint8Array(this.buffer.length + bytes.length);
    combined.set(this.buffer, 0);
    combined.set(bytes, this.buffer.length);
    this.buffer = combined;
  }

  private accept(event: MoorLaunchResult): void {
    if (this.phase === 'initial') {
      if (event.type === 'ready') {
        throw new MoorLaunchChannelError('INVALID_SEQUENCE', 'ready preceded adoption');
      }
      this.generation = event.generation;
      this.phase = event.type === 'failed' ? 'terminal' : 'adopted';
      return;
    }
    if (
      this.phase !== 'adopted' ||
      event.type === 'adopted' ||
      event.generation !== this.generation
    ) {
      throw new MoorLaunchChannelError('INVALID_SEQUENCE', 'invalid Moor launch result sequence');
    }
    this.phase = 'terminal';
  }

  private assertOpen(): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.ended) {
      throw new MoorLaunchChannelError('INVALID_SEQUENCE', 'launch result stream already ended');
    }
  }

  private fail(error: unknown): MoorLaunchChannelError {
    if (this.failure !== undefined) return this.failure;
    this.buffer = new Uint8Array();
    this.failure =
      error instanceof MoorLaunchChannelError
        ? error
        : new MoorLaunchChannelError(
            'INVALID_SEQUENCE',
            error instanceof Error ? error.message : String(error)
          );
    return this.failure;
  }
}

export function moorGenerationEnvKey(invokedPath: string | Uint8Array): string {
  return moorEnvKey(invokedPath, GENERATION_SUFFIX);
}

/**
 * The launch-channel selector key (moor spec §10.1.1): derived from the
 * INVOKED basename exactly like the generation carrier, because the external
 * launcher sets it by the name it invokes — a `moor-copy` invocation must
 * yield the same key on both sides.
 */
export function moorLaunchChannelEnvKey(invokedPath: string | Uint8Array): string {
  return moorEnvKey(invokedPath, LAUNCH_CHANNEL_SUFFIX);
}

// One derivation for every invocation-derived carrier, frozen by moor spec
// §10.1.1: the transformed basename portion is capped at 127 - len(suffix)
// BYTES (112 for _LAUNCH_CHANNEL, 116 for _GENERATION) BEFORE the suffix is
// appended — a suffix-aware cap, not a cap on the finished key, so both sides
// truncate identically (moor private.rs environment_key does take(127 -
// suffix.len()) over the raw basename bytes).
function moorEnvKey(
  invokedPath: string | Uint8Array,
  suffix: string
): string {
  const raw = typeof invokedPath === 'string' ? Buffer.from(invokedPath) : invokedPath;
  const basename = fileName(raw) ?? Uint8Array.of(0x6d, 0x6f, 0x6f, 0x72);
  const maximum = 127 - suffix.length;
  let key = '';
  for (const byte of basename.subarray(0, maximum)) {
    key += asciiAlphanumeric(byte) ? String.fromCharCode(toAsciiUppercase(byte)) : '_';
  }
  return key + suffix;
}

// Mirrors the holder's POSIX basename derivation. A backslash is a legal
// filename byte and therefore survives into the environment key.
function fileName(path: Uint8Array): Uint8Array | undefined {
  const separator = (byte: number | undefined): boolean => byte === 0x2f;
  let end = path.length;
  while (end > 0 && separator(path[end - 1])) end -= 1;
  if (end === 0) return undefined;
  let start = end;
  while (start > 0 && !separator(path[start - 1])) start -= 1;
  const name = path.subarray(start, end);
  if (
    name.length === 0 ||
    (name.length === 1 && name[0] === 0x2e) ||
    (name.length === 2 && name[0] === 0x2e && name[1] === 0x2e)
  ) {
    return undefined;
  }
  return name;
}

function assertGeneration(
  generation: number,
  minimum: number,
  code: MoorLaunchChannelErrorCode
): void {
  if (
    !Number.isInteger(generation) ||
    generation < minimum ||
    generation > 0xffff_ffff
  ) {
    throw new MoorLaunchChannelError(code, 'launch generation is out of range');
  }
}

function malformedRecord(message: string): never {
  throw new MoorLaunchChannelError('MALFORMED_RECORD', message);
}

function malformedResult(message: string): never {
  throw new MoorLaunchChannelError('MALFORMED_RESULT', message);
}

function asciiAlphanumeric(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a)
  );
}

function toAsciiUppercase(byte: number): number {
  return byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}
