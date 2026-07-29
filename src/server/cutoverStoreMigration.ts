// Cutover store-migration executors (cutover Phase 2, Step 2). Re-key the
// engine's on-disk stores from the legacy tmuxSession to the atch-native
// sessionId, driving the pure §10 transforms over real files.
//
// Canary-safe by construction: every executor takes an explicit sourceRoot
// (read ONLY) and a distinct targetRoot (written), so it never mutates the live
// store — the canary points source at the live data root and target at its
// isolated data root. Pointing target at the live root is possible but is the
// gated Phase 5 commit, never done here.

import {
  cpSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeSync
} from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { dirname, join, relative } from 'node:path';
import { writeFileAtomic } from './fsOps.js';
import { readManifestFile, writeManifestFile } from '../core/config.js';
import { parseLegacyDeskManifest } from '../core/manifest.js';
import { applyMigratedSessionIds, buildManifestMigration, collectSessions, deskManifestToEntries, type LegacyDeskManifest } from '../core/sessionIdentity.js';
import { withFileLockSync } from '../shared/fileLock.js';
import { migrateResumeCaptureStore, type LegacyPendingResumeCapture } from '../core/resumeCaptureState.js';
import { migrateDeliveryEventLine } from './channelsEvents.js';
import { migrateMemberManifestContent } from './channelsProtocol.js';
import { advanceMigration, isValidSessionId, validateManifestMigration, type MigrationPhase, type Rollback } from '../shared/migration/index.js';
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
  const manifest = readLegacyManifestFile(sourceManifestPath); // read-only
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

