// desk#62 follow-up — the durable geometry record is remembered knowledge, and
// remembered knowledge has to stay bounded and stay typed.
//
// Two defects the first pass left behind:
//
// 1. The log only ever grew. Nothing removed a retired session's record and
//    nothing compacted redundant ones, so a single window drag appended one
//    record per distinct size and every daemon start read the whole history
//    back. Over months that is megabytes of dead session ids on the startup
//    path.
//
// 2. `Number(record.r)` coerced before it checked, so a record whose numbers
//    are strings validated as measured knowledge. The file is ours today, but
//    "coerce, then validate" is the exact inversion that hides the honest
//    answer everywhere else in this codebase.

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileSessionGeometryStore } from '../src/server/runtime/fileSessionGeometryStore.js';
import { InMemorySessionGeometryStore } from '../src/shared/runtime/sessionGeometryStore.js';
import {
  GenerationLedger,
  InMemoryGenerationLedger
} from '../src/shared/controlPlane/index.js';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  WorkerSupervisor,
  type EmulatorEvent,
  type EmulatorPort
} from '../src/shared/runtime/index.js';
import { SessionManager } from '../src/server/runtime/sessionManager.js';

/**
 * The one injected failure in this file: `writeSync` refuses while the flag is
 * on. This is the ENOSPC/EBADF the store already claims to survive — the point
 * is what the store believes about the DISK afterwards, which no amount of
 * real-filesystem setup can provoke deterministically once the append fd is
 * already open.
 */
const writeFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: real,
    writeSync: (...args: Parameters<typeof real.writeSync>): number => {
      if (writeFailure.enabled) {
        const error: NodeJS.ErrnoException = new Error(
          'ENOSPC: no space left on device, write'
        );
        error.code = 'ENOSPC';
        throw error;
      }
      return real.writeSync(...args);
    }
  };
});

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'desk-geometry-')), 'session-geometry.ndjson');
}

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
}

/** The records the log actually carries, decoded — never matched as raw text. */
function records(path: string): Array<{ s: string; c: number; r: number }> {
  return lines(path).map((line) => JSON.parse(line) as { s: string; c: number; r: number });
}

/** Every record the log carries for one session, oldest first. */
function recordsFor(path: string, sessionId: string): Array<{ rows: number; cols: number }> {
  return records(path)
    .filter((record) => record.s === sessionId)
    .map((record) => ({ rows: record.r, cols: record.c }));
}

class FakeEmu implements EmulatorPort {
  write(): void {}
  resize(): void {}
  readTailText(): string[] {
    return [];
  }
  serialize(): string {
    return '';
  }
  cursor(): { row: number; col: number } {
    return { row: 0, col: 0 };
  }
  onEvent(_cb: (e: EmulatorEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
}

function makeManager(geometry: FileSessionGeometryStore): SessionManager {
  return new SessionManager({
    ledger: new GenerationLedger(new InMemoryGenerationLedger()),
    supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 8 }),
    emulatorFactory: { create: () => new FakeEmu() },
    now: () => 1000,
    sendBrowser: () => {},
    sessionGeometry: geometry
  });
}

