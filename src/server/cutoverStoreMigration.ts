// Cutover store-migration executors (cutover Phase 2, Step 2). Re-key the
// engine's on-disk stores from the legacy tmuxSession to the atch-native
// sessionId, driving the pure §10 transforms over real files.
//
// Canary-safe by construction: every executor takes an explicit sourceRoot
// (read ONLY) and a distinct targetRoot (written), so it never mutates the live
// store — the canary points source at the live data root and target at its
// isolated data root. Pointing target at the live root is possible but is the
// gated Phase 5 commit, never done here.

import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsOps.js';
import { readManifestFile, writeManifestFile } from '../core/config.js';
import { applyMigratedSessionIds, buildManifestMigration, collectSessions, deskManifestToEntries } from '../core/sessionIdentity.js';
import { advanceMigration, validateManifestMigration, type MigrationPhase, type Rollback } from '../shared/migration/index.js';
import {
  EXT_CONSUMED,
  EXT_DELIVERED,
  EXT_DELIVERING,
  EXT_QUEUED,
  EXT_STUCK_PASTE,
  EXT_STUCK_SUBMIT,
  EXT_STUCK_UNOBSERVABLE,
  classifyQueueFile,
  readQueueItem
} from './channelsDurability.js';
import type { QueuedPrompt } from './channelsProtocol.js';
import {
  migrateDurabilityQueue,
  migratePausedStore,
  type LegacyPausedEntry,
  type LegacyQueueItem,
  type MigratedPausedEntry,
  type RepairOutcome
} from '../shared/migration/index.js';

/** Version 2 = the sessionId-keyed paused store (version 1 was tmuxSession-keyed). */
const PAUSED_STORE_VERSION = 2;

export interface PausedMigrationReport {
  migrated: MigratedPausedEntry[];
  /** Paused entries whose tmuxSession has no sessionId in the map — reported, not silently lost. */
  dropped: LegacyPausedEntry[];
}

/**
 * Migrate the operator-pause store (`<root>/_engine/paused.json`) from the legacy
 * tmuxSession key to sessionId via the manifest's tmuxSession→sessionId map,
 * reading from sourceRoot and writing the version-2 store to targetRoot. A
 * missing source store migrates to an empty target; a malformed source store
 * throws (fail-closed — never silently drop live operator pauses).
 */
export function migratePausedStoreFile(sourceRoot: string, targetRoot: string, tmuxToSessionId: ReadonlyMap<string, string>): PausedMigrationReport {
  const legacy = readLegacyPaused(join(sourceRoot, '_engine', 'paused.json'));
  const result = migratePausedStore(legacy, tmuxToSessionId);
  const targetDir = join(targetRoot, '_engine');
  mkdirSync(targetDir, { recursive: true });
  writeFileAtomic(join(targetDir, 'paused.json'), `${JSON.stringify({ version: PAUSED_STORE_VERSION, items: result.items }, null, 2)}\n`);
  return { migrated: result.items, dropped: result.dropped };
}

export interface ManifestMigrationReport {
  sessions: number;
  targetPath: string;
}

/**
 * Persist the sessionId-bearing manifest into the isolated canary root (§10
 * Phase 2). Reads the source manifest READ-ONLY, mints + applies sessionIds, and
 * writes the migrated manifest atomically to targetPath (the existing manifest
 * writer). Fail-closed: after writing, it re-reads and verifies every session's
 * sessionId survived the YAML round-trip — a dropped field aborts rather than
 * persisting a manifest that silently lost identities. sessionId is the eventual
 * durable identity source, so future loads/edits preserve the assigned ids.
 */
export function migrateManifestToCanary(sourceManifestPath: string, targetManifestPath: string): ManifestMigrationReport {
  const manifest = readManifestFile(sourceManifestPath); // read-only
  const migration = buildManifestMigration(manifest);
  const migrated = applyMigratedSessionIds(manifest, migration);
  writeManifestFile(targetManifestPath, migrated); // atomic (temp + rename)

  // Fail-closed round-trip: the assigned ids must survive serialize→parse.
  const readBack = collectSessions(readManifestFile(targetManifestPath)).map((s) => s.sessionId);
  const expected = migration.entries.map((e) => e.sessionId);
  if (readBack.length !== expected.length || readBack.some((id, i) => id !== expected[i])) {
    throw new Error(`cutover: manifest YAML round-trip dropped or altered sessionIds at ${targetManifestPath} — refusing (fail-closed)`);
  }
  return { sessions: expected.length, targetPath: targetManifestPath };
}