/** Read the legacy schema only inside the migration boundary. */
export function readLegacyManifestFile(path: string): LegacyDeskManifest {
  if (!existsSync(path)) {
    return { groups: [] };
  }
  const source = readFileSync(path, 'utf8');
  if (source.trim() === '') {
    throw new Error(`desk manifest is empty: ${path}`);
  }
  return parseLegacyDeskManifest(source);
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

    const map = buildManifestMigration(readLegacyManifestFile(options.sourceManifestPath)).tmuxToSessionId;
    partial.manifest = migrateManifestToCanary(options.sourceManifestPath, options.targetManifestPath);
    partial.paused = migratePausedStoreFile(options.sourceRoot, options.targetRoot, map);
    const plan = planDurabilityMigration(options.sourceRoot, map);
    partial.durability = writeDurabilitySeedJournal(plan, options.targetRoot, {
      acknowledgeDropped: options.acknowledgeDropped,
      acknowledgeUnreadable: options.acknowledgeUnreadable
    });
    phase = advance(phase); // → validate

    // Validate before commit: reverify the identity mint is collision-free.
    const source = readLegacyManifestFile(options.sourceManifestPath);
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

// ---- production first-start migration -------------------------------------

const PRODUCTION_MIGRATION_VERSION = 1;
const PRODUCTION_MIGRATION_RESERVE_BYTES = 16n * 1024n * 1024n;

type ProductionPhase = 'staged' | 'committing' | 'done';

interface SourceFingerprintEntry {
  path: string;
  kind: 'missing' | 'file' | 'directory';
  size?: number;
  mtimeMs?: number;
  ino?: number;
}

interface ProductionArtifact {
  id: string;
  mode: 'replace' | 'expire';
  sourcePath: string;
  backupPath: string;
  stagedPath?: string;
  sourceExisted: boolean;
}

interface ProductionJournal {
  version: number;
  phase: ProductionPhase;
  manifestPath: string;
  channelsRoot: string;
  sourceFingerprint: SourceFingerprintEntry[];
  artifacts: ProductionArtifact[];
  committedArtifacts: string[];
  sessions: number;
  identityMap: [string, string][];
}

export interface ProductionProcessProbe {
  alive: boolean;
  starttime: number | null;
}

export interface ProductionCutoverMigrationOptions {
  homeDir?: string;
  manifestPath?: string;
  channelsRoot?: string;
  migrationRoot?: string;
  availableBytes?: (path: string) => bigint;
  processProbe?: (pid: number) => ProductionProcessProbe;
  /** Test/diagnostic hook after a durable phase transition. */
  afterPhase?: (phase: ProductionPhase) => void;
  /** Test hook used to falsify the source-stability check. */
  beforeSourceRecheck?: () => void;
}

export interface ProductionCutoverMigrationResult {
  status: 'migrated' | 'already-migrated';
  sessions: number;
  markerPath: string;
}

/**
 * First-start production cutover. This function is synchronous on purpose: it
 * must complete (or throw) before any runtime service can open an old store.
 * The committed marker is the only success truth and is written last.
 */
export function ensureProductionCutoverMigration(
  options: ProductionCutoverMigrationOptions = {}
): ProductionCutoverMigrationResult {
  const homeDir = options.homeDir ?? process.env.HOME ?? '';
  if (!homeDir) {
    throw new Error('cutover: HOME is unavailable; refusing production migration');
  }
  const manifestPath = options.manifestPath ?? join(homeDir, '.config', 'desk', 'desk.yml');
  const channelsRoot = options.channelsRoot ?? join(homeDir, '.config', 'desk', 'channels');
  const migrationRoot = options.migrationRoot ?? join(dirname(manifestPath), '_migration', 'session-id-v1');
  const markerPath = join(migrationRoot, 'migration.done');
  const journalPath = join(migrationRoot, 'journal.json');
  const lockPath = join(migrationRoot, 'migration.lock');

  mkdirSync(dirname(manifestPath), { recursive: true });
  mkdirSync(channelsRoot, { recursive: true });
  mkdirSync(migrationRoot, { recursive: true });

  return withFileLockSync(`${manifestPath}.lock`, () =>
    withFileLockSync(lockPath, () => {
      if (existsSync(markerPath)) {
        readProductionMarker(markerPath);
        // A marker never suppresses runtime validation. Its session count is
        // migration-time evidence, not a permanent cardinality lock: normal
        // config edits can add or remove durable sessions after cutover.
        const sessions = collectSessions(readManifestFile(manifestPath)).length;
        validateProductionCommittedStores(channelsRoot);
        return { status: 'already-migrated', sessions, markerPath };
      }

      assertLegacyEngineInactive(channelsRoot, options.processProbe ?? defaultProductionProcessProbe);

      const existing = readProductionJournal(journalPath, manifestPath, channelsRoot);
      if (existing?.phase === 'done') {
        return finishProductionMarker(existing, markerPath, options.afterPhase);
      }
      if (existing?.phase === 'committing') {
        return finishProductionCommit(existing, journalPath, markerPath, options.afterPhase);
      }
      if (existing?.phase === 'staged') {
        assertSourceFingerprint(existing.sourceFingerprint, productionSourceRoots(homeDir, manifestPath, channelsRoot));
        existing.phase = 'committing';
        writeProductionJournal(journalPath, existing);
        options.afterPhase?.('committing');
        return finishProductionCommit(existing, journalPath, markerPath, options.afterPhase);
      }

      const stageRoot = join(migrationRoot, 'stage');
      const backupRoot = join(migrationRoot, 'backup');
      rmSync(stageRoot, { recursive: true, force: true });
      requireEmptyDir(backupRoot, 'production backup');
      assertSameFilesystem([migrationRoot, dirname(manifestPath), channelsRoot]);

      const sourceRoots = productionSourceRoots(homeDir, manifestPath, channelsRoot);
      const sourceFingerprint = fingerprintSources(sourceRoots);
      const requiredBytes = estimateStageBytes(fingerprintSources(productionStageSourceRoots(homeDir, manifestPath, channelsRoot))) + PRODUCTION_MIGRATION_RESERVE_BYTES;
      const availableBytes = (options.availableBytes ?? defaultAvailableBytes)(migrationRoot);
      if (availableBytes < requiredBytes) {
        throw new Error(`cutover: insufficient free space (${availableBytes} available, ${requiredBytes} required)`);
      }

      const stageManifestPath = join(stageRoot, 'manifest', 'desk.yml');
      const stageChannelsRoot = join(stageRoot, 'channels');
      const legacyManifest = readLegacyManifestFile(manifestPath);
      const migration = buildManifestMigration(legacyManifest);
      const identityCheck = validateManifestMigration(deskManifestToEntries(legacyManifest), migration);
      if (!identityCheck.ok) {
        throw new Error(`cutover: identity validation failed (${identityCheck.reason}: ${identityCheck.value})`);
      }
      const manifestReport = migrateManifestToCanary(manifestPath, stageManifestPath);
      const pausedReport = migratePausedStoreFile(channelsRoot, stageChannelsRoot, migration.tmuxToSessionId);
      if (pausedReport.dropped.length > 0) {
        throw new Error(`cutover: ${pausedReport.dropped.length} paused sessions are unmapped; refusing partial migration`);
      }
      const durabilityPlan = planDurabilityMigration(channelsRoot, migration.tmuxToSessionId);
      writeDurabilitySeedJournal(durabilityPlan, stageChannelsRoot);
      const additionalArtifacts = stageOwnedProductionStores({
        homeDir,
        channelsRoot,
        stageRoot,
        backupRoot,
        tmuxToSessionId: migration.tmuxToSessionId
      });
      validateProductionStage(stageManifestPath, stageChannelsRoot, manifestReport.sessions);

      options.beforeSourceRecheck?.();
      const currentFingerprint = fingerprintSources(sourceRoots);
      if (JSON.stringify(currentFingerprint) !== JSON.stringify(sourceFingerprint)) {
        throw new Error('cutover: source mutated during transform; refusing to commit');
      }

      const artifacts = productionArtifacts({
        homeDir,
        manifestPath,
        channelsRoot,
        stageRoot,
        backupRoot,
        additionalArtifacts
      });
      const journal: ProductionJournal = {
        version: PRODUCTION_MIGRATION_VERSION,
        phase: 'staged',
        manifestPath,
        channelsRoot,
        sourceFingerprint,
        artifacts,
        committedArtifacts: [],
        sessions: manifestReport.sessions,
        identityMap: [...migration.tmuxToSessionId]
      };
      writeProductionJournal(journalPath, journal);
      options.afterPhase?.('staged');

      journal.phase = 'committing';
      writeProductionJournal(journalPath, journal);
      options.afterPhase?.('committing');
      return finishProductionCommit(journal, journalPath, markerPath, options.afterPhase);
    })
  );
}

function productionSourceRoots(homeDir: string, manifestPath: string, channelsRoot: string): string[] {
  return [
    manifestPath,
    channelsRoot,
    join(homeDir, '.config', 'desk', 'resume-captures.json'),
    join(homeDir, '.config', 'desk', 'tool-journal')
  ];
}

function productionStageSourceRoots(homeDir: string, manifestPath: string, channelsRoot: string): string[] {
  return [
    manifestPath,
    join(channelsRoot, '_engine', 'paused.json'),
    join(channelsRoot, '_engine', 'queue'),
    join(channelsRoot, '_engine', 'events.jsonl'),
    join(homeDir, '.config', 'desk', 'resume-captures.json'),
    ...collectMemberManifestPaths(channelsRoot)
  ];
}

function productionArtifacts(paths: {
  homeDir: string;
  manifestPath: string;
  channelsRoot: string;
  stageRoot: string;
  backupRoot: string;
  additionalArtifacts: ProductionArtifact[];
}): ProductionArtifact[] {
  const replace = (id: string, sourcePath: string, stagedPath: string, backupPath: string): ProductionArtifact => ({
    id,
    mode: 'replace',
    sourcePath,
    stagedPath,
    backupPath,
    sourceExisted: existsSync(sourcePath)
  });
  const expire = (id: string, sourcePath: string, backupPath: string): ProductionArtifact => ({
    id,
    mode: 'expire',
    sourcePath,
    backupPath,
    sourceExisted: existsSync(sourcePath)
  });
  return [
    replace('paused', join(paths.channelsRoot, '_engine', 'paused.json'), join(paths.stageRoot, 'channels', '_engine', 'paused.json'), join(paths.backupRoot, 'channels', '_engine', 'paused.json')),
    replace('durability-seed', join(paths.channelsRoot, '_engine', 'migration'), join(paths.stageRoot, 'channels', '_engine', 'migration'), join(paths.backupRoot, 'channels', '_engine', 'migration')),
    expire('durability-queue', join(paths.channelsRoot, '_engine', 'queue'), join(paths.backupRoot, 'channels', '_engine', 'queue')),
    expire('tool-journal', join(paths.homeDir, '.config', 'desk', 'tool-journal'), join(paths.backupRoot, 'tool-journal')),
    ...paths.additionalArtifacts,
    replace('manifest', paths.manifestPath, join(paths.stageRoot, 'manifest', 'desk.yml'), join(paths.backupRoot, 'manifest', 'desk.yml'))
  ];
}

function stageOwnedProductionStores(options: {
  homeDir: string;
  channelsRoot: string;
  stageRoot: string;
  backupRoot: string;
  tmuxToSessionId: ReadonlyMap<string, string>;
}): ProductionArtifact[] {
  const artifacts: ProductionArtifact[] = [];
  const replaceArtifact = (id: string, sourcePath: string, stagedPath: string, backupPath: string): void => {
    artifacts.push({
      id,
      mode: 'replace',
      sourcePath,
      stagedPath,
      backupPath,
      sourceExisted: true
    });
  };

  const resumePath = join(options.homeDir, '.config', 'desk', 'resume-captures.json');
  if (existsSync(resumePath)) {
    const captures = readLegacyResumeCaptures(resumePath);
    const migrated = migrateResumeCaptureStore(captures, options.tmuxToSessionId);
    if (migrated.dropped.length > 0) {
      throw new Error(`cutover: ${migrated.dropped.length} resume captures are unmapped; refusing partial migration`);
    }
    const stagedPath = join(options.stageRoot, 'resume-captures.json');
    writeFileAtomic(stagedPath, `${JSON.stringify({ version: 2, captures: migrated.items }, null, 2)}\n`);
    replaceArtifact('resume-captures', resumePath, stagedPath, join(options.backupRoot, 'resume-captures.json'));
  }

  const eventsPath = join(options.channelsRoot, '_engine', 'events.jsonl');
  if (existsSync(eventsPath)) {
    const stagedPath = join(options.stageRoot, 'channels', '_engine', 'events.jsonl');
    streamMigrateDeliveryEvents(eventsPath, stagedPath, options.tmuxToSessionId);
    replaceArtifact('delivery-events', eventsPath, stagedPath, join(options.backupRoot, 'channels', '_engine', 'events.jsonl'));
  }

  let memberIndex = 0;
  for (const sourcePath of collectMemberManifestPaths(options.channelsRoot)) {
    const migrated = migrateMemberManifestContent(readFileSync(sourcePath, 'utf8'), options.tmuxToSessionId);
    if (migrated.unmapped.length > 0) {
      throw new Error(`cutover: member manifest ${sourcePath} has ${migrated.unmapped.length} unmapped sessions`);
    }
    if (!migrated.migrated) {
      continue;
    }
    const relativePath = relative(options.channelsRoot, sourcePath);
    const stagedPath = join(options.stageRoot, 'channels', relativePath);
    const backupPath = join(options.backupRoot, 'channels', relativePath);
    writeFileAtomic(stagedPath, migrated.content);
    replaceArtifact(`member-${memberIndex++}`, sourcePath, stagedPath, backupPath);
  }
  return artifacts;
}

function readLegacyResumeCaptures(path: string): LegacyPendingResumeCapture[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`cutover: malformed resume-capture store at ${path}: ${(error as Error).message}`);
  }
  const values = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { captures?: unknown }).captures)
      ? (parsed as { captures: unknown[] }).captures
      : null;
  if (values === null) {
    throw new Error(`cutover: malformed resume-capture store at ${path}`);
  }
  return values.map((value, index): LegacyPendingResumeCapture => {
    if (value === null || typeof value !== 'object') {
      throw new Error(`cutover: malformed resume capture ${index} at ${path}`);
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.tmuxSession !== 'string' ||
      (record.agent !== 'codex' && record.agent !== 'opencode') ||
      typeof record.cwd !== 'string' ||
      typeof record.sinceMs !== 'number' ||
      !Number.isFinite(record.sinceMs) ||
      typeof record.deadlineMs !== 'number' ||
      !Number.isFinite(record.deadlineMs) ||
      (record.launchResumeId !== undefined && typeof record.launchResumeId !== 'string')
    ) {
      throw new Error(`cutover: malformed resume capture ${index} at ${path}`);
    }
    return {
      tmuxSession: record.tmuxSession,
      agent: record.agent,
      cwd: record.cwd,
      sinceMs: record.sinceMs,
      deadlineMs: record.deadlineMs,
      ...(record.launchResumeId !== undefined ? { launchResumeId: record.launchResumeId } : {})
    };
  });
}