describe('the durable geometry log stays bounded (desk#62)', () => {
  it('compacts a drag-inflated history to one record per session, keeping the last size', () => {
    const path = storePath();

    // One session, dragged: 40 distinct sizes, so 40 records under the
    // append-on-change rule. Deliberately UNDER the online-compaction floor,
    // so what this test measures is the STARTUP compaction and nothing else.
    const first = new FileSessionGeometryStore(path);
    for (let cols = 80; cols < 120; cols += 1) {
      first.record('dragged', { rows: 48, cols });
    }
    first.close();
    expect(lines(path).length).toBe(40);

    // Restart: replay reconstructs the same last-wins map it always did, and
    // writes that map back instead of carrying 39 superseded records forever.
    const second = new FileSessionGeometryStore(path);
    expect(second.get('dragged')).toEqual({ rows: 48, cols: 119 });
    expect(lines(path).length).toBe(1);

    // And the compacted file is a real log, not a one-shot: it keeps appending.
    second.record('dragged', { rows: 50, cols: 300 });
    second.close();
    expect(new FileSessionGeometryStore(path).get('dragged')).toEqual({ rows: 50, cols: 300 });
  });

  it('leaves a log that is already lean untouched, so a restart is not a rewrite', () => {
    const path = storePath();
    const first = new FileSessionGeometryStore(path);
    first.record('a', { rows: 24, cols: 80 });
    first.record('b', { rows: 48, cols: 100 });
    first.close();
    const before = readFileSync(path, 'utf8');
    // Byte equality alone cannot tell "was not rewritten" from "was rewritten
    // to the same bytes" — compacting an already-lean log is a no-op on
    // content. The inode is what distinguishes them, because compaction
    // renames a new file over this one.
    const inodeBefore = statSync(path).ino;

    const second = new FileSessionGeometryStore(path);
    expect(second.get('a')).toEqual({ rows: 24, cols: 80 });
    expect(second.get('b')).toEqual({ rows: 48, cols: 100 });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(statSync(path).ino).toBe(inodeBefore);
  });

  it('rewrites the file itself when it does compact, so the saving is real', () => {
    // The mirror of the test above: when compaction IS warranted the log must
    // actually be replaced, not merely reported as replaced.
    const path = storePath();
    const first = new FileSessionGeometryStore(path);
    first.record('c', { rows: 24, cols: 80 });
    first.record('c', { rows: 48, cols: 100 });
    first.close();
    const inodeBefore = statSync(path).ino;

    const second = new FileSessionGeometryStore(path);
    expect(second.get('c')).toEqual({ rows: 48, cols: 100 });
    expect(lines(path).length).toBe(1);
    expect(statSync(path).ino).not.toBe(inodeBefore);
  });

  it('compacts many sessions without losing any of their last sizes', () => {
    const path = storePath();
    const first = new FileSessionGeometryStore(path);
    for (let round = 1; round <= 40; round += 1) {
      for (const id of ['s1', 's2', 's3']) {
        first.record(id, { rows: 20 + round, cols: 80 + round });
      }
    }
    first.close();

    const second = new FileSessionGeometryStore(path);
    expect(lines(path).length).toBe(3);
    for (const id of ['s1', 's2', 's3']) {
      expect(second.get(id)).toEqual({ rows: 60, cols: 120 });
    }
  });

  it('survives a torn tail while compacting, dropping only the unterminated record', () => {
    const path = storePath();
    const first = new FileSessionGeometryStore(path);
    // Under the online-compaction floor, so the log this hard kill tears is
    // the one the appends built — not one an online compaction already rewrote.
    for (let cols = 80; cols < 120; cols += 1) {
      first.record('torn', { rows: 48, cols });
    }
    first.close();
    // A hard kill mid-append: a record with no newline behind it.
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"s":"torn","c":999,"r":`, 'utf8');

    const second = new FileSessionGeometryStore(path);
    expect(second.get('torn')).toEqual({ rows: 48, cols: 119 });
    expect(lines(path).length).toBe(1);
  });
});

describe('the durable geometry log compacts WHILE it runs (desk#62)', () => {
  it('bounds a long-lived daemon’s log without waiting for a restart', () => {
    const path = storePath();
    // One session, dragged all afternoon: 400 distinct sizes in ONE daemon
    // incarnation. Startup compaction cannot help here — the daemon never
    // restarts — so an append-only log would carry all 400.
    const store = new FileSessionGeometryStore(path);
    for (let cols = 80; cols < 480; cols += 1) {
      store.record('dragged', { rows: 48, cols });
    }

    // One live record, so the bound is the floor: 64 appends between
    // compactions, leaving at most 1 compacted record + 64 appends behind it.
    expect(lines(path).length).toBeLessThanOrEqual(65);
    // And it is still a log, not a truncation: the newest size is on disk and
    // last-wins replay reads exactly it, not some size the compaction froze.
    expect(recordsFor(path, 'dragged').at(-1)).toEqual({ rows: 48, cols: 479 });
    expect(store.get('dragged')).toEqual({ rows: 48, cols: 479 });

    // The live append handle must still point at the file the compaction left
    // behind — a stale fd would append into an unlinked inode and lose this.
    store.record('dragged', { rows: 50, cols: 500 });
    store.close();
    expect(new FileSessionGeometryStore(path).get('dragged')).toEqual({ rows: 50, cols: 500 });
  });

  it('scales the threshold with the live set, so a large fleet is not compacted constantly', () => {
    const path = storePath();
    const store = new FileSessionGeometryStore(path);
    // 50 live sessions, two sizes each: 100 appends. The threshold is relative
    // (4 x 50 = 200), so NOTHING has been compacted yet and all 100 records
    // stand. A bare 64-append constant would already have rewritten the file.
    for (let round = 0; round < 2; round += 1) {
      for (let session = 0; session < 50; session += 1) {
        store.record(`s${session}`, { rows: 24 + round, cols: 80 + round });
      }
    }
    expect(lines(path).length).toBe(100);
    store.close();
  });
});

describe('a failed append leaves the durable record able to catch up (desk#62)', () => {
  it('re-writes an unchanged geometry after a failed append instead of deduping it away forever', () => {
    const path = storePath();
    const store = new FileSessionGeometryStore(path);
    store.record('caught-up', { rows: 24, cols: 80 });
    expect(recordsFor(path, 'caught-up')).toEqual([{ rows: 24, cols: 80 }]);

    // The state root fills up mid-resize. The live session must not notice...
    writeFailure.enabled = true;
    try {
      store.record('caught-up', { rows: 48, cols: 120 });
    } finally {
      writeFailure.enabled = false;
    }
    expect(store.get('caught-up')).toEqual({ rows: 48, cols: 120 });
    // ...but the disk did NOT get it, and must not be told it did.
    expect(recordsFor(path, 'caught-up')).toEqual([{ rows: 24, cols: 80 }]);

    // Space is back. The very next record for this session — the SAME geometry
    // the failed append carried — has to reach the disk. Deduping against
    // in-memory truth here is what strands the record at 24x80 forever.
    store.record('caught-up', { rows: 48, cols: 120 });
    expect(recordsFor(path, 'caught-up')).toEqual([
      { rows: 24, cols: 80 },
      { rows: 48, cols: 120 }
    ]);

    // And now that the disk HAS it, the dedupe resumes: an unchanged geometry
    // is not appended again, or every applied resize would cost a write.
    store.record('caught-up', { rows: 48, cols: 120 });
    expect(recordsFor(path, 'caught-up')).toEqual([
      { rows: 24, cols: 80 },
      { rows: 48, cols: 120 }
    ]);

    store.close();
    expect(new FileSessionGeometryStore(path).get('caught-up')).toEqual({ rows: 48, cols: 120 });
  });

  it('does not let one session’s failed append force re-writes for another', () => {
    const path = storePath();
    const store = new FileSessionGeometryStore(path);
    store.record('unlucky', { rows: 24, cols: 80 });
    store.record('lucky', { rows: 30, cols: 90 });

    writeFailure.enabled = true;
    try {
      store.record('unlucky', { rows: 48, cols: 120 });
    } finally {
      writeFailure.enabled = false;
    }

    // 'lucky' never lost a write, so its unchanged geometry is still deduped.
    store.record('lucky', { rows: 30, cols: 90 });
    expect(recordsFor(path, 'lucky')).toEqual([{ rows: 30, cols: 90 }]);
    store.close();
  });
});

describe('a retired session leaves the durable record (desk#62)', () => {
  it('forgets a session, dropping its record from the log and keeping the others', () => {
    const path = storePath();
    const store = new FileSessionGeometryStore(path);
    store.record('gone', { rows: 24, cols: 80 });
    store.record('stays', { rows: 48, cols: 120 });

    store.forget('gone');

    expect(store.get('gone')).toBeUndefined();
    expect(store.get('stays')).toEqual({ rows: 48, cols: 120 });
    expect(recordsFor(path, 'gone')).toEqual([]);
    expect(recordsFor(path, 'stays')).toEqual([{ rows: 48, cols: 120 }]);

    // Durably gone: a restart must not resurrect it from the history.
    store.close();
    const reopened = new FileSessionGeometryStore(path);
    expect(reopened.get('gone')).toBeUndefined();
    expect(reopened.get('stays')).toEqual({ rows: 48, cols: 120 });
    reopened.close();
  });

  it('keeps appending after a forget, so the live handle survives the rewrite', () => {
    const path = storePath();
    const store = new FileSessionGeometryStore(path);
    store.record('gone', { rows: 24, cols: 80 });
    store.record('stays', { rows: 48, cols: 120 });
    store.forget('gone');
    store.record('stays', { rows: 60, cols: 200 });
    store.close();
    expect(new FileSessionGeometryStore(path).get('stays')).toEqual({ rows: 60, cols: 200 });
  });

  it('forgets a session the process-local store never persisted, too', () => {
    const store = new InMemorySessionGeometryStore();
    store.record('gone', { rows: 24, cols: 80 });
    store.record('stays', { rows: 48, cols: 120 });
    store.forget('gone');
    expect(store.get('gone')).toBeUndefined();
    expect(store.get('stays')).toEqual({ rows: 48, cols: 120 });
  });

  it('leaves an unknown session alone rather than rewriting the log for nothing', () => {
    const path = storePath();
    const store = new FileSessionGeometryStore(path);
    store.record('stays', { rows: 48, cols: 120 });
    const inodeBefore = statSync(path).ino;
    store.forget('never-existed');
    expect(statSync(path).ino).toBe(inodeBefore);
    expect(recordsFor(path, 'stays')).toEqual([{ rows: 48, cols: 120 }]);
    store.close();
  });

  it('a retire forgets the session’s remembered size', () => {
    const path = storePath();
    const store = new FileSessionGeometryStore(path);
    const manager = makeManager(store);
    expect(manager.ensure('retired', { rows: 48, cols: 120 }).ok).toBe(true);
    expect(recordsFor(path, 'retired')).toEqual([{ rows: 48, cols: 120 }]);

    manager.retire('retired', 'control-retire');

    expect(store.get('retired')).toBeUndefined();
    expect(recordsFor(path, 'retired')).toEqual([]);
    store.close();
    expect(new FileSessionGeometryStore(path).get('retired')).toBeUndefined();
  });

  it('a daemon departure does NOT forget: the holder survives and keeps its size', () => {
    const path = storePath();
    const store = new FileSessionGeometryStore(path);
    const manager = makeManager(store);
    expect(manager.ensure('survivor', { rows: 48, cols: 120 }).ok).toBe(true);

    // closeAllLinks is the shutdown detach: links close WITHOUT retiring,
    // because the moor holders outlive this daemon. Forgetting here would
    // destroy the exact knowledge the next incarnation needs.
    manager.closeAllLinks();

    expect(store.get('survivor')).toEqual({ rows: 48, cols: 120 });
    expect(recordsFor(path, 'survivor')).toEqual([{ rows: 48, cols: 120 }]);
    store.close();
    expect(new FileSessionGeometryStore(path).get('survivor')).toEqual({ rows: 48, cols: 120 });
  });
});

describe('the durable geometry record is typed before it is trusted (desk#62)', () => {
  it('refuses a record whose dimensions are strings rather than numbers', () => {
    const path = storePath();
    writeFileSync(path, '{"s":"stringly","c":"100","r":"48"}\n', 'utf8');

    // A string that coerces to a valid integer is still not a measured
    // geometry: the session is unmeasured, and unmeasured is the honest answer.
    expect(new FileSessionGeometryStore(path).get('stringly')).toBeUndefined();
  });

  it('refuses a record whose dimensions are booleans', () => {
    const path = storePath();
    writeFileSync(path, '{"s":"booleanly","c":true,"r":true}\n', 'utf8');
    expect(new FileSessionGeometryStore(path).get('booleanly')).toBeUndefined();
  });

  it('still accepts a well-formed numeric record', () => {
    const path = storePath();
    writeFileSync(path, '{"s":"honest","c":100,"r":48}\n', 'utf8');
    expect(new FileSessionGeometryStore(path).get('honest')).toEqual({ rows: 48, cols: 100 });
  });

  it('drops one unreadable record without losing the readable ones around it', () => {
    const path = storePath();
    writeFileSync(
      path,
      '{"s":"before","c":90,"r":30}\nnot json at all\n{"s":"after","c":110,"r":40}\n',
      'utf8'
    );
    const store = new FileSessionGeometryStore(path);
    expect(store.get('before')).toEqual({ rows: 30, cols: 90 });
    expect(store.get('after')).toEqual({ rows: 40, cols: 110 });
  });
});