/** Read the legacy (version-1, tmuxSession-keyed) paused store as transform entries. */
function readLegacyPaused(path: string): LegacyPausedEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { items?: unknown };
  if (!Array.isArray(parsed.items)) {
    throw new Error(`cutover: malformed paused store at ${path} — refusing to migrate (fail-closed)`);
  }
  return parsed.items.map((raw) => {
    const item = raw as { tmuxSession?: unknown; pausedAt?: unknown; reason?: unknown };
    if (typeof item.tmuxSession !== 'string' || typeof item.pausedAt !== 'string') {
      throw new Error(`cutover: malformed paused entry in ${path} — refusing to migrate (fail-closed)`);
    }
    const entry: LegacyPausedEntry = { tmuxSession: item.tmuxSession, pausedAt: item.pausedAt };
    if (typeof item.reason === 'string') {
      entry.reason = item.reason;
    }
    return entry;
  });
}

// ---- durability queue migration (Option B: plan → seed journal) -------------

/** A migrated queue item paired with its repaired delivery decision and raw body. */
export interface DurabilityPlanItem {
  sessionId: string;
  seq: number;
  outcome: RepairOutcome;
  body: QueuedPrompt;
}

export interface DurabilityMigrationPlan {
  /** Ready-to-seed items: re-keyed to sessionId, submit-repaired, body preserved. */
  items: DurabilityPlanItem[];
  /** Items whose tmuxSession has no sessionId — reported, not silently lost. */
  dropped: LegacyQueueItem[];
  /** Items whose body was unreadable/corrupt — surfaced, never quietly dropped. */
  unreadable: { tmuxSession: string; seq: number; ext: string }[];
  /** True when a fully-drained queue imports nothing (§10 round-7A). */
  skippedByDrain: boolean;
}

/** Map a durable queue-file extension to a §10 LegacyDurabilityExt (or null to skip). */
function toLegacyDurabilityExt(fileExt: string): LegacyQueueItem['ext'] | null {
  switch (fileExt) {
    case EXT_QUEUED:
      return 'json';
    case EXT_DELIVERING:
      return 'delivering';
    case EXT_DELIVERED:
      return 'delivered';
    case EXT_STUCK_PASTE:
      return 'stuck-paste';
    case EXT_STUCK_SUBMIT:
      return 'stuck-submit';
    case EXT_STUCK_UNOBSERVABLE:
      return 'stuck-unobservable';
    case EXT_CONSUMED:
      // Transient restore-atomicity tombstone → a replay candidate → re-deliver as queued.
      return 'json';
    default:
      return null;
  }
}

interface RawQueueItem {
  tmuxSession: string;
  seq: number;
  ext: LegacyQueueItem['ext'];
  fileExt: string;
  body: QueuedPrompt | null;
}

const bodyKey = (tmuxSession: string, seq: number): string => `${tmuxSession}\u0000${seq}`;

/** Enumerate the legacy per-session queue dirs under sourceRoot (read-only). */
function readLegacyDurabilityQueue(sourceRoot: string): RawQueueItem[] {
  const queueRoot = join(sourceRoot, '_engine', 'queue');
  if (!existsSync(queueRoot)) {
    return [];
  }
  const out: RawQueueItem[] = [];
  for (const tmuxSession of readdirSync(queueRoot)) {
    const dir = join(queueRoot, tmuxSession);
    if (!statSync(dir).isDirectory()) {
      continue;
    }
    for (const filename of readdirSync(dir)) {
      const fileExt = classifyQueueFile(filename);
      if (fileExt === null) {
        continue; // not a queue-item file
      }
      const ext = toLegacyDurabilityExt(fileExt);
      if (ext === null) {
        continue;
      }
      const seq = Number.parseInt(filename.slice(0, 10), 10);
      if (!Number.isInteger(seq)) {
        continue;
      }
      out.push({ tmuxSession, seq, ext, fileExt, body: readQueueItem(dir, filename) });
    }
  }
  return out;
}

/**
 * Plan the durability-queue migration (Option B, read-only): re-key each item to
 * sessionId via the manifest map, repair its legacy state through the §10
 * transform (nothing imports as done; .delivered held semantic-unknown), and
 * pair each with its raw body so the seed-journal writer can persist both the
 * repaired phase and the re-keyed body. Unmapped sessions and unreadable bodies
 * are reported, never silently dropped.
 */