const EVENT_STREAM_CHUNK_BYTES = 64 * 1024;
const EVENT_STREAM_MAX_LINE_BYTES = 1024 * 1024;
const EVENT_STREAM_MAX_EVENTS = 10_000;

function findDeliveryEventTailOffset(sourcePath: string, maxEvents: number): number {
  const input = openSync(sourcePath, 'r');
  try {
    const size = statSync(sourcePath).size;
    if (size === 0) {
      return 0;
    }
    const lastByte = Buffer.allocUnsafe(1);
    readSync(input, lastByte, 0, 1, size - 1);
    let newlinesNeeded = maxEvents + (lastByte[0] === 0x0a ? 1 : 0);
    const buffer = Buffer.allocUnsafe(EVENT_STREAM_CHUNK_BYTES);
    let position = size;
    while (position > 0) {
      const bytes = Math.min(buffer.length, position);
      position -= bytes;
      readSync(input, buffer, 0, bytes, position);
      for (let index = bytes - 1; index >= 0; index -= 1) {
        if (buffer[index] !== 0x0a) {
          continue;
        }
        newlinesNeeded -= 1;
        if (newlinesNeeded === 0) {
          return position + index + 1;
        }
      }
    }
    return 0;
  } finally {
    closeSync(input);
  }
}

