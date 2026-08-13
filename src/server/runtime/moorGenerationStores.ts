import { constants, type BigIntStats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rmdir,
  unlink,
  type FileHandle
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { withFileLock } from '../../shared/fileLock.js';
import { posixMoorIdentity } from './moorMasterClient.js';
import {
  MoorStoreKind,
  readMoorStoreSnapshot,
  type MoorStoreSnapshot
} from './moorStore.js';

export const MOOR_GENERATION_STORE_RETENTION = 8;

const U32_MAX = 0xffff_ffff;
const STORE_SLOTS = ['body.0', 'body.1', 'commit.0', 'commit.1'] as const;
const COPY_BUFFER_SIZE = 64 * 1024;

type StoreSlot = (typeof STORE_SLOTS)[number];
type CompanionKind = 'exit' | 'log';

export type MoorGenerationExitOutcome =
  | { readonly ended: 'exited'; readonly code: number }
  | { readonly ended: 'signalled'; readonly signal: number }
  | {
      readonly ended: 'terminated';
      readonly code: number;
      readonly method: 'graceful' | 'forced';
    };

export interface MoorGenerationExitEvidence {
  readonly generation: number;
  readonly startWallMs: string;
  readonly endWallMs: string;
  readonly outputEnd: string;
  readonly outcome: MoorGenerationExitOutcome;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface SlotIdentity extends FileIdentity {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface StoreState {
  readonly path: string;
  readonly directory: FileIdentity;
  readonly slots: ReadonlyMap<StoreSlot, SlotIdentity>;
}

interface ValidatedStore {
  readonly state: StoreState;
  readonly snapshot: MoorStoreSnapshot;
}

interface ArchiveGeneration {
  readonly generation: number;
  readonly exit?: StoreState;
  readonly log?: StoreState;
}

interface ParentBinding {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly handle: FileHandle;
}

interface ActiveTransaction {
  readonly generation: number;
  readonly stableExit: ValidatedStore;
  readonly stableLog?: ValidatedStore;
  readonly archivedExit?: StoreState;
  readonly archivedLog?: StoreState;
}

interface Analysis {
  readonly parent: ParentBinding;
  readonly inventory: ReadonlyMap<number, ArchiveGeneration>;
  readonly activeGeneration?: number;
  readonly transaction?: ActiveTransaction;
}

interface CopyContext {
  readonly kind: CompanionKind;
  readonly slot: StoreSlot;
  readonly source: string;
  readonly destination: string;
}

export type MoorGenerationStoreArchiveErrorCode = 'ARCHIVE_SLOT_SYNC_FAILED';

export class MoorGenerationStoreArchiveError extends Error {
  constructor(
    readonly code: MoorGenerationStoreArchiveErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'MoorGenerationStoreArchiveError';
  }
}

interface PruneContext {
  readonly generation: number;
  readonly kind: CompanionKind;
  readonly path: string;
  readonly slot?: StoreSlot;
}

export interface MoorGenerationStoreArchiveOptions {
  /** Test-only platform injection for descriptor-alias selection. */
  readonly platform?: NodeJS.Platform;
  readonly lockTimeoutMs?: number;
  readonly beforeParentOpen?: () => void;
  readonly afterPreflight?: () => void;
  readonly beforeCopy?: (context: CopyContext) => void;
  readonly beforeCopyAttempt?: (context: CopyContext) => void;
  readonly beforeDestinationCreate?: (context: CopyContext) => void;
  readonly afterCopyOpen?: (context: CopyContext) => void;
  /** Test-only wrapper for tracing or failing an accepted resumed-slot fsync. */
  readonly syncResumedArchiveSlot?: (
    context: CopyContext,
    durableSync: () => Promise<void>
  ) => Promise<void>;
  readonly afterExitPublished?: () => void;
  readonly afterLogPublished?: () => void;
  readonly beforePruneUnlink?: (context: PruneContext) => void;
  readonly beforePruneDirectoryRemove?: (context: PruneContext) => void;
}

export function moorDescriptorDirectoryAlias(
  descriptor: number,
  platform: NodeJS.Platform = process.platform
): string {
  if (!Number.isInteger(descriptor) || descriptor < 0) {
    throw new Error('invalid Moor directory descriptor');
  }
  if (platform === 'linux') return `/proc/self/fd/${descriptor}`;
  if (platform === 'darwin') return `/dev/fd/${descriptor}`;
  throw new Error(`unsupported platform for Moor descriptor aliases: ${platform}`);
}

export function moorGenerationArchiveLockPath(sessionPath: string): string {
  return `${sessionPath}.desk-generation-archive`;
}

function identity(metadata: BigIntStats): FileIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function slotIdentity(metadata: BigIntStats): SlotIdentity {
  return {
    ...identity(metadata),
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs
  };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSlot(left: SlotIdentity, right: SlotIdentity): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameStore(left: StoreState, right: StoreState): boolean {
  if (!sameFile(left.directory, right.directory) || left.slots.size !== right.slots.size) {
    return false;
  }
  return STORE_SLOTS.every((slot) => {
    const a = left.slots.get(slot);
    const b = right.slots.get(slot);
    return a === undefined || b === undefined ? a === b : sameSlot(a, b);
  });
}

function sameSnapshot(left: MoorStoreSnapshot, right: MoorStoreSnapshot): boolean {
  const a = left.commit;
  const b = right.commit;
  return (
    a.slot === b.slot &&
    a.bodySlot === b.bodySlot &&
    a.kind === b.kind &&
    a.generation === b.generation &&
    a.epoch === b.epoch &&
    a.index === b.index &&
    a.length === b.length &&
    a.start === b.start &&
    a.end === b.end &&
    Buffer.from(a.hash).equals(Buffer.from(b.hash)) &&
    Buffer.from(left.bytes).equals(Buffer.from(right.bytes))
  );
}

function owned(metadata: BigIntStats): boolean {
  return typeof process.getuid !== 'function' || metadata.uid === BigInt(process.getuid());
}

function safePath(path: string): string {
  const rendered = path.replace(/[\u0000-\u001f\u007f]/gu, '\ufffd');
  return rendered.length <= 512 ? rendered : `${rendered.slice(0, 509)}...`;
}

function requirePrivateDirectory(metadata: BigIntStats, path: string): void {
  if (!metadata.isDirectory()) {
    throw new Error(
      `Moor generation archive is not a directory; an owner-private directory is required: ${safePath(path)}`
    );
  }
  if (!owned(metadata) || (metadata.mode & 0o777n) !== 0o700n) {
    throw new Error(`Moor generation archive is not an owner-private directory: ${safePath(path)}`);
  }
}

function requirePrivateSlot(metadata: BigIntStats, path: string): void {
  if (
    !metadata.isFile() ||
    !owned(metadata) ||
    (metadata.mode & 0o777n) !== 0o600n ||
    metadata.nlink !== 1n
  ) {
    throw new Error(`Moor store slot is not an independent owner-private file: ${safePath(path)}`);
  }
}

async function openBoundParent(
  path: string,
  expected: FileIdentity | undefined,
  platform: NodeJS.Platform,
  beforeOpen?: () => void
): Promise<ParentBinding> {
  const before = await lstat(path, { bigint: true });
  requirePrivateDirectory(before, path);
  const expectedIdentity = expected ?? identity(before);
  if (!sameFile(identity(before), expectedIdentity)) {
    throw new Error('Moor parent directory identity changed before archival');
  }
  beforeOpen?.();
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0)
  );
  try {
    const probe = await open(
      moorDescriptorDirectoryAlias(handle.fd, platform),
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
    );
    try {
      const [pathNow, opened, probed] = await Promise.all([
        lstat(path, { bigint: true }),
        handle.stat({ bigint: true }),
        probe.stat({ bigint: true })
      ]);
      requirePrivateDirectory(pathNow, path);
      requirePrivateDirectory(opened, path);
      if (
        !sameFile(identity(pathNow), expectedIdentity) ||
        !sameFile(identity(opened), expectedIdentity) ||
        !sameFile(identity(probed), expectedIdentity)
      ) {
        throw new Error('Moor parent directory identity changed before archival');
      }
      return { path, identity: expectedIdentity, handle };
    } finally {
      await probe.close();
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function requireParent(parent: ParentBinding): Promise<void> {
  const [path, opened] = await Promise.all([
    lstat(parent.path, { bigint: true }),
    parent.handle.stat({ bigint: true })
  ]);
  requirePrivateDirectory(path, parent.path);
  requirePrivateDirectory(opened, parent.path);
  if (!sameFile(identity(path), parent.identity) || !sameFile(identity(opened), parent.identity)) {
    throw new Error('Moor parent directory identity changed during archival');
  }
}

async function inspectStore(path: string, allowEmpty = false): Promise<StoreState> {
  const before = await lstat(path, { bigint: true });
  requirePrivateDirectory(before, path);
  const names = await readdir(path);
  const extra = names.find((name) => !STORE_SLOTS.includes(name as StoreSlot));
  if (extra !== undefined) throw new Error(`unexpected Moor store entry: ${safePath(join(path, extra))}`);
  if (names.length === 0 && !allowEmpty) {
    throw new Error(`empty archive reservation requires manual recovery: ${safePath(path)}`);
  }
  const slots = new Map<StoreSlot, SlotIdentity>();
  for (const slot of STORE_SLOTS) {
    if (!names.includes(slot)) continue;
    const slotPath = join(path, slot);
    const metadata = await lstat(slotPath, { bigint: true });
    requirePrivateSlot(metadata, slotPath);
    slots.set(slot, slotIdentity(metadata));
  }
  const after = await lstat(path, { bigint: true });
  requirePrivateDirectory(after, path);
  if (!sameFile(identity(before), identity(after))) {
    throw new Error(`Moor store directory identity changed: ${safePath(path)}`);
  }
  return { path, directory: identity(after), slots };
}

function requireSameStore(actual: StoreState, expected: StoreState, message: string): void {
  if (!sameStore(actual, expected)) throw new Error(message);
}

function requireComplete(state: StoreState, message: string): void {
  if (state.slots.size !== STORE_SLOTS.length) throw new Error(message);
}

function lifecycleIdentity(snapshot: MoorStoreSnapshot): Uint8Array {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes);
  const value = JSON.parse(text.slice(0, -1)) as { session?: unknown };
  if (typeof value.session !== 'string') {
    throw new Error('Moor lifecycle manifest has no session identity');
  }
  return new Uint8Array(Buffer.from(value.session, 'base64'));
}

function validateLifecycle(snapshot: MoorStoreSnapshot, expected: Uint8Array): void {
  const actual = lifecycleIdentity(snapshot);
  if (actual.length !== expected.length || !actual.every((byte, index) => byte === expected[index])) {
    throw new Error('Moor lifecycle manifest belongs to another session');
  }
}

function decodeExitEvidence(
  snapshot: MoorStoreSnapshot,
  generation: number
): MoorGenerationExitEvidence {
  const value = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)
  ) as Record<string, unknown>;
  const { start_wall_ms: startWallMs, end_wall_ms: endWallMs, output_end: outputEnd } =
    value;
  if (
    typeof startWallMs !== 'string' ||
    typeof endWallMs !== 'string' ||
    typeof outputEnd !== 'string'
  ) {
    throw new Error('Moor lifecycle manifest has invalid exit evidence');
  }

  let outcome: MoorGenerationExitOutcome;
  if (value.ended === 'exited' && typeof value.code === 'number') {
    outcome = { ended: 'exited', code: value.code };
  } else if (value.ended === 'signalled' && typeof value.signal === 'number') {
    outcome = { ended: 'signalled', signal: value.signal };
  } else if (
    value.ended === 'terminated' &&
    typeof value.code === 'number' &&
    (value.method === 'graceful' || value.method === 'forced')
  ) {
    outcome = { ended: 'terminated', code: value.code, method: value.method };
  } else {
    throw new Error('Moor lifecycle manifest has invalid exit outcome');
  }

  return { generation, startWallMs, endWallMs, outputEnd, outcome };
}

async function validateNormalStore(
  parent: ParentBinding,
  state: StoreState,
  kind: MoorStoreKind,
  generation?: number
): Promise<ValidatedStore> {
  if (state.slots.size === 0) {
    throw new Error(`empty archive reservation requires manual recovery: ${safePath(state.path)}`);
  }
  requireComplete(
    state,
    `incomplete Moor generation archive requires manual recovery: ${safePath(state.path)}`
  );
  await requireParent(parent);
  const before = await inspectStore(state.path);
  requireSameStore(before, state, 'Moor store identity changed during validation');
  const snapshot = await readMoorStoreSnapshot(state.path, kind, generation);
  const after = await inspectStore(state.path);
  requireSameStore(after, before, 'Moor store identity changed during validation');
  await requireParent(parent);
  return { state: after, snapshot };
}

async function validateExpectedStore(
  parent: ParentBinding,
  expected: ValidatedStore,
  kind: MoorStoreKind,
  generation: number
): Promise<ValidatedStore> {
  const actual = await validateNormalStore(parent, expected.state, kind, generation);
  if (!sameSnapshot(actual.snapshot, expected.snapshot)) {
    throw new Error('Moor stable source snapshot changed during publication');
  }
  return actual;
}

async function exactFileCopy(
  sourcePath: string,
  sourceIdentity: SlotIdentity,
  archivePath: string,
  archiveIdentity: SlotIdentity
): Promise<boolean> {
  if (sameFile(sourceIdentity, archiveIdentity)) return false;
  const [source, archive] = await Promise.all([
    open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
    open(archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  ]);
  try {
    const [sourceBefore, archiveBefore] = await Promise.all([
      source.stat({ bigint: true }),
      archive.stat({ bigint: true })
    ]);
    requirePrivateSlot(sourceBefore, sourcePath);
    requirePrivateSlot(archiveBefore, archivePath);
    if (
      !sameSlot(slotIdentity(sourceBefore), sourceIdentity) ||
      !sameSlot(slotIdentity(archiveBefore), archiveIdentity) ||
      sourceBefore.size !== archiveBefore.size
    ) {
      return false;
    }
    const left = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
    const right = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
    while (true) {
      const [a, b] = await Promise.all([
        source.read(left, 0, left.length, null),
        archive.read(right, 0, right.length, null)
      ]);
      if (a.bytesRead !== b.bytesRead) return false;
      if (!left.subarray(0, a.bytesRead).equals(right.subarray(0, b.bytesRead))) return false;
      if (a.bytesRead === 0) break;
    }
    const [sourceAfter, archiveAfter] = await Promise.all([
      source.stat({ bigint: true }),
      archive.stat({ bigint: true })
    ]);
    return (
      sameSlot(slotIdentity(sourceAfter), sourceIdentity) &&
      sameSlot(slotIdentity(archiveAfter), archiveIdentity)
    );
  } finally {
    await Promise.allSettled([source.close(), archive.close()]);
  }
}

async function validateCopySubset(
  parent: ParentBinding,
  source: StoreState,
  archive: StoreState
): Promise<void> {
  await requireParent(parent);
  for (const [slot, archivedIdentity] of archive.slots) {
    const sourceIdentity = source.slots.get(slot);
    if (
      sourceIdentity === undefined ||
      !(await exactFileCopy(
        join(source.path, slot),
        sourceIdentity,
        join(archive.path, slot),
        archivedIdentity
      ))
    ) {
      throw new Error(`Moor archive collision at slot: ${safePath(join(archive.path, slot))}`);
    }
  }
  const [sourceAfter, archiveAfter] = await Promise.all([
    inspectStore(source.path, true),
    inspectStore(archive.path, true)
  ]);
  requireSameStore(sourceAfter, source, 'Moor stable source identity changed during copy validation');
  requireSameStore(archiveAfter, archive, 'Moor archive identity changed during copy validation');
  await requireParent(parent);
}

async function validateArchiveAgainstSource(
  parent: ParentBinding,
  source: ValidatedStore,
  archive: StoreState,
  kind: MoorStoreKind,
  generation: number
): Promise<void> {
  await validateExpectedStore(parent, source, kind, generation);
  await validateCopySubset(parent, source.state, archive);
  if (archive.slots.size === STORE_SLOTS.length) {
    const archived = await validateNormalStore(parent, archive, kind, generation);
    if (!sameSnapshot(archived.snapshot, source.snapshot)) {
      throw new Error(`Moor archive contents do not match stable source: ${safePath(archive.path)}`);
    }
  }
  await validateExpectedStore(parent, source, kind, generation);
}

function claimedArchiveName(suffix: string): boolean {
  const parts = suffix.split('.');
  return (
    /^[+-]?[0-9]+$/u.test(parts[0] ?? '') ||
    ['exit', 'log'].includes(parts[0] ?? '') ||
    ['exit', 'log'].includes(parts.at(-1) ?? '')
  );
}

function archivePattern(sessionPath: string): RegExp {
  const escaped = basename(sessionPath).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped}\\.([1-9][0-9]*)\\.(exit|log)$`, 'u');
}

async function readInventory(
  parent: ParentBinding,
  sessionPath: string,
  successorGeneration: number
): Promise<{
  inventory: Map<number, ArchiveGeneration>;
  stableExit?: StoreState;
  stableLog?: StoreState;
}> {
  await requireParent(parent);
  const names = await readdir(parent.path);
  const sessionName = basename(sessionPath);
  const exact = archivePattern(sessionPath);
  const claimed: Array<{ name: string; generation: number; kind: CompanionKind }> = [];
  for (const name of names) {
    if (!name.startsWith(`${sessionName}.`)) continue;
    const suffix = name.slice(sessionName.length + 1);
    if (suffix === 'exit' || suffix === 'log') continue;
    const match = exact.exec(name);
    if (match === null) {
      if (claimedArchiveName(suffix)) {
        throw new Error(`invalid Moor generation archive name: ${safePath(name)}`);
      }
      continue;
    }
    const generation = Number(match[1]);
    if (
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      generation > U32_MAX ||
      String(generation) !== match[1] ||
      generation >= successorGeneration
    ) {
      throw new Error(`invalid Moor generation archive name: ${safePath(name)}`);
    }
    claimed.push({ name, generation, kind: match[2] as CompanionKind });
  }

  const inventory = new Map<number, ArchiveGeneration>();
  for (const entry of claimed) {
    const state = await inspectStore(join(parent.path, entry.name), true);
    const current = inventory.get(entry.generation) ?? { generation: entry.generation };
    if (current[entry.kind] !== undefined) {
      throw new Error(`duplicate Moor generation archive: ${safePath(entry.name)}`);
    }
    inventory.set(entry.generation, { ...current, [entry.kind]: state });
  }
  const stableExit = names.includes(`${sessionName}.exit`)
    ? await inspectStore(`${sessionPath}.exit`, true)
    : undefined;
  const stableLog = names.includes(`${sessionName}.log`)
    ? await inspectStore(`${sessionPath}.log`, true)
    : undefined;
  await requireParent(parent);
  return { inventory, stableExit, stableLog };
}

async function validateCommittedGeneration(
  parent: ParentBinding,
  archive: ArchiveGeneration,
  sessionIdentity: Uint8Array
): Promise<MoorStoreSnapshot> {
  if (archive.exit === undefined) {
    throw new Error(`Moor log archive has no lifecycle owner: ${safePath(archive.log?.path ?? String(archive.generation))}`);
  }
  const exit = await validateNormalStore(parent, archive.exit, MoorStoreKind.Exit, archive.generation);
  validateLifecycle(exit.snapshot, sessionIdentity);
  if (archive.log !== undefined) {
    await validateNormalStore(parent, archive.log, MoorStoreKind.Log, archive.generation);
  }
  return exit.snapshot;
}

async function validateCommittedInventory(
  parent: ParentBinding,
  inventory: ReadonlyMap<number, ArchiveGeneration>,
  sessionIdentity: Uint8Array,
  except?: number
): Promise<void> {
  for (const archive of inventory.values()) {
    if (archive.generation !== except) {
      await validateCommittedGeneration(parent, archive, sessionIdentity);
    }
  }
}

function requireArchiveFrontierAtOrBefore(
  inventory: ReadonlyMap<number, ArchiveGeneration>,
  stableGeneration: number
): void {
  if ([...inventory.keys()].some((generation) => generation > stableGeneration)) {
    throw new Error('Moor stable lifecycle generation is older than an existing archive');
  }
}

function newestArchive(
  inventory: ReadonlyMap<number, ArchiveGeneration>
): ArchiveGeneration | undefined {
  return [...inventory.values()].sort((a, b) => b.generation - a.generation)[0];
}

async function validateCleanupResidue(
  parent: ParentBinding,
  stable: StoreState,
  archived: StoreState,
  kind: MoorStoreKind,
  generation: number
): Promise<void> {
  requireComplete(archived, 'stable cleanup residue has no complete archive witness');
  await validateNormalStore(parent, archived, kind, generation);
  await requireParent(parent);
  for (const [slot, stableIdentity] of stable.slots) {
    const archivedIdentity = archived.slots.get(slot)!;
    if (
      !(await exactFileCopy(
        join(archived.path, slot),
        archivedIdentity,
        join(stable.path, slot),
        stableIdentity
      ))
    ) {
      throw new Error(`stable Moor cleanup residue does not match its archive: ${safePath(join(stable.path, slot))}`);
    }
  }
  requireSameStore(
    await inspectStore(stable.path, true),
    stable,
    'stable Moor cleanup residue changed during validation'
  );
  requireSameStore(
    await inspectStore(archived.path),
    archived,
    'Moor archive changed during cleanup validation'
  );
  await requireParent(parent);
}

async function analyze(
  sessionPath: string,
  successorGeneration: number,
  sessionIdentity: Uint8Array,
  platform: NodeJS.Platform,
  expectedParent?: FileIdentity,
  beforeParentOpen?: () => void
): Promise<Analysis> {
  const parent = await openBoundParent(dirname(sessionPath), expectedParent, platform, beforeParentOpen);
  try {
    const { inventory, stableExit, stableLog } = await readInventory(
      parent,
      sessionPath,
      successorGeneration
    );
    if (stableExit === undefined) {
      if (stableLog !== undefined) throw new Error('Moor log companion has no lifecycle owner');
      await validateCommittedInventory(parent, inventory, sessionIdentity);
      return { parent, inventory };
    }

    const newest = newestArchive(inventory);
    if (stableExit.slots.size < STORE_SLOTS.length) {
      await validateCommittedInventory(parent, inventory, sessionIdentity);
      if (newest?.exit === undefined) {
        throw new Error('incomplete stable lifecycle has no complete archived transaction evidence');
      }
      await validateCleanupResidue(
        parent,
        stableExit,
        newest.exit,
        MoorStoreKind.Exit,
        newest.generation
      );
      validateLifecycle(
        (await validateNormalStore(parent, newest.exit, MoorStoreKind.Exit, newest.generation)).snapshot,
        sessionIdentity
      );
      if (stableLog !== undefined) {
        if (newest.log === undefined) {
          throw new Error('stable log cleanup residue has no complete archive witness');
        }
        await validateCleanupResidue(
          parent,
          stableLog,
          newest.log,
          MoorStoreKind.Log,
          newest.generation
        );
      }
      return { parent, inventory, activeGeneration: newest.generation };
    }

    const stableExitStore = await validateNormalStore(parent, stableExit, MoorStoreKind.Exit);
    const generation = stableExitStore.snapshot.commit.generation;
    validateLifecycle(stableExitStore.snapshot, sessionIdentity);
    if (generation >= successorGeneration) {
      throw new Error('Moor lifecycle companion is not a predecessor generation');
    }
    const active = inventory.get(generation);
    if (active?.exit !== undefined) {
      await validateArchiveAgainstSource(
        parent,
        stableExitStore,
        active.exit,
        MoorStoreKind.Exit,
        generation
      );
    }
    if (active?.log !== undefined && active.exit?.slots.size !== STORE_SLOTS.length) {
      throw new Error(
        `Moor log archive has no lifecycle owner (complete lifecycle archive required): ${safePath(active.log.path)}`
      );
    }

    let stableLogStore: ValidatedStore | undefined;
    if (stableLog?.slots.size === STORE_SLOTS.length) {
      stableLogStore = await validateNormalStore(parent, stableLog, MoorStoreKind.Log, generation);
      if (active?.log !== undefined) {
        await validateArchiveAgainstSource(
          parent,
          stableLogStore,
          active.log,
          MoorStoreKind.Log,
          generation
        );
      }
    } else if (stableLog !== undefined) {
      if (active?.log === undefined || active.exit?.slots.size !== STORE_SLOTS.length) {
        throw new Error('stable Moor log cleanup residue has no complete archived transaction witness');
      }
      await validateCleanupResidue(parent, stableLog, active.log, MoorStoreKind.Log, generation);
    } else if (active?.log !== undefined) {
      await validateNormalStore(parent, active.log, MoorStoreKind.Log, generation);
    }

    await validateCommittedInventory(parent, inventory, sessionIdentity, generation);
    requireArchiveFrontierAtOrBefore(inventory, generation);
    return {
      parent,
      inventory,
      activeGeneration: generation,
      transaction: {
        generation,
        stableExit: stableExitStore,
        ...(stableLogStore === undefined ? {} : { stableLog: stableLogStore }),
        ...(active?.exit === undefined ? {} : { archivedExit: active.exit }),
        ...(active?.log === undefined ? {} : { archivedLog: active.log })
      }
    };
  } catch (error) {
    await parent.handle.close();
    throw error;
  }
}

async function syncStoreDirectory(state: StoreState): Promise<void> {
  const handle = await open(
    state.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0)
  );
  try {
    const [path, opened] = await Promise.all([
      lstat(state.path, { bigint: true }),
      handle.stat({ bigint: true })
    ]);
    requirePrivateDirectory(path, state.path);
    requirePrivateDirectory(opened, state.path);
    if (!sameFile(identity(path), state.directory) || !sameFile(identity(opened), state.directory)) {
      throw new Error(`Moor store directory identity changed before fsync: ${safePath(state.path)}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publicationState(
  parent: ParentBinding,
  source: ValidatedStore,
  archivePath: string,
  expectedArchive: StoreState,
  kind: CompanionKind,
  generation: number
): Promise<StoreState> {
  await validateExpectedStore(
    parent,
    source,
    kind === 'exit' ? MoorStoreKind.Exit : MoorStoreKind.Log,
    generation
  );
  const archive = await inspectStore(archivePath, true);
  requireSameStore(archive, expectedArchive, 'Moor archive directory identity changed during publication');
  await validateCopySubset(parent, source.state, archive);
  return archive;
}

async function syncResumedArchiveSlot(
  parent: ParentBinding,
  archive: StoreState,
  context: CopyContext,
  expectedSlot: SlotIdentity,
  options: MoorGenerationStoreArchiveOptions
): Promise<void> {
  await requireParent(parent);
  const archiveBefore = await inspectStore(archive.path, true);
  requireSameStore(
    archiveBefore,
    archive,
    'Moor archive contents changed before resumed slot fsync'
  );

  const slotBefore = await lstat(context.destination, { bigint: true });
  requirePrivateSlot(slotBefore, context.destination);
  if (!sameSlot(slotIdentity(slotBefore), expectedSlot)) {
    throw new Error('Moor archive slot identity changed before resumed slot fsync');
  }

  // The exact 0600 owner-private mode checked above permits this write-capable
  // descriptor. O_NONBLOCK prevents a swapped special file from blocking, and
  // the descriptor is used only for metadata validation and fsync, never writes.
  const handle = await open(
    context.destination,
    constants.O_RDWR | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const [pathBeforeSync, openedBeforeSync, directoryBeforeSync] = await Promise.all([
      lstat(context.destination, { bigint: true }),
      handle.stat({ bigint: true }),
      lstat(archive.path, { bigint: true })
    ]);
    requirePrivateSlot(pathBeforeSync, context.destination);
    requirePrivateSlot(openedBeforeSync, context.destination);
    requirePrivateDirectory(directoryBeforeSync, archive.path);
    if (
      !sameSlot(slotIdentity(pathBeforeSync), expectedSlot) ||
      !sameSlot(slotIdentity(openedBeforeSync), expectedSlot) ||
      !sameFile(identity(directoryBeforeSync), archive.directory)
    ) {
      throw new Error('Moor archive slot identity changed before resumed slot fsync');
    }
    await requireParent(parent);

    try {
      let syncCalls = 0;
      const durableSync = async (): Promise<void> => {
        if (syncCalls !== 0) throw new Error('resumed Moor archive slot fsync repeated');
        syncCalls += 1;
        await handle.sync();
      };
      if (options.syncResumedArchiveSlot === undefined) {
        await durableSync();
      } else {
        await options.syncResumedArchiveSlot(context, durableSync);
      }
      if (syncCalls !== 1) throw new Error('resumed Moor archive slot fsync was skipped');
    } catch (cause) {
      throw new MoorGenerationStoreArchiveError(
        'ARCHIVE_SLOT_SYNC_FAILED',
        `failed to durably sync resumed Moor archive slot: ${safePath(context.destination)}`,
        { cause }
      );
    }

    const [pathAfterSync, openedAfterSync, directoryAfterSync] = await Promise.all([
      lstat(context.destination, { bigint: true }),
      handle.stat({ bigint: true }),
      lstat(archive.path, { bigint: true })
    ]);
    requirePrivateSlot(pathAfterSync, context.destination);
    requirePrivateSlot(openedAfterSync, context.destination);
    requirePrivateDirectory(directoryAfterSync, archive.path);
    if (
      !sameSlot(slotIdentity(pathAfterSync), expectedSlot) ||
      !sameSlot(slotIdentity(openedAfterSync), expectedSlot) ||
      !sameFile(identity(directoryAfterSync), archive.directory)
    ) {
      throw new Error('Moor archive slot identity changed during resumed slot fsync');
    }
    await requireParent(parent);
  } finally {
    await handle.close();
  }
}

async function syncResumedArchiveSlots(
  parent: ParentBinding,
  source: ValidatedStore,
  archive: StoreState,
  kind: CompanionKind,
  generation: number,
  options: MoorGenerationStoreArchiveOptions
): Promise<void> {
  for (const slot of STORE_SLOTS) {
    const expectedSlot = archive.slots.get(slot);
    if (expectedSlot === undefined) continue;
    await syncResumedArchiveSlot(
      parent,
      archive,
      {
        kind,
        slot,
        source: join(source.state.path, slot),
        destination: join(archive.path, slot)
      },
      expectedSlot,
      options
    );
  }

  // An fsync does not substitute for content, metadata, link-count, store, or
  // lifecycle validation. Recheck the exact archive transaction after every
  // accepted preexisting slot has crossed the durability boundary.
  await validateArchiveAgainstSource(
    parent,
    source,
    archive,
    kind === 'exit' ? MoorStoreKind.Exit : MoorStoreKind.Log,
    generation
  );
}

async function copySlotExclusive(
  context: CopyContext,
  expectedSource: SlotIdentity,
  expectedArchiveDirectory: FileIdentity,
  beforeDestinationCreate?: (context: CopyContext) => void,
  afterOpen?: (context: CopyContext) => void
): Promise<void> {
  const source = await open(context.source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let destination: FileHandle | undefined;
  try {
    const sourceBefore = await source.stat({ bigint: true });
    requirePrivateSlot(sourceBefore, context.source);
    if (!sameSlot(slotIdentity(sourceBefore), expectedSource)) {
      throw new Error('Moor stable source slot changed before copy');
    }
    beforeDestinationCreate?.(context);
    const [sourcePathNow, archivePathNow] = await Promise.all([
      lstat(context.source, { bigint: true }),
      lstat(dirname(context.destination), { bigint: true })
    ]);
    requirePrivateSlot(sourcePathNow, context.source);
    requirePrivateDirectory(archivePathNow, dirname(context.destination));
    if (!sameSlot(slotIdentity(sourcePathNow), expectedSource)) {
      throw new Error('Moor stable source slot changed before copy');
    }
    if (!sameFile(identity(archivePathNow), expectedArchiveDirectory)) {
      throw new Error('Moor archive directory identity changed before copy');
    }
    try {
      destination = await open(
        context.destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Moor archive collision at slot: ${safePath(context.destination)}`);
      }
      throw error;
    }
    await destination.chmod(0o600);
    afterOpen?.(context);
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, null);
        if (result.bytesWritten === 0) throw new Error('Moor archive copy made no progress');
        written += result.bytesWritten;
      }
      if (bytesRead === 0) break;
    }
    await destination.sync();
    const [sourceAfter, destinationAfter] = await Promise.all([
      source.stat({ bigint: true }),
      destination.stat({ bigint: true })
    ]);
    requirePrivateSlot(sourceAfter, context.source);
    requirePrivateSlot(destinationAfter, context.destination);
    if (
      !sameSlot(slotIdentity(sourceAfter), expectedSource) ||
      destinationAfter.size !== sourceAfter.size ||
      sameFile(identity(sourceAfter), identity(destinationAfter))
    ) {
      throw new Error('Moor archive copy identity changed during publication');
    }
  } finally {
    await Promise.allSettled([
      source.close(),
      ...(destination === undefined ? [] : [destination.close()])
    ]);
  }
}

async function publishStore(
  parent: ParentBinding,
  source: ValidatedStore,
  existing: StoreState | undefined,
  archivePath: string,
  kind: CompanionKind,
  generation: number,
  options: MoorGenerationStoreArchiveOptions
): Promise<StoreState> {
  requireComplete(source.state, `incomplete stable Moor ${kind} store`);
  await validateExpectedStore(
    parent,
    source,
    kind === 'exit' ? MoorStoreKind.Exit : MoorStoreKind.Log,
    generation
  );
  if (existing === undefined) {
    await requireParent(parent);
    try {
      await mkdir(archivePath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Moor archive reservation collision: ${safePath(archivePath)}`);
      }
      throw error;
    }
    const created = await lstat(archivePath, { bigint: true });
    if (!created.isDirectory() || !owned(created)) {
      throw new Error(`Moor archive reservation collision: ${safePath(archivePath)}`);
    }
    await chmod(archivePath, 0o700);
    const protectedDirectory = await lstat(archivePath, { bigint: true });
    requirePrivateDirectory(protectedDirectory, archivePath);
    if (!sameFile(identity(created), identity(protectedDirectory))) {
      throw new Error('Moor archive directory identity changed during reservation');
    }
    await parent.handle.sync();
    await requireParent(parent);
  }
  let archive = await inspectStore(archivePath, true);
  if (existing === undefined) {
    if (archive.slots.size !== 0) throw new Error(`Moor archive reservation collision: ${safePath(archivePath)}`);
  } else {
    requireSameStore(archive, existing, 'Moor archive contents changed before publication');
  }
  await validateArchiveAgainstSource(
    parent,
    source,
    archive,
    kind === 'exit' ? MoorStoreKind.Exit : MoorStoreKind.Log,
    generation
  );
  if (existing !== undefined) {
    await syncResumedArchiveSlots(parent, source, archive, kind, generation, options);
  }

  for (const slot of STORE_SLOTS) {
    if (archive.slots.has(slot)) continue;
    const context: CopyContext = {
      kind,
      slot,
      source: join(source.state.path, slot),
      destination: join(archivePath, slot)
    };
    options.beforeCopy?.(context);
    archive = await publicationState(parent, source, archivePath, archive, kind, generation);
    options.beforeCopyAttempt?.(context);
    archive = await publicationState(parent, source, archivePath, archive, kind, generation);
    await copySlotExclusive(
      context,
      source.state.slots.get(slot)!,
      archive.directory,
      options.beforeDestinationCreate,
      options.afterCopyOpen
    );
    await validateExpectedStore(
      parent,
      source,
      kind === 'exit' ? MoorStoreKind.Exit : MoorStoreKind.Log,
      generation
    );
    archive = await inspectStore(archivePath);
    await validateCopySubset(parent, source.state, archive);
    await syncStoreDirectory(archive);
    await parent.handle.sync();
    await requireParent(parent);
  }
  requireComplete(archive, `incomplete Moor generation archive: ${safePath(archivePath)}`);
  await validateArchiveAgainstSource(
    parent,
    source,
    archive,
    kind === 'exit' ? MoorStoreKind.Exit : MoorStoreKind.Log,
    generation
  );
  await syncStoreDirectory(archive);
  await parent.handle.sync();
  await requireParent(parent);
  return archive;
}

function removalOrder(snapshot: MoorStoreSnapshot): StoreSlot[] {
  const selectedBody = `body.${snapshot.commit.bodySlot}` as StoreSlot;
  return [...STORE_SLOTS.filter((slot) => slot !== selectedBody), selectedBody];
}

async function pruneStore(
  parent: ParentBinding,
  state: StoreState,
  snapshot: MoorStoreSnapshot,
  generation: number,
  kind: CompanionKind,
  options: MoorGenerationStoreArchiveOptions
): Promise<void> {
  let remaining = state;
  const validate = async (): Promise<void> => {
    await requireParent(parent);
    requireSameStore(
      await inspectStore(state.path, true),
      remaining,
      'Moor generation archive identity changed during pruning'
    );
    await requireParent(parent);
  };
  for (const slot of removalOrder(snapshot)) {
    await validate();
    options.beforePruneUnlink?.({ generation, kind, path: join(state.path, slot), slot });
    await validate();
    await unlink(join(state.path, slot));
    remaining = {
      ...remaining,
      slots: new Map([...remaining.slots].filter(([name]) => name !== slot))
    };
    await syncStoreDirectory(remaining);
    await parent.handle.sync();
    await validate();
  }
  options.beforePruneDirectoryRemove?.({ generation, kind, path: state.path });
  await validate();
  if (remaining.slots.size !== 0) {
    throw new Error(`unexpected archive entry before removal: ${safePath(state.path)}`);
  }
  await rmdir(state.path);
  await parent.handle.sync();
  await requireParent(parent);
}

async function pruneArchives(
  parent: ParentBinding,
  inventory: ReadonlyMap<number, ArchiveGeneration>,
  sessionIdentity: Uint8Array,
  activeGeneration: number | undefined,
  options: MoorGenerationStoreArchiveOptions
): Promise<void> {
  const ordered = [...inventory.values()].sort((a, b) => b.generation - a.generation);
  const expired = ordered.slice(MOOR_GENERATION_STORE_RETENTION);
  if (expired.some((archive) => archive.generation === activeGeneration)) {
    throw new Error('active Moor transaction falls outside archive retention');
  }
  for (const archive of expired) {
    await validateCommittedGeneration(parent, archive, sessionIdentity);
  }
  for (const archive of expired) {
    if (archive.log !== undefined) {
      const log = await validateNormalStore(parent, archive.log, MoorStoreKind.Log, archive.generation);
      await pruneStore(parent, archive.log, log.snapshot, archive.generation, 'log', options);
    }
    const exit = await validateNormalStore(parent, archive.exit!, MoorStoreKind.Exit, archive.generation);
    validateLifecycle(exit.snapshot, sessionIdentity);
    await pruneStore(parent, archive.exit!, exit.snapshot, archive.generation, 'exit', options);
  }
}

/** Read committed predecessor exits newest-first without consulting stable stores. */
export async function readMoorGenerationExitEvidence(
  sessionPath: string
): Promise<MoorGenerationExitEvidence[]> {
  const platform = process.platform;
  const sessionIdentity = posixMoorIdentity(sessionPath);
  const initialParent = await openBoundParent(dirname(sessionPath), undefined, platform);
  const parentIdentity = initialParent.identity;
  try {
    await readInventory(initialParent, sessionPath, U32_MAX);
  } finally {
    await initialParent.handle.close();
  }

  return withFileLock(
    moorGenerationArchiveLockPath(sessionPath),
    async () => {
      const parent = await openBoundParent(
        dirname(sessionPath),
        parentIdentity,
        platform
      );
      try {
        const { inventory } = await readInventory(parent, sessionPath, U32_MAX);
        const generations = [...inventory.keys()].sort((left, right) => right - left);
        const evidence: MoorGenerationExitEvidence[] = [];
        for (const generation of generations) {
          const snapshot = await validateCommittedGeneration(
            parent,
            inventory.get(generation)!,
            sessionIdentity
          );
          evidence.push(decodeExitEvidence(snapshot, generation));
        }
        return evidence;
      } finally {
        await parent.handle.close();
      }
    },
    { notFoundMessage: 'Moor parent directory disappeared while reading exit evidence' }
  );
}

/**
 * Copy predecessor evidence into generation-scoped, independent Moor stores.
 * Stable companions deliberately remain nlink-one at Moor's rendezvous so its
 * stale cleanup can first retain the lifecycle-derived artifact paths, remove
 * `.log`, `.events`, and `.exit` in that order, then remove those external
 * event/instrument artifacts while archive bytes remain readable.
 */
export async function archiveMoorGenerationStores(
  sessionPath: string,
  successorGeneration: number,
  options: MoorGenerationStoreArchiveOptions = {}
): Promise<void> {
  if (
    !Number.isInteger(successorGeneration) ||
    successorGeneration <= 1 ||
    successorGeneration > U32_MAX
  ) {
    throw new Error('successor Moor generation is out of range');
  }
  const platform = options.platform ?? process.platform;
  const sessionIdentity = posixMoorIdentity(sessionPath);

  // Read-only validation happens before proper-lockfile creates its mutex
  // directory, so malformed claimed names cannot trigger any mutation.
  const initial = await analyze(sessionPath, successorGeneration, sessionIdentity, platform);
  const parentIdentity = initial.parent.identity;
  await initial.parent.handle.close();

  await withFileLock(
    moorGenerationArchiveLockPath(sessionPath),
    async () => {
      const analysis = await analyze(
        sessionPath,
        successorGeneration,
        sessionIdentity,
        platform,
        parentIdentity,
        options.beforeParentOpen
      );
      try {
        options.afterPreflight?.();
        await requireParent(analysis.parent);
        const transaction = analysis.transaction;
        if (transaction !== undefined) {
          const archivedExit = await publishStore(
            analysis.parent,
            transaction.stableExit,
            transaction.archivedExit,
            `${sessionPath}.${transaction.generation}.exit`,
            'exit',
            transaction.generation,
            options
          );
          options.afterExitPublished?.();
          if (transaction.stableLog !== undefined) {
            requireComplete(archivedExit, 'log publication requires a complete lifecycle archive');
            await publishStore(
              analysis.parent,
              transaction.stableLog,
              transaction.archivedLog,
              `${sessionPath}.${transaction.generation}.log`,
              'log',
              transaction.generation,
              options
            );
            options.afterLogPublished?.();
          }
        }

        const final = await analyze(
          sessionPath,
          successorGeneration,
          sessionIdentity,
          platform,
          parentIdentity
        );
        try {
          await pruneArchives(
            final.parent,
            final.inventory,
            sessionIdentity,
            final.activeGeneration,
            options
          );
        } finally {
          await final.parent.handle.close();
        }
      } finally {
        await analysis.parent.handle.close();
      }
    },
    {
      ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }),
      notFoundMessage: 'Moor parent directory disappeared before archival'
    }
  );
}