export function planDurabilityMigration(
  sourceRoot: string,
  tmuxToSessionId: ReadonlyMap<string, string>,
  drainComplete = false
): DurabilityMigrationPlan {
  const raw = readLegacyDurabilityQueue(sourceRoot);
  const unreadable = raw.filter((r) => r.body === null).map((r) => ({ tmuxSession: r.tmuxSession, seq: r.seq, ext: r.fileExt }));
  const readable = raw.filter((r): r is RawQueueItem & { body: QueuedPrompt } => r.body !== null);

  const legacyItems: LegacyQueueItem[] = readable.map((r) => ({ tmuxSession: r.tmuxSession, seq: r.seq, ext: r.ext }));
  const migration = migrateDurabilityQueue(legacyItems, tmuxToSessionId, drainComplete);

  // Pair each migrated item back to its body via the (injective) inverse map.
  const inverse = new Map<string, string>([...tmuxToSessionId].map(([tmux, sid]) => [sid, tmux]));
  const bodies = new Map<string, QueuedPrompt>(readable.map((r) => [bodyKey(r.tmuxSession, r.seq), r.body]));
  const items: DurabilityPlanItem[] = migration.items.map((m) => {
    const tmux = inverse.get(m.sessionId);
    const body = tmux !== undefined ? bodies.get(bodyKey(tmux, m.seq)) : undefined;
    if (body === undefined) {
      throw new Error(`cutover: durability body missing for ${m.sessionId} seq ${m.seq} (fail-closed)`);
    }
    return { sessionId: m.sessionId, seq: m.seq, outcome: m.outcome, body };
  });

  return { items, dropped: migration.dropped, unreadable, skippedByDrain: migration.skippedByDrain };
}

/** Version 1 of the one-shot durability seed journal (sessionId-keyed delivery seed). */
const SEED_JOURNAL_VERSION = 1;
const padSeq = (seq: number): string => String(seq).padStart(10, '0');

export interface DurabilitySeedOptions {
  /** Proceed even though some queue bodies were unreadable (default: fail closed). */
  acknowledgeUnreadable?: boolean;
  /** Proceed even though some queue sessions are unmapped and will be dropped (default: fail closed). */
  acknowledgeDropped?: boolean;
}

export interface DurabilitySeedReport {
  written: number;
  droppedAck: number;
  /** The engine already consumed a prior seed (committed marker present) → left untouched. */
  alreadyCommitted: boolean;
}

/**
 * Write the Option B durability seed journal into the canary root: an atomic,
 * versioned, one-shot seed keyed by (sessionId, seq) holding each item's repaired
 * delivery phase + reissue decision, with raw bodies re-keyed to a SEPARATE
 * sessionId-keyed location. The channels engine seeds from this once on first
 * start and writes the committed marker; this writer is idempotent — a present
 * committed marker means the engine already consumed the seed, so it is left
 * untouched, and an un-committed rewrite is byte-stable (items sorted by
 * sessionId then seq).
 *
 * Fail-closed by default: any unreadable body, or any unmapped-session drop,
 * aborts unless the caller explicitly acknowledges it — a successful journal must
 * never silently omit live queue state.
 */