/**
 * Fixed-chunk migration for the retained delivery ring. Older history is kept
 * byte-for-byte in the cutover backup instead of being copied into the live
 * ring, so multi-GiB legacy logs remain recoverable without blocking startup.
 */
function streamMigrateDeliveryEvents(
  sourcePath: string,
  stagedPath: string,
  tmuxToSessionId: ReadonlyMap<string, string>
): void {
  mkdirSync(dirname(stagedPath), { recursive: true });
  const startOffset = findDeliveryEventTailOffset(sourcePath, EVENT_STREAM_MAX_EVENTS);
  const input = openSync(sourcePath, 'r');
  const output = openSync(stagedPath, 'wx');
  const buffer = Buffer.allocUnsafe(EVENT_STREAM_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let lineNumber = 0;
  let readOffset = startOffset;
  const writeLine = (line: string, newline: boolean): void => {
    lineNumber += 1;
    const migrated = migrateDeliveryEventLine(line, tmuxToSessionId);
    writeSync(output, `${migrated.line}${newline ? '\n' : ''}`, undefined, 'utf8');
  };
  try {
    for (;;) {
      const bytes = readSync(input, buffer, 0, buffer.length, readOffset);
      if (bytes === 0) {
        carry += decoder.end();
        break;
      }
      readOffset += bytes;
      carry += decoder.write(buffer.subarray(0, bytes));
      let newline: number;
      while ((newline = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        if (Buffer.byteLength(line, 'utf8') > EVENT_STREAM_MAX_LINE_BYTES) {
          throw new Error(`cutover: delivery event line exceeds ${EVENT_STREAM_MAX_LINE_BYTES} bytes at ${sourcePath}`);
        }
        writeLine(line, true);
      }
      if (Buffer.byteLength(carry, 'utf8') > EVENT_STREAM_MAX_LINE_BYTES) {
        throw new Error(`cutover: delivery event line exceeds ${EVENT_STREAM_MAX_LINE_BYTES} bytes at ${sourcePath}`);
      }
    }
    if (carry.length > 0) {
      writeLine(carry, false);
    }
  } catch (error) {
    closeSync(input);
    closeSync(output);
    rmSync(stagedPath, { force: true });
    throw error;
  }
  closeSync(input);
  closeSync(output);
}

function collectMemberManifestPaths(channelsRoot: string): string[] {
  const out: string[] = [];
  for (const channel of readdirSync(channelsRoot).sort()) {
    if (channel.startsWith('.') || channel.startsWith('_')) {
      continue;
    }
    const channelPath = join(channelsRoot, channel);
    const channelStat = lstatSync(channelPath);
    if (channelStat.isSymbolicLink()) {
      throw new Error(`cutover: refusing symlinked channel ${channelPath}`);
    }
    if (!channelStat.isDirectory()) {
      continue;
    }
    const membersPath = join(channelPath, '_members');
    if (!existsSync(membersPath)) {
      continue;
    }
    const membersStat = lstatSync(membersPath);
    if (membersStat.isSymbolicLink() || !membersStat.isDirectory()) {
      throw new Error(`cutover: invalid members directory ${membersPath}`);
    }
    for (const name of readdirSync(membersPath).sort()) {
      const path = join(membersPath, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`cutover: refusing symlinked member manifest ${path}`);
      }
      if (stat.isFile() && name.endsWith('.md')) {
        out.push(path);
      }
    }
  }
  return out;
}

function finishProductionCommit(
  journal: ProductionJournal,
  journalPath: string,
  markerPath: string,
  afterPhase?: (phase: ProductionPhase) => void
): ProductionCutoverMigrationResult {
  for (const artifact of journal.artifacts) {
    if (!journal.committedArtifacts.includes(artifact.id)) {
      commitProductionArtifact(artifact);
      journal.committedArtifacts.push(artifact.id);
      writeProductionJournal(journalPath, journal);
    }
  }

  const sessions = collectSessions(readManifestFile(journal.manifestPath)).length;
  if (sessions !== journal.sessions) {
    throw new Error(`cutover: post-commit manifest cardinality ${sessions} does not match staged ${journal.sessions}`);
  }
  validateProductionCommittedStores(journal.channelsRoot);
  writeFileAtomic(
    join(dirname(markerPath), 'session-id-map.json'),
    `${JSON.stringify({ version: PRODUCTION_MIGRATION_VERSION, entries: journal.identityMap }, null, 2)}\n`
  );
  journal.phase = 'done';
  writeProductionJournal(journalPath, journal);
  rmSync(join(dirname(markerPath), 'stage'), { recursive: true, force: true });
  // Durable commit truth, deliberately the final filesystem write.
  writeFileAtomic(markerPath, `${JSON.stringify({ version: PRODUCTION_MIGRATION_VERSION, sessions }, null, 2)}\n`);
  afterPhase?.('done');
  return { status: 'migrated', sessions, markerPath };
}

function finishProductionMarker(
  journal: ProductionJournal,
  markerPath: string,
  afterPhase?: (phase: ProductionPhase) => void
): ProductionCutoverMigrationResult {
  const sessions = collectSessions(readManifestFile(journal.manifestPath)).length;
  if (sessions !== journal.sessions) {
    throw new Error(`cutover: done journal cardinality ${journal.sessions} does not match manifest ${sessions}`);
  }
  validateProductionCommittedStores(journal.channelsRoot);
  rmSync(join(dirname(markerPath), 'stage'), { recursive: true, force: true });
  writeFileAtomic(markerPath, `${JSON.stringify({ version: PRODUCTION_MIGRATION_VERSION, sessions }, null, 2)}\n`);
  afterPhase?.('done');
  return { status: 'migrated', sessions, markerPath };
}

function commitProductionArtifact(artifact: ProductionArtifact): void {
  const sourceExists = existsSync(artifact.sourcePath);
  const backupExists = existsSync(artifact.backupPath);
  const stagedExists = artifact.stagedPath !== undefined && existsSync(artifact.stagedPath);

  if (artifact.mode === 'expire') {
    if (sourceExists && backupExists) {
      throw new Error(`cutover: both live and backup exist for ${artifact.id}; refusing ambiguous resume`);
    }
    if (sourceExists) {
      mkdirSync(dirname(artifact.backupPath), { recursive: true });
      renameSync(artifact.sourcePath, artifact.backupPath);
    } else if (artifact.sourceExisted && !backupExists) {
      throw new Error(`cutover: ${artifact.id} disappeared without a backup; refusing data loss`);
    }
    return;
  }

  if (stagedExists) {
    if (sourceExists) {
      if (backupExists) {
        throw new Error(`cutover: both live and backup exist for ${artifact.id}; refusing ambiguous resume`);
      }
      mkdirSync(dirname(artifact.backupPath), { recursive: true });
      renameSync(artifact.sourcePath, artifact.backupPath);
    } else if (artifact.sourceExisted && !backupExists) {
      throw new Error(`cutover: ${artifact.id} source disappeared before backup`);
    }
    mkdirSync(dirname(artifact.sourcePath), { recursive: true });
    renameSync(artifact.stagedPath!, artifact.sourcePath);
    return;
  }

  // Crash after staged rename but before the journal update: live + backup is
  // the fully-installed state for a replacement that originally existed.
  if (sourceExists && (!artifact.sourceExisted || backupExists)) {
    return;
  }
  throw new Error(`cutover: cannot resume replacement ${artifact.id}; staged output is missing`);
}

function validateProductionStage(manifestPath: string, channelsRoot: string, sessions: number): void {
  if (collectSessions(readManifestFile(manifestPath)).length !== sessions) {
    throw new Error('cutover: staged manifest cardinality mismatch');
  }
  validateProductionCommittedStores(channelsRoot);
}

function validateProductionCommittedStores(channelsRoot: string): void {
  const paused = JSON.parse(readFileSync(join(channelsRoot, '_engine', 'paused.json'), 'utf8')) as { version?: number; items?: unknown };
  if (paused.version !== PAUSED_STORE_VERSION || !Array.isArray(paused.items)) {
    throw new Error('cutover: paused store failed post-cutover validation');
  }
  const seed = JSON.parse(readFileSync(join(channelsRoot, '_engine', 'migration', 'seed-journal.json'), 'utf8')) as { version?: number; items?: unknown };
  if (seed.version !== SEED_JOURNAL_VERSION || !Array.isArray(seed.items)) {
    throw new Error('cutover: durability seed failed post-cutover validation');
  }
}

function readProductionMarker(path: string): { version: number; sessions: number } {
  const marker = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; sessions?: unknown };
  if (marker.version !== PRODUCTION_MIGRATION_VERSION || !Number.isSafeInteger(marker.sessions) || (marker.sessions as number) < 0) {
    throw new Error(`cutover: malformed or unknown committed marker at ${path}`);
  }
  return marker as { version: number; sessions: number };
}

