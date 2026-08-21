import { isRealSessionGeometry, type SessionGeometry } from './sessionGeometryStore.js';

export const SESSION_SCREEN_CHECKPOINT_VERSION = 1;
export const MAX_SESSION_SCREEN_CHECKPOINT_BYTES = 4 * 1024 * 1024;

export interface SessionScreenCheckpoint {
  readonly version: typeof SESSION_SCREEN_CHECKPOINT_VERSION;
  readonly sessionId: string;
  readonly generation: number;
  readonly outputOffset: bigint;
  readonly geometry: SessionGeometry;
  readonly snapshot: string;
}

export interface SessionScreenCheckpointStore {
  get(sessionId: string, generation: number): SessionScreenCheckpoint | undefined;
  record(checkpoint: Omit<SessionScreenCheckpoint, 'version'>): void;
  forget(sessionId: string): void;
  close?(): void;
}

/**
 * A serialized xterm screen can contain cursor/mode state while every cell is
 * still blank. Such a stream is not a recoverable screen baseline: treating it
 * as one permanently suppresses the one-time repaint needed after a zero-cache
 * holder adoption. Ignore control strings and escape sequences, and require at
 * least one printable cell outside them.
 */
export function screenSnapshotHasVisibleText(snapshot: string): boolean {
  let index = 0;
  while (index < snapshot.length) {
    const code = snapshot.charCodeAt(index);
    if (code === 0x1b) {
      const next = snapshot.charCodeAt(index + 1);
      if (next === 0x5b) {
        index += 2;
        while (index < snapshot.length) {
          const part = snapshot.charCodeAt(index++);
          if (part >= 0x40 && part <= 0x7e) break;
        }
        continue;
      }
      if (next === 0x50 || next === 0x5d || next === 0x5e || next === 0x5f) {
        index += 2;
        while (index < snapshot.length) {
          if (snapshot.charCodeAt(index) === 0x07) {
            index += 1;
            break;
          }
          if (
            snapshot.charCodeAt(index) === 0x1b &&
            snapshot.charCodeAt(index + 1) === 0x5c
          ) {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += 1;
      while (index < snapshot.length) {
        const part = snapshot.charCodeAt(index);
        index += 1;
        if (part >= 0x30 && part <= 0x7e) break;
      }
      continue;
    }
    if (code > 0x20 && (code < 0x7f || code > 0x9f)) return true;
    index += 1;
  }
  return false;
}

export function isSessionScreenCheckpoint(
  checkpoint: Omit<SessionScreenCheckpoint, 'version'> | SessionScreenCheckpoint
): boolean {
  return (
    checkpoint.sessionId.length > 0 &&
    Number.isSafeInteger(checkpoint.generation) &&
    checkpoint.generation > 0 &&
    checkpoint.outputOffset >= 0n &&
    isRealSessionGeometry(checkpoint.geometry) &&
    (checkpoint.outputOffset === 0n || screenSnapshotHasVisibleText(checkpoint.snapshot)) &&
    new TextEncoder().encode(checkpoint.snapshot).byteLength <=
      MAX_SESSION_SCREEN_CHECKPOINT_BYTES
  );
}

function copy(checkpoint: SessionScreenCheckpoint): SessionScreenCheckpoint {
  return {
    ...checkpoint,
    geometry: { ...checkpoint.geometry }
  };
}

export class InMemorySessionScreenCheckpointStore
  implements SessionScreenCheckpointStore
{
  private readonly checkpoints = new Map<string, SessionScreenCheckpoint>();

  get(sessionId: string, generation: number): SessionScreenCheckpoint | undefined {
    const checkpoint = this.checkpoints.get(sessionId);
    return checkpoint?.generation === generation ? copy(checkpoint) : undefined;
  }

  record(checkpoint: Omit<SessionScreenCheckpoint, 'version'>): void {
    if (!isSessionScreenCheckpoint(checkpoint)) return;
    this.checkpoints.set(
      checkpoint.sessionId,
      copy({ ...checkpoint, version: SESSION_SCREEN_CHECKPOINT_VERSION })
    );
  }

  forget(sessionId: string): void {
    this.checkpoints.delete(sessionId);
  }
}
