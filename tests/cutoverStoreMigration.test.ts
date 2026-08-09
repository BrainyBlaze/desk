// Cutover paused-store migration executor (§10 Phase 2 Step 2). Drives the pure
// transform over real files in temp dirs: source stays read-only, target gets
// the version-2 sessionId-keyed store, gone sessions are reported, malformed
// input fails closed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSeedCommitted,
  markSeedCommitted,
  migrateManifestToCanary,
  migratePausedStoreFile,
  ensureProductionCutoverMigration,
  partitionSeedForDelivery,
  planDurabilityMigration,
  readLegacyManifestFile,
  readSeedJournalForConsumption,
  runCanaryMigration,
  writeDurabilitySeedJournal
} from '../src/server/cutoverStoreMigration.js';
import { readManifestFile, writeManifestFile } from '../src/core/config.js';
import type { LegacyDeskManifest } from '../src/core/sessionIdentity.js';

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
    const legacy: LegacyDeskManifest = {
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
    const source = readLegacyManifestFile(srcPath);
    expect(source.groups[0].sessions[0].sessionId).toBeUndefined();
  });
});

describe('cutover store migration — durability plan (§10 Option B)', () => {
  let src: string;
  let dst: string;
  const map = new Map<string, string>([['tmux-a', 'claude']]);
  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'desk-cutover-dur-'));
    dst = mkdtempSync(join(tmpdir(), 'desk-cutover-durdst-'));
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
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

  const journalPath = (): string => join(dst, '_engine', 'migration', 'seed-journal.json');
  const readJournal = (): any => JSON.parse(readFileSync(journalPath(), 'utf8'));

  it('writes an atomic sessionId+seq journal with re-keyed bodies, committed=false', () => {
    writeItem('tmux-a', 2, 'json', JSON.stringify({ prompt: 'a2' }));
    writeItem('tmux-a', 1, 'delivered', JSON.stringify({ prompt: 'a1' }));
    const plan = planDurabilityMigration(src, map, false);
    const report = writeDurabilitySeedJournal(plan, dst);
    expect(report).toEqual({ written: 2, droppedAck: 0, alreadyCommitted: false });
    const journal = readJournal();
    expect(journal.version).toBe(1);
    expect(journal.committed).toBe(false);
    // Deterministic order: sessionId then seq.
    expect(journal.items).toEqual([
      { sessionId: 'claude', seq: 1, phase: 'semantic-unknown', reissue: false },
      { sessionId: 'claude', seq: 2, phase: 'queued', reissue: false }
    ]);
    // Raw bodies re-keyed to a separate sessionId-keyed location.
    expect(JSON.parse(readFileSync(join(dst, '_engine', 'migration', 'bodies', 'claude', '0000000001.json'), 'utf8'))).toEqual({ prompt: 'a1' });
  });

  it('is byte-stable across idempotent rewrites (deterministic ordering)', () => {
    writeItem('tmux-a', 3, 'json', JSON.stringify({ prompt: 'c' }));
    writeItem('tmux-a', 1, 'json', JSON.stringify({ prompt: 'a' }));
    const plan = planDurabilityMigration(src, map, false);
    writeDurabilitySeedJournal(plan, dst);
    const first = readFileSync(journalPath(), 'utf8');
    writeDurabilitySeedJournal(plan, dst);
    expect(readFileSync(journalPath(), 'utf8')).toBe(first);
  });

  it('respects a committed marker (idempotent: leaves a consumed seed untouched)', () => {
    writeItem('tmux-a', 1, 'json', JSON.stringify({ prompt: 'a' }));
    const plan = planDurabilityMigration(src, map, false);
    mkdirSync(join(dst, '_engine', 'migration'), { recursive: true });
    writeFileSync(join(dst, '_engine', 'migration', 'seed-journal.committed'), 'done');
    const report = writeDurabilitySeedJournal(plan, dst);
    expect(report.alreadyCommitted).toBe(true);
    expect(existsSync(journalPath())).toBe(false); // untouched — engine already seeded
  });

  it('fails closed on unreadable bodies unless explicitly acknowledged', () => {
    writeItem('tmux-a', 1, 'json', JSON.stringify({ prompt: 'a' }));
    writeItem('tmux-a', 2, 'json', 'corrupt'); // unreadable
    const plan = planDurabilityMigration(src, map, false);
    expect(() => writeDurabilitySeedJournal(plan, dst)).toThrow(/unreadable/);
    const report = writeDurabilitySeedJournal(plan, dst, { acknowledgeUnreadable: true });
    expect(report.written).toBe(1);
  });

  it('fails closed on unmapped-session drops unless explicitly acknowledged', () => {
    writeItem('tmux-ghost', 1, 'json', JSON.stringify({ prompt: 'g' }));
    const plan = planDurabilityMigration(src, map, false);
    expect(() => writeDurabilitySeedJournal(plan, dst)).toThrow(/dropped/);
    const report = writeDurabilitySeedJournal(plan, dst, { acknowledgeDropped: true });
    expect(report).toMatchObject({ written: 0, droppedAck: 1 });
  });

  it('reads + validates the seed journal for consumption, resolving bodies', () => {
    writeItem('tmux-a', 1, 'json', JSON.stringify({ prompt: 'a1' }));
    writeItem('tmux-a', 2, 'delivered', JSON.stringify({ prompt: 'a2' }));
    writeDurabilitySeedJournal(planDurabilityMigration(src, map, false), dst);
    const seed = readSeedJournalForConsumption(dst);
    expect(seed?.items.map((i) => [i.sessionId, i.seq, i.phase, i.body])).toEqual([
      ['claude', 1, 'queued', { prompt: 'a1' }],
      ['claude', 2, 'semantic-unknown', { prompt: 'a2' }]
    ]);
  });

  it('returns null when no seed journal is present', () => {
    expect(readSeedJournalForConsumption(dst)).toBeNull();
  });

  it('the committed marker is the durable commit truth', () => {
    writeItem('tmux-a', 1, 'json', JSON.stringify({ prompt: 'a1' }));
    writeDurabilitySeedJournal(planDurabilityMigration(src, map, false), dst);
    expect(isSeedCommitted(dst)).toBe(false);
    markSeedCommitted(dst);
    expect(isSeedCommitted(dst)).toBe(true);
  });

  it('fails closed on a missing body', () => {
    writeItem('tmux-a', 1, 'json', JSON.stringify({ prompt: 'a1' }));
    writeDurabilitySeedJournal(planDurabilityMigration(src, map, false), dst);
    rmSync(join(dst, '_engine', 'migration', 'bodies', 'claude', '0000000001.json'), { force: true });
    expect(() => readSeedJournalForConsumption(dst)).toThrow(/missing body/);
  });

  const seedThenTamper = (mutate: (j: any) => void): void => {
    writeItem('tmux-a', 1, 'json', JSON.stringify({ prompt: 'a' }));
    writeDurabilitySeedJournal(planDurabilityMigration(src, map, false), dst);
    const p = join(dst, '_engine', 'migration', 'seed-journal.json');
    const j = JSON.parse(readFileSync(p, 'utf8'));
    mutate(j);
    writeFileSync(p, JSON.stringify(j));
  };

  it('rejects a journal committed flag that is not false (marker is the truth)', () => {
    seedThenTamper((j) => {
      j.committed = true;
    });
    expect(() => readSeedJournalForConsumption(dst)).toThrow(/committed/);
  });

  it('fails closed on an invalid sessionId (grammar / path traversal)', () => {
    seedThenTamper((j) => {
      j.items[0].sessionId = '../evil';
    });
    expect(() => readSeedJournalForConsumption(dst)).toThrow(/invalid sessionId/);
  });

  it('fails closed on a non-integer or negative seq', () => {
    seedThenTamper((j) => {
      j.items[0].seq = -3;
    });
    expect(() => readSeedJournalForConsumption(dst)).toThrow(/invalid seq/);
  });

  it('fails closed on an unknown phase', () => {
    seedThenTamper((j) => {
      j.items[0].phase = 'bogus';
    });
    expect(() => readSeedJournalForConsumption(dst)).toThrow(/unknown phase/);
  });

  it('fails closed on a malformed body (no prompt string)', () => {
    writeItem('tmux-a', 1, 'json', JSON.stringify({ prompt: 'a' }));
    writeDurabilitySeedJournal(planDurabilityMigration(src, map, false), dst);
    writeFileSync(join(dst, '_engine', 'migration', 'bodies', 'claude', '0000000001.json'), JSON.stringify({ notPrompt: 1 }));
    expect(() => readSeedJournalForConsumption(dst)).toThrow(/malformed body/);
  });

  it('partitions the seed for delivery: queued re-enqueue, semantic-unknown held', () => {
    writeItem('tmux-a', 1, 'json', JSON.stringify({ prompt: 'q' }));
    writeItem('tmux-a', 2, 'delivered', JSON.stringify({ prompt: 'h' }));
    writeDurabilitySeedJournal(planDurabilityMigration(src, map, false), dst);
    const seed = readSeedJournalForConsumption(dst);
    const plan = partitionSeedForDelivery(seed ?? { items: [] });
    expect(plan.enqueue.get('claude')?.map((b) => (b as { prompt: string }).prompt)).toEqual(['q']);
    expect(plan.held.get('claude')).toEqual([2]);
    expect(plan.confirmed.size).toBe(0);
  });
});