function writeProductionJournal(path: string, journal: ProductionJournal): void {
  writeFileAtomic(path, `${JSON.stringify(journal, null, 2)}\n`);
}

function readProductionJournal(path: string, manifestPath: string, channelsRoot: string): ProductionJournal | null {
  if (!existsSync(path)) {
    return null;
  }
  const journal = JSON.parse(readFileSync(path, 'utf8')) as ProductionJournal;
  if (
    journal.version !== PRODUCTION_MIGRATION_VERSION ||
    !['staged', 'committing', 'done'].includes(journal.phase) ||
    journal.manifestPath !== manifestPath ||
    journal.channelsRoot !== channelsRoot ||
    !Array.isArray(journal.artifacts) ||
    !Array.isArray(journal.sourceFingerprint)
  ) {
    throw new Error(`cutover: malformed or mismatched migration journal at ${path}`);
  }
  return journal;
}

function fingerprintSources(roots: readonly string[]): SourceFingerprintEntry[] {
  const out: SourceFingerprintEntry[] = [];
  const visit = (path: string): void => {
    if (!existsSync(path)) {
      out.push({ path, kind: 'missing' });
      return;
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`cutover: refusing symlinked source entry ${path}`);
    }
    if (stat.isDirectory()) {
      out.push({ path, kind: 'directory', mtimeMs: stat.mtimeMs, ino: stat.ino });
      for (const child of readdirSync(path).sort()) {
        visit(join(path, child));
      }
      return;
    }
    if (stat.isFile()) {
      out.push({ path, kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
      return;
    }
    throw new Error(`cutover: unsupported source entry ${path}`);
  };
  for (const root of roots) {
    visit(root);
  }
  return out;
}

function assertSourceFingerprint(expected: SourceFingerprintEntry[], roots: readonly string[]): void {
  const current = fingerprintSources(roots);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error('cutover: source mutated after staging; refusing to resume commit');
  }
}

