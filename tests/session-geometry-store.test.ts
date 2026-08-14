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

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSessionGeometryStore } from '../src/server/runtime/fileSessionGeometryStore.js';

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'desk-geometry-')), 'session-geometry.ndjson');
}

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
}

describe('the durable geometry log stays bounded (desk#62)', () => {
  it('compacts a drag-inflated history to one record per session, keeping the last size', () => {
    const path = storePath();

    // One session, dragged: 200 distinct sizes, so 200 records under the
    // append-on-change rule. This is a single afternoon, not a pathological case.
    const first = new FileSessionGeometryStore(path);
    for (let cols = 80; cols < 280; cols += 1) {
      first.record('dragged', { rows: 48, cols });
    }
    first.close();
    expect(lines(path).length).toBe(200);

    // Restart: replay reconstructs the same last-wins map it always did, and
    // writes that map back instead of carrying 199 superseded records forever.
    const second = new FileSessionGeometryStore(path);
    expect(second.get('dragged')).toEqual({ rows: 48, cols: 279 });
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

    const second = new FileSessionGeometryStore(path);
    expect(second.get('a')).toEqual({ rows: 24, cols: 80 });
    expect(second.get('b')).toEqual({ rows: 48, cols: 100 });
    expect(readFileSync(path, 'utf8')).toBe(before);
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
    for (let cols = 80; cols < 200; cols += 1) {
      first.record('torn', { rows: 48, cols });
    }
    first.close();
    // A hard kill mid-append: a record with no newline behind it.
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"s":"torn","c":999,"r":`, 'utf8');

    const second = new FileSessionGeometryStore(path);
    expect(second.get('torn')).toEqual({ rows: 48, cols: 199 });
    expect(lines(path).length).toBe(1);
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