describe('cutover store migration — canary orchestrator (§10)', () => {
  let src: string;
  let target: string;
  let backup: string;
  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'desk-canary-src-'));
    target = mkdtempSync(join(tmpdir(), 'desk-canary-tgt-'));
    backup = mkdtempSync(join(tmpdir(), 'desk-canary-bak-'));
  });
  afterEach(() => {
    for (const d of [src, target, backup]) rmSync(d, { recursive: true, force: true });
  });

  const seed = (ghost = false): void => {
    const manifest: LegacyDeskManifest = { groups: [{ id: 'g1', sessions: [{ name: 'Claude', cwd: '/w', agent: 'claude', tmuxSession: 'tmux-a' }] }] };
    writeManifestFile(join(src, 'desk.yml'), manifest);
    mkdirSync(join(src, '_engine'), { recursive: true });
    writeFileSync(join(src, '_engine', 'paused.json'), JSON.stringify({ version: 1, items: [{ tmuxSession: 'tmux-a', pausedAt: '2026-07-21T00:00:00.000Z' }] }));
    const q = join(src, '_engine', 'queue', ghost ? 'tmux-ghost' : 'tmux-a');
    mkdirSync(q, { recursive: true });
    writeFileSync(join(q, '0000000001.json'), JSON.stringify({ prompt: 'hi' }));
  };
  const opts = () => ({
    sourceRoot: src,
    sourceManifestPath: join(src, 'desk.yml'),
    targetRoot: target,
    targetManifestPath: join(target, 'desk.yml'),
    backupRoot: backup
  });

  it('runs backup then transform then validate then commit to the canary, source read-only', () => {
    seed();
    const result = runCanaryMigration(opts());
    expect(result.phase).toBe('done');
    expect(result.rollback).toBe('none');
    expect(result.manifest?.sessions).toBe(1);
    expect(readManifestFile(join(target, 'desk.yml')).groups[0].sessions[0].sessionId).toBe('claude');
    expect(JSON.parse(readFileSync(join(target, '_engine', 'paused.json'), 'utf8')).items[0].sessionId).toBe('claude');
    expect(JSON.parse(readFileSync(join(target, '_engine', 'migration', 'seed-journal.json'), 'utf8')).items[0].sessionId).toBe('claude');
    expect(existsSync(join(target, '_engine', 'migration', 'migration.done'))).toBe(true);
    expect(existsSync(join(backup, 'desk.yml'))).toBe(true);
    expect(existsSync(join(backup, '_engine', 'paused.json'))).toBe(true);
    expect(readLegacyManifestFile(join(src, 'desk.yml')).groups[0].sessions[0].sessionId).toBeUndefined();
  });

  it('aborts at transform with restore-backup when an unmapped drop is not acknowledged', () => {
    seed(true);
    const result = runCanaryMigration(opts());
    expect(result.phase).toBe('aborted');
    expect(result.failedPhase).toBe('transform');
    expect(result.rollback).toBe('restore-backup');
    expect(existsSync(join(backup, 'desk.yml'))).toBe(true);
    expect(existsSync(join(target, '_engine', 'migration', 'migration.done'))).toBe(false);
  });

  it('fails closed on a non-empty target root (never merges onto stale state)', () => {
    seed();
    mkdirSync(join(target, 'stale'), { recursive: true });
    writeFileSync(join(target, 'stale', 'x'), 'old');
    const result = runCanaryMigration(opts());
    expect(result.phase).toBe('aborted');
    expect(result.failedPhase).toBe('backup');
    expect(result.error).toMatch(/must be empty/);
  });
});