function estimateStageBytes(entries: readonly SourceFingerprintEntry[]): bigint {
  return entries.reduce((total, entry) => total + BigInt(entry.size ?? 0), 0n);
}

function assertSameFilesystem(paths: readonly string[]): void {
  const devices = new Set(paths.map((path) => statSync(path).dev));
  if (devices.size !== 1) {
    throw new Error('cutover: stage, manifest, and channels stores must share one filesystem');
  }
}

function defaultAvailableBytes(path: string): bigint {
  const stat = statfsSync(path, { bigint: true });
  return stat.bavail * stat.bsize;
}

function assertLegacyEngineInactive(
  channelsRoot: string,
  probe: (pid: number) => ProductionProcessProbe
): void {
  const path = join(channelsRoot, '_engine', 'engine.pid');
  if (!existsSync(path)) {
    return;
  }
  const lines = readFileSync(path, 'utf8').trim().split(/\s+/);
  const pid = Number.parseInt(lines[0] ?? '', 10);
  const recorded = lines[1] === undefined ? null : Number.parseInt(lines[1], 10);
  if (!Number.isSafeInteger(pid) || pid <= 0 || (recorded !== null && !Number.isSafeInteger(recorded))) {
    throw new Error(`cutover: malformed legacy channels engine lock at ${path}; refusing migration`);
  }
  const state = probe(pid);
  if (state.alive && (recorded === null || state.starttime === null || state.starttime === recorded)) {
    throw new Error(`cutover: legacy channels engine is active (pid ${pid}); stop it before migration`);
  }
}

