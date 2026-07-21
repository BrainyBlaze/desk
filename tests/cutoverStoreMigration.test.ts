// Cutover paused-store migration executor (§10 Phase 2 Step 2). Drives the pure
// transform over real files in temp dirs: source stays read-only, target gets
// the version-2 sessionId-keyed store, gone sessions are reported, malformed
// input fails closed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migratePausedStoreFile } from '../src/server/cutoverStoreMigration.js';

describe('cutover store migration — paused store (§10)', () => {
  let src: string;
  let dst: string;
  const map = new Map<string, string>([
    ['tmux-a', 'claude'],
    ['tmux-b', 'server']
  ]);

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'desk-cutover-src-'));
    dst = mkdtempSync(join(tmpdir(), 'desk-cutover-dst-'));
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  });

  const writeLegacy = (items: unknown[]): void => {
    mkdirSync(join(src, '_engine'), { recursive: true });
    writeFileSync(join(src, '_engine', 'paused.json'), JSON.stringify({ version: 1, items }));
  };
  const readTarget = (): { version: number; items: unknown[] } =>
    JSON.parse(readFileSync(join(dst, '_engine', 'paused.json'), 'utf8'));

  it('re-keys the paused store to sessionId (version 2) and leaves the source read-only', () => {
    writeLegacy([
      { tmuxSession: 'tmux-a', pausedAt: '2026-07-21T00:00:00.000Z', reason: 'sensitive' },
      { tmuxSession: 'tmux-b', pausedAt: '2026-07-21T01:00:00.000Z' }
    ]);
    const report = migratePausedStoreFile(src, dst, map);
    expect(report.migrated).toEqual([
      { sessionId: 'claude', pausedAt: '2026-07-21T00:00:00.000Z', reason: 'sensitive' },
      { sessionId: 'server', pausedAt: '2026-07-21T01:00:00.000Z' }
    ]);
    expect(report.dropped).toEqual([]);
    const target = readTarget();
    expect(target.version).toBe(2);
    expect(target.items).toEqual(report.migrated);
    // Source is untouched: still version 1, still tmuxSession-keyed.
    const source = JSON.parse(readFileSync(join(src, '_engine', 'paused.json'), 'utf8'));
    expect(source.version).toBe(1);
    expect((source.items[0] as { tmuxSession: string }).tmuxSession).toBe('tmux-a');
  });

  it('reports (never silently drops) a pause whose session is gone from the map', () => {
    writeLegacy([{ tmuxSession: 'tmux-ghost', pausedAt: '2026-07-21T00:00:00.000Z' }]);
    const report = migratePausedStoreFile(src, dst, map);
    expect(report.migrated).toEqual([]);
    expect(report.dropped).toEqual([{ tmuxSession: 'tmux-ghost', pausedAt: '2026-07-21T00:00:00.000Z' }]);
  });

  it('a missing source store migrates to an empty version-2 target', () => {
    const report = migratePausedStoreFile(src, dst, map);
    expect(report.migrated).toEqual([]);
    expect(readTarget()).toEqual({ version: 2, items: [] });
  });

  it('a malformed source store throws (fail-closed, never a partial migrate)', () => {
    mkdirSync(join(src, '_engine'), { recursive: true });
    writeFileSync(join(src, '_engine', 'paused.json'), JSON.stringify({ items: 'not-an-array' }));
    expect(() => migratePausedStoreFile(src, dst, map)).toThrow(/fail-closed/);
  });
});
