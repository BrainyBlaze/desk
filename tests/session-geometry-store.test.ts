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
//    are strings validated as commanded knowledge. The file is ours today, but
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

function noSpace(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('ENOSPC: no space left on device, write');
  error.code = 'ENOSPC';
  return error;
}

/**
 * Two injected failures in this file, each a full state root refusing a write.
 *
 * `writeFailure` refuses the APPEND — the ENOSPC/EBADF the store already claims
 * to survive. `compactFailure` refuses the COMPACTION's scratch write, and
 * counts the attempts so a test can prove a compaction was actually reached
 * rather than assume it. Neither is reachable from a real filesystem once the
 * append fd is open, which is exactly why they are injected.
 */
const writeFailure = vi.hoisted(() => ({
  enabled: false,
  shortBytes: 0,
  failAfterShort: false,
  calls: 0
}));
const compactFailure = vi.hoisted(() => ({ enabled: false, refused: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: real,
    writeSync: (...args: Parameters<typeof real.writeSync>): number => {
      if (writeFailure.enabled) throw noSpace();
      if (writeFailure.shortBytes > 0) {
        writeFailure.calls += 1;
        if (writeFailure.calls === 1) {
          const [fd, data] = args;
          if (typeof data === 'string') {
            return real.writeSync(fd, data.slice(0, writeFailure.shortBytes));
          }
          const offset = typeof args[2] === 'number' ? args[2] : 0;
          const length = typeof args[3] === 'number' ? args[3] : data.byteLength - offset;
          return real.writeSync(fd, data, offset, Math.min(writeFailure.shortBytes, length));
        }
        if (writeFailure.failAfterShort && writeFailure.calls === 2) throw noSpace();
      }
      return real.writeSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>): void => {
      // Only the compaction's scratch file — never a test's own fixture write.
      const target = args[0];
      if (compactFailure.enabled && typeof target === 'string' && target.endsWith('.compact')) {
        compactFailure.refused += 1;
        throw noSpace();
      }
      real.writeFileSync(...args);
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

function resetWriteFailure(): void {
  writeFailure.enabled = false;
  writeFailure.shortBytes = 0;
  writeFailure.failAfterShort = false;
  writeFailure.calls = 0;
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

  it('does not re-append, after a restart, a geometry the log already carries', () => {
    const path = storePath();
    const first = new FileSessionGeometryStore(path);
    first.record('a', { rows: 24, cols: 80 });
    first.record('b', { rows: 48, cols: 120 });
    first.close();

    // Reopened on a log that replay proved is already one record per session:
    // the file IS the map, so the store knows those geometries are on disk and
    // an unchanged one costs no write. Without that seeding, every daemon
    // start pays one redundant record per session it re-measures.
    const second = new FileSessionGeometryStore(path);
    second.record('a', { rows: 24, cols: 80 });
    second.record('b', { rows: 48, cols: 120 });
    second.close();

    expect(recordsFor(path, 'a')).toEqual([{ rows: 24, cols: 80 }]);
    expect(recordsFor(path, 'b')).toEqual([{ rows: 48, cols: 120 }]);
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
  it('finishes a short append before marking the geometry persisted', () => {
    const path = storePath();
    const store = new FileSessionGeometryStore(path);
    const expected = `${JSON.stringify({ s: 'short-write', c: 120, r: 48 })}\n`;

    writeFailure.shortBytes = 7;
    try {
      store.record('short-write', { rows: 48, cols: 120 });
      expect(writeFailure.calls).toBe(2);
    } finally {
      resetWriteFailure();
    }

    // A second observation of the same geometry is deduped only because the
    // first append reached its newline-terminated boundary in full.
    store.record('short-write', { rows: 48, cols: 120 });
    expect(readFileSync(path, 'utf8')).toBe(expected);
    store.close();
    const restored = new FileSessionGeometryStore(path);
    expect(restored.get('short-write')).toEqual({ rows: 48, cols: 120 });
    restored.close();
  });

  it('rolls back a partial append before retrying after the next write fails', () => {
    const path = storePath();
    const store = new FileSessionGeometryStore(path);
    const original = `${JSON.stringify({ s: 'rolled-back', c: 80, r: 24 })}\n`;
    store.record('rolled-back', { rows: 24, cols: 80 });

    writeFailure.shortBytes = 9;
    writeFailure.failAfterShort = true;
    try {
      store.record('rolled-back', { rows: 48, cols: 120 });
      expect(writeFailure.calls).toBe(2);
    } finally {
      resetWriteFailure();
    }

    // The partial JSON tail cannot remain in front of the retry: replay would
    // otherwise discard both it and the valid record appended behind it.
    expect(readFileSync(path, 'utf8')).toBe(original);
    store.record('rolled-back', { rows: 48, cols: 120 });
    expect(recordsFor(path, 'rolled-back')).toEqual([
      { rows: 24, cols: 80 },
      { rows: 48, cols: 120 }
    ]);
    store.close();
    const restored = new FileSessionGeometryStore(path);
    expect(restored.get('rolled-back')).toEqual({ rows: 48, cols: 120 });
    restored.close();
  });

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

  it('a FAILED compaction does not claim the pending geometry reached the disk', () => {
    // The compound case, and the only door left open into the original defect.
    // A compaction writes the whole in-memory map, so a SUCCESSFUL one heals a
    // session whose append was lost. A FAILED one heals nothing — and if it
    // marks the map persisted anyway, the dedupe is poisoned exactly as it was
    // before this fix, only reached through compaction instead of append.
    const path = storePath();
    const store = new FileSessionGeometryStore(path);
    store.record('pending', { rows: 24, cols: 80 });

    // Step 1: the append for 'pending' is lost. The catch-up is now armed.
    writeFailure.enabled = true;
    try {
      store.record('pending', { rows: 48, cols: 120 });
    } finally {
      writeFailure.enabled = false;
    }
    expect(recordsFor(path, 'pending')).toEqual([{ rows: 24, cols: 80 }]);

    // Step 2: drive a second session past the compaction threshold while the
    // scratch write is refused, so a compaction is REACHED and fails.
    compactFailure.enabled = true;
    compactFailure.refused = 0;
    try {
      for (let cols = 80; cols < 150; cols += 1) {
        store.record('busy', { rows: 24, cols });
      }
      // Substance before shape: without a reached compaction this test proves
      // nothing at all, so the attempt itself is asserted, not assumed.
      expect(compactFailure.refused).toBeGreaterThan(0);

      // The rewrite failed, so the disk never got 48x120 — and the store must
      // not believe otherwise.
      expect(recordsFor(path, 'pending')).toEqual([{ rows: 24, cols: 80 }]);
      expect(store.get('pending')).toEqual({ rows: 48, cols: 120 });

      // The catch-up must still fire: the same geometry, appended once, now
      // that the append path works again.
      store.record('pending', { rows: 48, cols: 120 });
      expect(recordsFor(path, 'pending')).toEqual([
        { rows: 24, cols: 80 },
        { rows: 48, cols: 120 }
      ]);
    } finally {
      compactFailure.enabled = false;
    }

    store.close();
    expect(new FileSessionGeometryStore(path).get('pending')).toEqual({ rows: 48, cols: 120 });
  });

  it('a SUCCESSFUL compaction heals a lost append, and does not then re-write it', () => {
    // The mirror of the test above: the compaction's rewrite carries the whole
    // in-memory map, so it legitimately puts the lost geometry on disk — and
    // once it has, the dedupe must go quiet again.
    const path = storePath();
    const store = new FileSessionGeometryStore(path);
    store.record('pending', { rows: 24, cols: 80 });

    writeFailure.enabled = true;
    try {
      store.record('pending', { rows: 48, cols: 120 });
    } finally {
      writeFailure.enabled = false;
    }

    for (let cols = 80; cols < 150; cols += 1) {
      store.record('busy', { rows: 24, cols });
    }

    // The compaction wrote `commanded`, which carries the geometry the append
    // lost — so the record is on disk exactly once, without a catch-up append.
    expect(recordsFor(path, 'pending')).toEqual([{ rows: 48, cols: 120 }]);
    store.record('pending', { rows: 48, cols: 120 });
    expect(recordsFor(path, 'pending')).toEqual([{ rows: 48, cols: 120 }]);
    store.close();
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

    // A string that coerces to a valid integer is still not a commanded
    // geometry: the session has no record, and no record is the honest answer.
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