describe('cutover store migration — production first-start gate (§10)', () => {
  let root: string;
  let manifestPath: string;
  let channelsRoot: string;
  let migrationRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'desk-production-cutover-'));
    manifestPath = join(root, '.config', 'desk', 'desk.yml');
    channelsRoot = join(root, '.config', 'desk', 'channels');
    migrationRoot = join(root, '.config', 'desk', '_migration', 'session-id-v1');
    mkdirSync(join(channelsRoot, '_engine', 'queue', 'tmux-a'), { recursive: true });
    mkdirSync(join(root, '.config', 'desk', 'tool-journal'), { recursive: true });
    writeFileSync(
      manifestPath,
      `groups:\n  - id: main\n    sessions:\n      - name: Claude\n        cwd: /workspace\n        agent: claude\n        tmuxSession: tmux-a\n`
    );
    writeFileSync(
      join(channelsRoot, '_engine', 'paused.json'),
      `${JSON.stringify({ version: 1, items: [{ tmuxSession: 'tmux-a', pausedAt: '2026-07-22T00:00:00.000Z' }] })}\n`
    );
    writeFileSync(join(channelsRoot, '_engine', 'queue', 'tmux-a', '0000000001.json'), JSON.stringify({ prompt: 'resume me' }));
    writeFileSync(
      join(channelsRoot, '_engine', 'events.jsonl'),
      `${JSON.stringify({ seq: 1, at: 'now', tmuxSession: 'tmux-a', kind: 'queued', channel: 'desk' })}\n`
    );
    mkdirSync(join(channelsRoot, 'desk', '_members'), { recursive: true });
    writeFileSync(
      join(channelsRoot, 'desk', '_members', 'claude.md'),
      '---\nname: claude\ntype: claude-cli\ntmux: tmux-a\nrole: implementer\n---\n'
    );
    writeFileSync(join(root, '.config', 'desk', 'tool-journal', 'tmux-a.jsonl'), '{}\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const migrate = (overrides: Record<string, unknown> = {}) =>
    ensureProductionCutoverMigration({
      homeDir: root,
      manifestPath,
      channelsRoot,
      migrationRoot,
      availableBytes: () => 1024n * 1024n * 1024n,
      ...overrides
    });

  const stageJournalWithLegacyResumeFingerprint = (): string => {
    const resumePath = join(root, '.config', 'desk', 'resume-captures.json');
    writeFileSync(
      resumePath,
      `${JSON.stringify({ version: 1, captures: [] })}\n`
    );
    expect(() =>
      migrate({
        afterPhase: (phase: string) => {
          if (phase === 'staged') throw new Error('simulated old-binary crash');
        }
      })
    ).toThrow(/simulated old-binary crash/);

    const journalPath = join(migrationRoot, 'journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      sourceFingerprint: Array<Record<string, unknown>>;
    };
    const stat = statSync(resumePath);
    const toolJournalIndex = journal.sourceFingerprint.findIndex(
      (entry) =>
        typeof entry.path === 'string' &&
        entry.path.startsWith(join(root, '.config', 'desk', 'tool-journal'))
    );
    expect(toolJournalIndex).toBeGreaterThanOrEqual(0);
    journal.sourceFingerprint.splice(toolJournalIndex, 0, {
      path: resumePath,
      kind: 'file',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino
    });
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    return resumePath;
  };

  it('refuses before staging when the legacy channels engine is live', () => {
    mkdirSync(join(channelsRoot, '_engine'), { recursive: true });
    writeFileSync(join(channelsRoot, '_engine', 'engine.pid'), '4242\n777\n');
    expect(() =>
      migrate({ processProbe: () => ({ alive: true, starttime: 777 }) })
    ).toThrow(/legacy channels engine.*active/);
    expect(existsSync(join(migrationRoot, 'stage'))).toBe(false);
    expect(existsSync(join(migrationRoot, 'migration.done'))).toBe(false);
  });

  it('stages, validates, selectively backs up, commits, and writes the marker last', () => {
    const phases: string[] = [];
    const result = migrate({ afterPhase: (phase: string) => phases.push(phase) });
    expect(result.status).toBe('migrated');
    expect(phases.at(-1)).toBe('done');

    const session = readManifestFile(manifestPath).groups[0].sessions[0];
    expect(session.sessionId).toBe('claude');
    expect('tmuxSession' in session).toBe(false);
    expect(JSON.parse(readFileSync(join(channelsRoot, '_engine', 'paused.json'), 'utf8')).items[0].sessionId).toBe('claude');
    expect(JSON.parse(readFileSync(join(channelsRoot, '_engine', 'migration', 'seed-journal.json'), 'utf8')).items[0].sessionId).toBe('claude');
    expect(JSON.parse(readFileSync(join(channelsRoot, '_engine', 'events.jsonl'), 'utf8'))).toMatchObject({ sessionId: 'claude' });
    expect(readFileSync(join(channelsRoot, 'desk', '_members', 'claude.md'), 'utf8')).toContain('session: claude');
    expect(existsSync(join(channelsRoot, '_engine', 'queue'))).toBe(false);
    expect(existsSync(join(root, '.config', 'desk', 'tool-journal'))).toBe(false);
    expect(existsSync(join(migrationRoot, 'backup', 'manifest', 'desk.yml'))).toBe(true);
    expect(existsSync(join(migrationRoot, 'backup', 'channels', '_engine', 'queue', 'tmux-a', '0000000001.json'))).toBe(true);
    expect(existsSync(join(migrationRoot, 'backup', 'channels', '_engine', 'events.jsonl'))).toBe(true);
    expect(existsSync(join(migrationRoot, 'backup', 'channels', 'desk', '_members', 'claude.md'))).toBe(true);
    expect(existsSync(join(migrationRoot, 'backup', 'tool-journal', 'tmux-a.jsonl'))).toBe(true);
    expect(existsSync(join(migrationRoot, 'migration.done'))).toBe(true);
  });

  it('reconstructs an unpinned v0.3.1 tmux identity before re-keying production stores', () => {
    const legacyTmuxSession = 'agentdesk-main-claude-3786bf33';
    writeFileSync(
      manifestPath,
      `groups:\n  - id: main\n    sessions:\n      - name: Claude\n        cwd: /workspace\n        agent: claude\n`
    );
    renameSync(
      join(channelsRoot, '_engine', 'queue', 'tmux-a'),
      join(channelsRoot, '_engine', 'queue', legacyTmuxSession)
    );
    renameSync(
      join(root, '.config', 'desk', 'tool-journal', 'tmux-a.jsonl'),
      join(root, '.config', 'desk', 'tool-journal', `${legacyTmuxSession}.jsonl`)
    );
    for (const path of [
      join(channelsRoot, '_engine', 'paused.json'),
      join(channelsRoot, '_engine', 'events.jsonl'),
      join(channelsRoot, 'desk', '_members', 'claude.md')
    ]) {
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('tmux-a', legacyTmuxSession));
    }

    expect(migrate().status).toBe('migrated');
    expect(JSON.parse(readFileSync(join(channelsRoot, '_engine', 'paused.json'), 'utf8')).items[0]).toMatchObject({
      sessionId: 'claude'
    });
    expect(JSON.parse(readFileSync(join(channelsRoot, '_engine', 'migration', 'seed-journal.json'), 'utf8')).items[0]).toMatchObject({
      sessionId: 'claude'
    });
    expect(existsSync(join(migrationRoot, 'backup', 'channels', '_engine', 'queue', legacyTmuxSession, '0000000001.json'))).toBe(true);
    expect(existsSync(join(migrationRoot, 'backup', 'tool-journal', `${legacyTmuxSession}.jsonl`))).toBe(true);
  });

  it('keeps the newest delivery-event ring while backing up complete legacy history', () => {
    const eventsPath = join(channelsRoot, '_engine', 'events.jsonl');
    const legacyLines = [
      '{ malformed legacy event',
      JSON.stringify({ seq: 2, at: 'old', tmuxSession: 'tmux-gone', kind: 'queued' }),
      ...Array.from({ length: 10_000 }, (_, index) =>
        JSON.stringify({
          seq: index + 3,
          at: 'now',
          tmuxSession: 'tmux-a',
          kind: 'queued',
          channel: 'desk'
        })
      )
    ];
    const legacyContent = `${legacyLines.join('\n')}\n`;
    writeFileSync(eventsPath, legacyContent);

    expect(migrate().status).toBe('migrated');

    const liveLines = readFileSync(eventsPath, 'utf8').trim().split('\n');
    expect(liveLines).toHaveLength(10_000);
    expect(JSON.parse(liveLines[0]!)).toMatchObject({ seq: 3, sessionId: 'claude' });
    expect(JSON.parse(liveLines.at(-1)!)).toMatchObject({ seq: 10_002, sessionId: 'claude' });
    expect(liveLines.every((line) => !line.includes('tmuxSession'))).toBe(true);
    expect(
      readFileSync(join(migrationRoot, 'backup', 'channels', '_engine', 'events.jsonl'), 'utf8')
    ).toBe(legacyContent);
  });

  it('fails before staging when free space cannot hold transformed output', () => {
    expect(() => migrate({ availableBytes: () => 0n })).toThrow(/free space/);
    expect(existsSync(join(migrationRoot, 'migration.done'))).toBe(false);
    expect(readLegacyManifestFile(manifestPath).groups[0].sessions[0].tmuxSession).toBe('tmux-a');
  });

  it('detects source mutation after transform and refuses to commit', () => {
    expect(() =>
      migrate({
        beforeSourceRecheck: () => writeFileSync(manifestPath, `${readFileSync(manifestPath, 'utf8')}# changed\n`)
      })
    ).toThrow(/source mutated/);
    expect(existsSync(join(migrationRoot, 'migration.done'))).toBe(false);
    expect(readLegacyManifestFile(manifestPath).groups[0].sessions[0].tmuxSession).toBe('tmux-a');
  });

  it('resumes from a durable staged journal and remains idempotent after commit', () => {
    expect(() =>
      migrate({ afterPhase: (phase: string) => { if (phase === 'staged') throw new Error('simulated crash'); } })
    ).toThrow(/simulated crash/);
    expect(existsSync(join(migrationRoot, 'migration.done'))).toBe(false);

    expect(migrate().status).toBe('migrated');
    expect(migrate().status).toBe('already-migrated');
    expect(readManifestFile(manifestPath).groups[0].sessions[0].sessionId).toBe('claude');
  });

  it('resumes a v1 staged journal whose fingerprint includes the retired resume capture store', () => {
    stageJournalWithLegacyResumeFingerprint();
    expect(migrate().status).toBe('migrated');
    expect(readManifestFile(manifestPath).groups[0].sessions[0].sessionId).toBe(
      'claude'
    );
  });

  it('rejects a v1 staged journal when the retired resume capture store mutated', () => {
    const resumePath = stageJournalWithLegacyResumeFingerprint();
    writeFileSync(resumePath, 'mutated after staging\n');

    expect(() => migrate()).toThrow(/source mutated after staging/);
    expect(existsSync(join(migrationRoot, 'migration.done'))).toBe(false);
  });

  it('accepts durable sessions added after the one-time migration', () => {
    expect(migrate().status).toBe('migrated');
    const manifest = readManifestFile(manifestPath);
    manifest.groups[0].sessions.push({
      name: 'Shell',
      cwd: '/workspace',
      command: 'bash',
      sessionId: 'shell'
    });
    writeManifestFile(manifestPath, manifest);

    expect(migrate()).toMatchObject({ status: 'already-migrated', sessions: 2 });
  });
});