function defaultProductionProcessProbe(pid: number): ProductionProcessProbe {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return { alive: false, starttime: null };
    }
    return { alive: true, starttime: null };
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const starttime = Number.parseInt(fields[19] ?? '', 10);
    return { alive: true, starttime: Number.isSafeInteger(starttime) ? starttime : null };
  } catch {
    return { alive: true, starttime: null };
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
/** The only phases the durability repair produces (§10); anything else is corrupt. */
const KNOWN_SEED_PHASES = new Set(['queued', 'semantic-unknown', 'submit-confirmed']);

export function readSeedJournalForConsumption(root: string): { items: SeedJournalItem[] } | null {
  const journalPath = join(migrationDir(root), 'seed-journal.json');
  if (!existsSync(journalPath)) {
    return null;
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { version?: number; committed?: unknown; items?: unknown };
  if (journal.version !== SEED_JOURNAL_VERSION) {
    throw new Error(`seed consume: unknown seed-journal version ${String(journal.version)} (fail-closed)`);
  }
  // The committed MARKER file is the commit truth; a journal claiming committed
  // without it is inconsistent and must be rejected.
  if (journal.committed !== false) {
    throw new Error('seed consume: journal committed flag is not false; the marker file is the commit truth (fail-closed)');
  }
  if (!Array.isArray(journal.items)) {
    throw new Error('seed consume: malformed seed-journal items (fail-closed)');
  }
  const items = journal.items.map((raw): SeedJournalItem => {
    const it = raw as { sessionId?: unknown; seq?: unknown; phase?: unknown; reissue?: unknown };
    // sessionId is used to build a filesystem path — grammar-validate it to block
    // empty / traversal / absolute-path ids before any join.
    if (typeof it.sessionId !== 'string' || !isValidSessionId(it.sessionId)) {
      throw new Error('seed consume: invalid sessionId (fail-closed)');
    }
    if (typeof it.seq !== 'number' || !Number.isInteger(it.seq) || it.seq < 0) {
      throw new Error(`seed consume: invalid seq for ${it.sessionId} (fail-closed)`);
    }
    if (typeof it.phase !== 'string' || !KNOWN_SEED_PHASES.has(it.phase)) {
      throw new Error(`seed consume: unknown phase for ${it.sessionId} seq ${String(it.seq)} (fail-closed)`);
    }
    if (typeof it.reissue !== 'boolean') {
      throw new Error(`seed consume: invalid reissue flag for ${it.sessionId} seq ${it.seq} (fail-closed)`);
    }
    const bodyPath = join(migrationDir(root), 'bodies', it.sessionId, `${padSeq(it.seq)}.json`);
    if (!existsSync(bodyPath)) {
      throw new Error(`seed consume: missing body for ${it.sessionId} seq ${it.seq} (fail-closed)`);
    }
    const body = JSON.parse(readFileSync(bodyPath, 'utf8')) as QueuedPrompt;
    if (body === null || typeof body !== 'object' || typeof (body as { prompt?: unknown }).prompt !== 'string') {
      throw new Error(`seed consume: malformed body for ${it.sessionId} seq ${it.seq} (fail-closed)`);
    }
    return { sessionId: it.sessionId, seq: it.seq, phase: it.phase, reissue: it.reissue, body };
  });
  return { items };
}

/** Write the durable committed marker — the engine calls this only AFTER seeding every item. */
export function markSeedCommitted(root: string): void {
  mkdirSync(migrationDir(root), { recursive: true });
  writeFileAtomic(committedMarkerPath(root), `${JSON.stringify({ version: SEED_JOURNAL_VERSION })}\n`);
}

export interface SeedDeliveryPlan {
  /** sessionId → prompts to (re)enqueue for delivery (repaired phase queued). */
  enqueue: Map<string, QueuedPrompt[]>;
  /** sessionId → seqs held as semantic-unknown — surfaced, NEVER auto-delivered. */
  held: Map<string, number[]>;
  /** sessionId → seqs recorded as already submit-confirmed — not re-delivered. */
  confirmed: Map<string, number[]>;
}

/**
 * Partition a validated seed journal into per-session delivery dispositions the
 * channels engine applies on first start: queued items re-enqueue (at-most-once
 * via the fresh keys), semantic-unknown are held (fail-closed, surfaced but never
 * auto-delivered), and submit-confirmed are recorded as already delivered so they
 * are deduped, not re-sent. Pure — the engine-wiring step consumes this.
 */
export function partitionSeedForDelivery(seed: { items: SeedJournalItem[] }): SeedDeliveryPlan {
  const enqueue = new Map<string, QueuedPrompt[]>();
  const held = new Map<string, number[]>();
  const confirmed = new Map<string, number[]>();
  const push = <T>(m: Map<string, T[]>, key: string, value: T): void => {
    const list = m.get(key);
    if (list === undefined) {
      m.set(key, [value]);
    } else {
      list.push(value);
    }
  };
  for (const item of seed.items) {
    if (item.phase === 'queued') {
      push(enqueue, item.sessionId, item.body);
    } else if (item.phase === 'semantic-unknown') {
      push(held, item.sessionId, item.seq);
    } else {
      push(confirmed, item.sessionId, item.seq); // submit-confirmed
    }
  }
  return { enqueue, held, confirmed };
}
