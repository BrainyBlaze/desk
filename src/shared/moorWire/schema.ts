export const MOOR_MAGIC = Uint8Array.of(0x4d, 0x4f, 0x4f, 0x52);
export const MOOR_VERSION = 3;
export const MOOR_HEADER_SIZE = 24;
export const MOOR_MAX_FRAME_PAYLOAD = 1 << 20;
export const MOOR_MAX_MESSAGE_PAYLOAD = 16 << 20;
export const MOOR_MIN_KIND = 1;
export const MOOR_MAX_KIND = 0x1a;

export const MOOR_FIXED_PAYLOAD_LENGTHS: ReadonlyMap<number, number> = new Map([
  [10, 43],
  [0x11, 0],
  [0x15, 40],
  [0x16, 24],
  [0x17, 20],
  [0x18, 20],
  [0x19, 24],
  [0x1a, 32]
]);

export type MoorWireErrorCode =
  | 'UNKNOWN_VERSION'
  | 'UNKNOWN_TYPE'
  | 'OVERSIZED_FRAME'
  | 'OVERSIZED_MESSAGE'
  | 'MALFORMED'
  | 'BAD_SEQUENCE'
  | 'REASSEMBLY_ABORTED'
  | 'REASSEMBLY_TIMEOUT'
  | 'RESOURCE_EXHAUSTED'
  | 'GENERATION_MISMATCH';

export class MoorWireError extends Error {
  constructor(
    readonly code: MoorWireErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'MoorWireError';
  }
}

function malformed(message: string): never {
  throw new MoorWireError('MALFORMED', message);
}

export function assertMoorKind(kind: number): void {
  if (!Number.isInteger(kind) || kind < MOOR_MIN_KIND || kind > MOOR_MAX_KIND) {
    throw new MoorWireError('UNKNOWN_TYPE', `unsupported controller kind ${kind}`);
  }
}

export function assertMoorScope(scope: number, kind: number): void {
  assertMoorKind(kind);
  if (!Number.isInteger(scope) || scope < 0 || scope > 0xffffffff) {
    malformed(`invalid controller scope ${scope}`);
  }
  if (scope === 0 && kind !== 1) {
    throw new MoorWireError(
      'GENERATION_MISMATCH',
      `zero scope is reserved for controller HELLO, received kind ${kind}`
    );
  }
}

export function assertMoorPayloadLength(kind: number, length: number): void {
  assertMoorKind(kind);
  if (!Number.isInteger(length) || length < 0) {
    malformed(`invalid payload length ${length}`);
  }
  if (length > MOOR_MAX_MESSAGE_PAYLOAD) {
    throw new MoorWireError(
      'OVERSIZED_MESSAGE',
      `payload length ${length} exceeds ${MOOR_MAX_MESSAGE_PAYLOAD}`
    );
  }
  const expected = MOOR_FIXED_PAYLOAD_LENGTHS.get(kind);
  if (expected !== undefined && length !== expected) {
    malformed(`kind ${kind} requires ${expected} payload bytes, received ${length}`);
  }
}
