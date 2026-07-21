// Cutover paused-store migration executor (§10 Phase 2 Step 2). Drives the pure
// transform over real files in temp dirs: source stays read-only, target gets
// the version-2 sessionId-keyed store, gone sessions are reported, malformed
// input fails closed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateManifestToCanary, migratePausedStoreFile, planDurabilityMigration } from '../src/server/cutoverStoreMigration.js';
import { readManifestFile, writeManifestFile } from '../src/core/config.js';
import type { DeskManifest } from '../src/core/types.js';

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

describe('cutover store migration — canary manifest write (§10)', () => {
  let src: string;
  let dst: string;
  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'desk-cutover-msrc-'));
    dst = mkdtempSync(join(tmpdir(), 'desk-cutover-mdst-'));
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  });

  it('persists a sessionId-bearing manifest to the canary root, leaving the source read-only', () => {
    const srcPath = join(src, 'desk.yml');
    const dstPath = join(dst, 'canary-desk.yml');
    const legacy: DeskManifest = {
      groups: [
        {
          id: 'g1',
          sessions: [
            { name: 'Claude', tmuxSession: 'tmux-a', cwd: '/w', agent: 'claude' },
            { name: 'Server', tmuxSession: 'tmux-b', cwd: '/w', command: 'bash' }
          ]
        }
      ]
    };
    writeManifestFile(srcPath, legacy);

    const report = migrateManifestToCanary(srcPath, dstPath);
    expect(report.sessions).toBe(2);

    // Target carries the minted ids; the round-trip is verified inside the executor.
    const target = readManifestFile(dstPath);
    expect(target.groups[0].sessions.map((s) => s.sessionId)).toEqual(['claude', 'server']);

    // Source manifest is untouched (no sessionId written back).
    const source = readManifestFile(srcPath);
    expect(source.groups[0].sessions[0].sessionId).toBeUndefined();
  });
});

describe('cutover store migration — durability plan (§10 Option B)', () => {
  let src: string;
  const map = new Map<string, string>([['tmux-a', 'claude']]);
  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'desk-cutover-dur-'));
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
  });

  const writeItem = (tmux: string, seq: number, ext: string, content: string): void => {
    const dir = join(src, '_engine', 'queue', tmux);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${String(seq).padStart(10, '0')}.${ext}`), content);
  };

  it('re-keys + repairs each item and preserves its body, reporting drops and unreadable', () => {
    writeItem('tmux-a', 1, 'json', JSON.stringify({ prompt: 'a1' }));
    writeItem('tmux-a', 2, 'delivered', JSON.stringify({ prompt: 'a2' }));
    writeItem('tmux-a', 3, 'delivering', JSON.stringify({ prompt: 'a3' }));
    writeItem('tmux-a', 4, 'json', 'not-json'); // unreadable body
    writeItem('tmux-ghost', 1, 'json', JSON.stringify({ prompt: 'g' })); // unmapped session

    const plan = planDurabilityMigration(src, map, false);
    const bySeq = new Map(plan.items.map((i) => [i.seq, i]));
    expect(bySeq.get(1)?.sessionId).toBe('claude');
    expect(bySeq.get(1)?.outcome.phase).toBe('queued');
    expect(bySeq.get(1)?.body).toEqual({ prompt: 'a1' });
    expect(bySeq.get(2)?.outcome.phase).toBe('semantic-unknown'); // .delivered held, never done
    expect(bySeq.get(3)?.outcome.phase).toBe('queued');
    expect(bySeq.get(3)?.outcome.reissue).toBe(true); // delivering → re-deliver
    expect(plan.dropped).toEqual([{ tmuxSession: 'tmux-ghost', seq: 1, ext: 'json' }]);
    expect(plan.unreadable).toEqual([{ tmuxSession: 'tmux-a', seq: 4, ext: 'json' }]);
    expect(plan.skippedByDrain).toBe(false);
  });

  it('a fully-drained queue plans nothing', () => {
    writeItem('tmux-a', 1, 'json', JSON.stringify({ prompt: 'a1' }));
    const plan = planDurabilityMigration(src, map, true);
    expect(plan.skippedByDrain).toBe(true);
    expect(plan.items).toEqual([]);
  });
});