export function writeDurabilitySeedJournal(plan: DurabilityMigrationPlan, targetRoot: string, options: DurabilitySeedOptions = {}): DurabilitySeedReport {
  const journalDir = join(targetRoot, '_engine', 'migration');
  const committedMarker = join(journalDir, 'seed-journal.committed');
  if (existsSync(committedMarker)) {
    return { written: 0, droppedAck: 0, alreadyCommitted: true }; // engine already seeded — respect it
  }
  if (plan.unreadable.length > 0 && options.acknowledgeUnreadable !== true) {
    throw new Error(`cutover: ${plan.unreadable.length} unreadable queue bodies — refusing a partial seed journal (fail-closed); pass acknowledgeUnreadable to proceed`);
  }
  if (plan.dropped.length > 0 && options.acknowledgeDropped !== true) {
    throw new Error(`cutover: ${plan.dropped.length} unmapped queue sessions would be dropped — pass acknowledgeDropped to proceed`);
  }

  // Deterministic order → byte-stable journal across idempotent retries.
  const items = [...plan.items].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.seq - b.seq));

  // Raw bodies re-keyed to a SEPARATE sessionId-keyed location.
  for (const item of items) {
    const bodyDir = join(journalDir, 'bodies', item.sessionId);
    mkdirSync(bodyDir, { recursive: true });
    writeFileAtomic(join(bodyDir, `${padSeq(item.seq)}.json`), JSON.stringify(item.body));
  }

  // The journal holds the repaired phase/reissue (never the body, never a legacy ext).
  const journal = {
    version: SEED_JOURNAL_VERSION,
    committed: false,
    items: items.map((item) => ({ sessionId: item.sessionId, seq: item.seq, phase: item.outcome.phase, reissue: item.outcome.reissue })),
    dropped: plan.dropped,
    unreadable: plan.unreadable
  };
  mkdirSync(journalDir, { recursive: true });
  writeFileAtomic(join(journalDir, 'seed-journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
  return { written: items.length, droppedAck: plan.dropped.length, alreadyCommitted: false };
}

// ---- canary migration orchestrator (Phase 2 driver over the phase FSM) ------

export interface CanaryMigrationOptions {
  /** Live data root — read ONLY, never mutated. */
  sourceRoot: string;
  sourceManifestPath: string;
  /** Isolated canary data root — all writes land here. */
  targetRoot: string;
  targetManifestPath: string;
  /** Immutable backup destination (rollback safety). */
  backupRoot: string;
  acknowledgeDropped?: boolean;
  acknowledgeUnreadable?: boolean;
}

export interface CanaryMigrationResult {
  /** 'done' on success, 'aborted' on failure. */
  phase: MigrationPhase;
  /** The rollback the FSM says would restore consistency on an abort. */
  rollback: Rollback;
  manifest?: ManifestMigrationReport;
  paused?: PausedMigrationReport;
  durability?: DurabilitySeedReport;
  failedPhase?: MigrationPhase;
  error?: string;
}

/** Fail closed unless the dir is absent or empty — a fresh canary run must not merge onto stale state. */
function requireEmptyDir(dir: string, label: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`cutover: ${label} root must be empty or absent for a fresh canary run (${dir} is non-empty)`);
  }
}

/** Validate the COMPLETE written canary output before commit (not just manifest identity). */
function validateCanaryOutput(options: CanaryMigrationOptions): void {
  for (const session of collectSessions(readManifestFile(options.targetManifestPath))) {
    if (session.sessionId === undefined || session.sessionId === '') {
      throw new Error(`cutover: canary manifest session ${session.name} is missing a sessionId`);
    }
  }
  const pausedPath = join(options.targetRoot, '_engine', 'paused.json');
  if (existsSync(pausedPath)) {
    const paused = JSON.parse(readFileSync(pausedPath, 'utf8')) as { version?: number };
    if (paused.version !== PAUSED_STORE_VERSION) {
      throw new Error(`cutover: canary paused store is not version ${PAUSED_STORE_VERSION}`);
    }
  }
  const journalPath = join(options.targetRoot, '_engine', 'migration', 'seed-journal.json');
  if (existsSync(journalPath)) {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { version?: number; committed?: boolean };
    if (journal.version !== SEED_JOURNAL_VERSION) {
      throw new Error(`cutover: canary seed journal is not version ${SEED_JOURNAL_VERSION}`);
    }
    if (journal.committed !== false) {
      throw new Error('cutover: canary seed journal is already committed before the commit phase');
    }
  }
}

/** Immutable backup of the source stores + manifest (rollback safety; source stays read-only). */
function backupSource(options: CanaryMigrationOptions): void {
  mkdirSync(options.backupRoot, { recursive: true });
  const srcEngine = join(options.sourceRoot, '_engine');
  if (existsSync(srcEngine)) {
    cpSync(srcEngine, join(options.backupRoot, '_engine'), { recursive: true });
  }
  if (existsSync(options.sourceManifestPath)) {
    cpSync(options.sourceManifestPath, join(options.backupRoot, 'desk.yml'));
  }
}

/**
 * Drive the §10 store migration to an isolated canary root over the journaled
 * phase FSM: backup → transform → validate → commit. The source is read ONLY and
 * never mutated; the immutable backup is taken first; each executor fails closed.
 * A failure aborts and reports the rollback the FSM says would restore
 * consistency (restore-backup once a backup exists). Quiesce and boot are the
 * live canary-run wrapper's job (gated) — this pure driver does no live mutation
 * and no boot.
 */
