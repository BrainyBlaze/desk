import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import {
  SESSION_SCREEN_CHECKPOINT_VERSION,
  isSessionScreenCheckpoint,
  type SessionScreenCheckpoint,
  type SessionScreenCheckpointStore
} from '../../shared/runtime/sessionScreenCheckpointStore.js';

const WRITE_DELAY_MS = 100;
const U64_MAX = (1n << 64n) - 1n;

interface DiskCheckpoint {
  v: number;
  s: string;
  g: number;
  o: string;
  r: number;
  c: number;
  t: string;
}

function copy(checkpoint: SessionScreenCheckpoint): SessionScreenCheckpoint {
  return { ...checkpoint, geometry: { ...checkpoint.geometry } };
}

export class FileSessionScreenCheckpointStore
  implements SessionScreenCheckpointStore
{
  private readonly directory: string;
  private readonly checkpoints = new Map<string, SessionScreenCheckpoint>();
  private readonly dirty = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.load();
  }

  get(sessionId: string, generation: number): SessionScreenCheckpoint | undefined {
    const checkpoint = this.checkpoints.get(sessionId);
    return checkpoint?.generation === generation ? copy(checkpoint) : undefined;
  }

  record(checkpoint: Omit<SessionScreenCheckpoint, 'version'>): void {
    if (this.closed || !isSessionScreenCheckpoint(checkpoint)) return;
    const current = this.checkpoints.get(checkpoint.sessionId);
    if (
      current !== undefined &&
      current.generation === checkpoint.generation &&
      current.outputOffset > checkpoint.outputOffset
    ) {
      return;
    }
    this.checkpoints.set(checkpoint.sessionId, {
      ...checkpoint,
      version: SESSION_SCREEN_CHECKPOINT_VERSION,
      geometry: { ...checkpoint.geometry }
    });
    this.dirty.add(checkpoint.sessionId);
    this.schedule(checkpoint.sessionId);
  }

  forget(sessionId: string): void {
    this.checkpoints.delete(sessionId);
    this.dirty.delete(sessionId);
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.remove(this.pathFor(sessionId));
    this.remove(this.scratchFor(sessionId));
  }

  close(): void {
    if (this.closed) return;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const sessionId of [...this.dirty]) this.flushOne(sessionId);
    this.closed = true;
  }

  private load(): void {
    let names: string[];
    try {
      names = readdirSync(this.directory).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    for (const name of names) {
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(join(this.directory, name), 'utf8'));
      } catch {
        continue;
      }
      const checkpoint = this.decode(value);
      if (checkpoint === undefined) continue;
      const current = this.checkpoints.get(checkpoint.sessionId);
      if (
        current === undefined ||
        checkpoint.generation > current.generation ||
        (checkpoint.generation === current.generation &&
          checkpoint.outputOffset >= current.outputOffset)
      ) {
        this.checkpoints.set(checkpoint.sessionId, checkpoint);
      }
    }
  }

  private decode(value: unknown): SessionScreenCheckpoint | undefined {
    if (value === null || typeof value !== 'object') return undefined;
    const record = value as Partial<DiskCheckpoint>;
    if (
      record.v !== SESSION_SCREEN_CHECKPOINT_VERSION ||
      typeof record.s !== 'string' ||
      typeof record.g !== 'number' ||
      typeof record.o !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(record.o) ||
      typeof record.r !== 'number' ||
      typeof record.c !== 'number' ||
      typeof record.t !== 'string'
    ) {
      return undefined;
    }
    let outputOffset: bigint;
    try {
      outputOffset = BigInt(record.o);
    } catch {
      return undefined;
    }
    if (outputOffset > U64_MAX) return undefined;
    const checkpoint: SessionScreenCheckpoint = {
      version: SESSION_SCREEN_CHECKPOINT_VERSION,
      sessionId: record.s,
      generation: record.g,
      outputOffset,
      geometry: { rows: record.r, cols: record.c },
      snapshot: record.t
    };
    return isSessionScreenCheckpoint(checkpoint) ? checkpoint : undefined;
  }

  private schedule(sessionId: string): void {
    if (this.timers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.flushOne(sessionId);
    }, WRITE_DELAY_MS);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  private flushOne(sessionId: string): void {
    if (!this.dirty.has(sessionId)) return;
    const checkpoint = this.checkpoints.get(sessionId);
    if (checkpoint === undefined) return;
    const target = this.pathFor(sessionId);
    const scratch = this.scratchFor(sessionId);
    const body = JSON.stringify({
      v: checkpoint.version,
      s: checkpoint.sessionId,
      g: checkpoint.generation,
      o: checkpoint.outputOffset.toString(),
      r: checkpoint.geometry.rows,
      c: checkpoint.geometry.cols,
      t: checkpoint.snapshot
    } satisfies DiskCheckpoint);
    try {
      writeFileSync(scratch, body, { encoding: 'utf8', mode: 0o600 });
      renameSync(scratch, target);
      this.dirty.delete(sessionId);
    } catch {
      this.remove(scratch);
    }
  }

  private pathFor(sessionId: string): string {
    const key = createHash('sha256').update(sessionId).digest('hex');
    return join(this.directory, `${key}.json`);
  }

  private scratchFor(sessionId: string): string {
    return `${this.pathFor(sessionId)}.${process.pid}.tmp`;
  }

  private remove(path: string): void {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // A stale checkpoint is still generation-fenced and can be overwritten later.
    }
  }
}