export function runCanaryMigration(options: CanaryMigrationOptions): CanaryMigrationResult {
  const advance = (p: MigrationPhase): MigrationPhase => advanceMigration(p, 'ok').next;
  let phase: MigrationPhase = 'backup';
  const partial: Pick<CanaryMigrationResult, 'manifest' | 'paused' | 'durability'> = {};
  try {
    requireEmptyDir(options.backupRoot, 'backup');
    requireEmptyDir(options.targetRoot, 'target');
    backupSource(options);
    phase = advance(phase); // → transform

    const map = buildManifestMigration(readManifestFile(options.sourceManifestPath)).tmuxToSessionId;
    partial.manifest = migrateManifestToCanary(options.sourceManifestPath, options.targetManifestPath);
    partial.paused = migratePausedStoreFile(options.sourceRoot, options.targetRoot, map);
    const plan = planDurabilityMigration(options.sourceRoot, map);
    partial.durability = writeDurabilitySeedJournal(plan, options.targetRoot, {
      acknowledgeDropped: options.acknowledgeDropped,
      acknowledgeUnreadable: options.acknowledgeUnreadable
    });
    phase = advance(phase); // → validate

    // Validate before commit: reverify the identity mint is collision-free.
    const source = readManifestFile(options.sourceManifestPath);
    const check = validateManifestMigration(deskManifestToEntries(source), buildManifestMigration(source));
    if (!check.ok) {
      throw new Error(`cutover: canary validation failed (${check.reason}: ${check.value})`);
    }
    validateCanaryOutput(options);
    phase = advance(phase); // → commit

    mkdirSync(join(options.targetRoot, '_engine', 'migration'), { recursive: true });
    writeFileAtomic(join(options.targetRoot, '_engine', 'migration', 'migration.done'), `${JSON.stringify({ version: 1, sessions: partial.manifest.sessions }, null, 2)}\n`);
    phase = advance(phase); // → done
    return { phase: 'done', rollback: 'none', ...partial };
  } catch (error) {
    const { next, rollback } = advanceMigration(phase, 'fail');
    return { phase: next, rollback, failedPhase: phase, error: (error as Error).message, ...partial };
  }
}

// ---- durability seed CONSUMPTION (Item 2, read side of the contract) ---------

export interface SeedJournalItem {
  sessionId: string;
  seq: number;
  /** Repaired delivery phase (queued | semantic-unknown | submit-confirmed). */
  phase: string;
  reissue: boolean;
  body: QueuedPrompt;
}

const migrationDir = (root: string): string => join(root, '_engine', 'migration');
const committedMarkerPath = (root: string): string => join(migrationDir(root), 'seed-journal.committed');

/** The committed marker file is the durable commit truth — NOT the journal's committed field. */
export function isSeedCommitted(root: string): boolean {
  return existsSync(committedMarkerPath(root));
}

/**
 * Read + validate the durability seed journal for the channels engine to consume
 * (Item 2). Returns null when no journal is present (nothing to seed). Fails
 * CLOSED per the contract: an unknown version, a malformed item, or a missing
 * referenced body throws — so the engine seeds nothing and never sets the marker
 * on a partial/corrupt seed. Reading does NOT set the marker; the engine writes
 * it via markSeedCommitted only after every item is seeded.
 */
export function readSeedJournalForConsumption(root: string): { items: SeedJournalItem[] } | null {
  const journalPath = join(migrationDir(root), 'seed-journal.json');
  if (!existsSync(journalPath)) {
    return null;
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { version?: number; items?: unknown };
  if (journal.version !== SEED_JOURNAL_VERSION) {
    throw new Error(`seed consume: unknown seed-journal version ${String(journal.version)} (fail-closed)`);
  }
  if (!Array.isArray(journal.items)) {
    throw new Error('seed consume: malformed seed-journal items (fail-closed)');
  }
  const items = journal.items.map((raw): SeedJournalItem => {
    const it = raw as { sessionId?: unknown; seq?: unknown; phase?: unknown; reissue?: unknown };
    if (typeof it.sessionId !== 'string' || typeof it.seq !== 'number' || typeof it.phase !== 'string' || typeof it.reissue !== 'boolean') {
      throw new Error('seed consume: malformed seed-journal item (fail-closed)');
    }
    const bodyPath = join(migrationDir(root), 'bodies', it.sessionId, `${padSeq(it.seq)}.json`);
    if (!existsSync(bodyPath)) {
      throw new Error(`seed consume: missing body for ${it.sessionId} seq ${it.seq} (fail-closed)`);
    }
    return { sessionId: it.sessionId, seq: it.seq, phase: it.phase, reissue: it.reissue, body: JSON.parse(readFileSync(bodyPath, 'utf8')) as QueuedPrompt };
  });
  return { items };
}

/** Write the durable committed marker — the engine calls this only AFTER seeding every item. */
export function markSeedCommitted(root: string): void {
  mkdirSync(migrationDir(root), { recursive: true });
  writeFileAtomic(committedMarkerPath(root), `${JSON.stringify({ version: SEED_JOURNAL_VERSION })}\n`);
}
