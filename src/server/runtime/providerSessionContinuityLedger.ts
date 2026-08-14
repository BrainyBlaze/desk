import {
  randomBytes as createRandomBytes,
  randomUUID,
  timingSafeEqual
} from 'node:crypto';
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync
} from 'node:fs';
import { dirname } from 'node:path';
import { isValidProviderSessionId } from '../../shared/providerSessionIdentity.js';

export type ProviderSessionContinuityProvider = 'claude' | 'codex';

export interface IssueProviderLaunchProofInput {
  deskSessionId: string;
  provider: ProviderSessionContinuityProvider;
  generation: number;
  issuedAt: number;
}

export interface IssuedProviderLaunchProof extends IssueProviderLaunchProofInput {
  launchProof: string;
}

export interface VerifyProviderLaunchProofInput
  extends Omit<IssuedProviderLaunchProof, 'issuedAt'> {}

export type VerifyProviderLaunchProofResult =
  | { ok: true; issuedAt: number }
  | {
      ok: false;
      reason:
        | 'proof-not-found'
        | 'provider-mismatch'
        | 'generation-mismatch'
        | 'proof-invalid'
        | 'proof-mismatch';
    };

export interface StageProviderSessionTransitionInput {
  deskSessionId: string;
  provider: ProviderSessionContinuityProvider;
  generation: number;
  expectedProviderSessionId: string;
  observedProviderSessionId: string;
  evidencePath: string;
}

export interface PendingProviderSessionTransition
  extends StageProviderSessionTransitionInput {
  transitionId: string;
  state: 'pending';
}

export interface ResolvedProviderSessionTransition
  extends Omit<PendingProviderSessionTransition, 'state'> {
  state: 'resolved';
}

export interface CancelledProviderSessionTransition
  extends Omit<PendingProviderSessionTransition, 'state'> {
  state: 'cancelled-by-reset';
  resetAuthorizationId: string;
}

export type ProviderSessionTransition =
  | PendingProviderSessionTransition
  | ResolvedProviderSessionTransition
  | CancelledProviderSessionTransition;

export interface ProviderSessionTransitionProjection {
  deskSessionId: string;
  provider: ProviderSessionContinuityProvider;
  generation: number;
  expectedProviderSessionId: string;
  observedProviderSessionId: string;
  state: ProviderSessionTransition['state'];
}

interface ProviderSessionContinuityLedgerOptions {
  randomBytes?: () => Buffer;
  createTransitionId?: () => string;
  readOnly?: boolean;
}

interface ProofRecord extends IssuedProviderLaunchProof {
  version: 1;
  type: 'proof-issued';
}

type TransitionRecord = ProviderSessionTransition & {
  version: 1;
  type: 'transition';
};

type ContinuityRecord = ProofRecord | TransitionRecord;

const PROVIDERS = new Set<ProviderSessionContinuityProvider>([
  'claude',
  'codex'
]);

export class FileProviderSessionContinuityLedger {
  private readonly proofsBySession = new Map<string, ProofRecord>();
  private readonly transitionsBySession = new Map<string, TransitionRecord>();
  private readonly transitionIds = new Set<string>();
  private readonly randomBytes: () => Buffer;
  private readonly createTransitionId: () => string;
  private readonly readOnly: boolean;
  private fd: number | null = null;
  private appendFailure: Error | null = null;

  constructor(
    private readonly path: string,
    options: ProviderSessionContinuityLedgerOptions = {}
  ) {
    this.randomBytes = options.randomBytes ?? (() => createRandomBytes(32));
    this.createTransitionId = options.createTransitionId ?? randomUUID;
    this.readOnly = options.readOnly ?? false;
    if (this.readOnly) {
      this.replayReadOnly();
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.fd = this.openDurableAppend();
    try {
      this.replay(this.fd, false);
    } catch (error) {
      closeSync(this.fd);
      this.fd = null;
      throw error;
    }
  }

  issueLaunchProof(input: IssueProviderLaunchProofInput): IssuedProviderLaunchProof {
    this.assertHealthy();
    validateLaunchIdentity(input);
    const current = this.proofsBySession.get(input.deskSessionId);
    if (
      current &&
      (current.provider !== input.provider ||
        input.generation < current.generation ||
        (input.generation === current.generation &&
          input.issuedAt < current.issuedAt))
    ) {
      throw new Error('provider launch proof identity moved backwards');
    }
    const bytes = this.randomBytes();
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
      throw new Error('provider launch proof source must return exactly 32 bytes');
    }
    const record: ProofRecord = {
      version: 1,
      type: 'proof-issued',
      ...input,
      launchProof: bytes.toString('base64url')
    };
    this.append(record);
    return publicProof(record);
  }

  verifyLaunchProof(
    input: VerifyProviderLaunchProofInput
  ): VerifyProviderLaunchProofResult {
    this.assertHealthy();
    const current = this.proofsBySession.get(input.deskSessionId);
    if (!current) return { ok: false, reason: 'proof-not-found' };
    if (current.provider !== input.provider) {
      return { ok: false, reason: 'provider-mismatch' };
    }
    if (current.generation !== input.generation) {
      return { ok: false, reason: 'generation-mismatch' };
    }
    const received = decodeLaunchProof(input.launchProof);
    const expected = decodeLaunchProof(current.launchProof);
    if (!received || !expected) return { ok: false, reason: 'proof-invalid' };
    if (!timingSafeEqual(received, expected)) {
      return { ok: false, reason: 'proof-mismatch' };
    }
    return { ok: true, issuedAt: current.issuedAt };
  }

  proofContext(
    deskSessionId: string
  ): Omit<IssuedProviderLaunchProof, 'launchProof'> | undefined {
    this.assertHealthy();
    const current = this.proofsBySession.get(deskSessionId);
    if (!current) return undefined;
    return {
      deskSessionId: current.deskSessionId,
      provider: current.provider,
      generation: current.generation,
      issuedAt: current.issuedAt
    };
  }

  stageTransition(
    input: StageProviderSessionTransitionInput
  ): PendingProviderSessionTransition {
    this.assertHealthy();
    validateTransitionIdentity(input);
    const current = this.transitionsBySession.get(input.deskSessionId);
    if (current?.state === 'pending') {
      if (
        current.provider !== input.provider ||
        current.generation !== input.generation ||
        current.expectedProviderSessionId !== input.expectedProviderSessionId
      ) {
        throw new Error('provider pending transition identity changed');
      }
      if (
        current.observedProviderSessionId === input.observedProviderSessionId &&
        current.evidencePath === input.evidencePath
      ) {
        return publicTransition(current) as PendingProviderSessionTransition;
      }
    } else if (
      current &&
      !isValidTransitionSuccessor(current, input)
    ) {
      throw new Error('provider pending transition identity changed');
    }

    const transitionId = this.createTransitionId().trim();
    if (
      transitionId.length === 0 ||
      transitionId.length > 512 ||
      this.transitionIds.has(transitionId)
    ) {
      throw new Error('provider transition id is invalid or reused');
    }
    const record: TransitionRecord = {
      version: 1,
      type: 'transition',
      ...input,
      transitionId,
      state: 'pending'
    };
    this.append(record);
    return publicTransition(record) as PendingProviderSessionTransition;
  }

  pending(deskSessionId: string): PendingProviderSessionTransition | undefined {
    this.assertHealthy();
    const current = this.transitionsBySession.get(deskSessionId);
    return current?.state === 'pending'
      ? (publicTransition(current) as PendingProviderSessionTransition)
      : undefined;
  }

  currentTransition(deskSessionId: string): ProviderSessionTransition | undefined {
    this.assertHealthy();
    const current = this.transitionsBySession.get(deskSessionId);
    return current ? publicTransition(current) : undefined;
  }

  resolveTransition(input: {
    deskSessionId: string;
    transitionId: string;
    targetProviderSessionId: string;
  }): ResolvedProviderSessionTransition {
    this.assertHealthy();
    const current = this.transitionsBySession.get(input.deskSessionId);
    if (
      current?.state === 'resolved' &&
      current.transitionId === input.transitionId &&
      current.observedProviderSessionId === input.targetProviderSessionId
    ) {
      return publicTransition(current) as ResolvedProviderSessionTransition;
    }
    if (
      current?.state !== 'pending' ||
      current.transitionId !== input.transitionId ||
      current.observedProviderSessionId !== input.targetProviderSessionId
    ) {
      throw new Error('provider transition is not the current pending transition');
    }
    const record: TransitionRecord = { ...current, state: 'resolved' };
    this.append(record);
    return publicTransition(record) as ResolvedProviderSessionTransition;
  }

  cancelTransitionByReset(input: {
    deskSessionId: string;
    transitionId: string;
    resetAuthorizationId: string;
  }): CancelledProviderSessionTransition {
    this.assertHealthy();
    const current = this.transitionsBySession.get(input.deskSessionId);
    if (
      current?.state === 'cancelled-by-reset' &&
      current.transitionId === input.transitionId
    ) {
      if (current.resetAuthorizationId !== input.resetAuthorizationId) {
        throw new Error('provider transition reset authorization changed');
      }
      return publicTransition(current) as CancelledProviderSessionTransition;
    }
    if (
      (current?.state !== 'pending' && current?.state !== 'resolved') ||
      current.transitionId !== input.transitionId ||
      input.resetAuthorizationId.trim().length === 0
    ) {
      throw new Error(
        'provider transition is not the current non-cancelled transition'
      );
    }
    const record: TransitionRecord = {
      ...current,
      state: 'cancelled-by-reset',
      resetAuthorizationId: input.resetAuthorizationId
    };
    this.append(record);
    return publicTransition(record) as CancelledProviderSessionTransition;
  }

  projectedTransitions(): ProviderSessionTransitionProjection[] {
    this.assertHealthy();
    return [...this.transitionsBySession.values()].map(publicProjection);
  }

  projection(): string {
    return JSON.stringify({
      version: 1,
      transitions: this.projectedTransitions()
    });
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  private replay(fd: number, readOnly: boolean): void {
    const bytes = readFileSync(fd);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const next = newline === -1 ? bytes.length : newline + 1;
      const line = bytes.subarray(offset, end).toString('utf8');
      if (line.length === 0) {
        offset = next;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (newline === -1) {
          if (readOnly) return;
          ftruncateSync(fd, offset);
          fsyncSync(fd);
          return;
        }
        throw new Error(
          `corrupt provider continuity ledger at byte ${offset}: malformed interior record`
        );
      }
      this.applyRecord(parseRecord(parsed, offset), offset);
      if (newline === -1 && !readOnly) {
        if (writeSync(fd, '\n') !== 1) {
          throw new Error(
            'provider continuity ledger separator repair made no progress'
          );
        }
        fsyncSync(fd);
      }
      offset = next;
    }
  }

  private append(record: ContinuityRecord): void {
    this.assertHealthy();
    if (this.readOnly) {
      throw new Error('provider continuity ledger is read-only');
    }
    if (this.fd === null) this.fd = this.openDurableAppend();
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    let written = 0;
    try {
      while (written < bytes.length) {
        const count = writeSync(
          this.fd,
          bytes,
          written,
          bytes.length - written
        );
        if (count <= 0) {
          throw new Error('provider continuity ledger append made no progress');
        }
        written += count;
      }
      fsyncSync(this.fd);
      this.applyRecord(record);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.appendFailure = failure;
      if (this.fd !== null) {
        closeSync(this.fd);
        this.fd = null;
      }
      throw failure;
    }
  }

  private applyRecord(record: ContinuityRecord, offset?: number): void {
    const location = offset === undefined ? '' : ` at byte ${offset}`;
    if (record.type === 'proof-issued') {
      const current = this.proofsBySession.get(record.deskSessionId);
      if (
        current &&
        (current.provider !== record.provider ||
          record.generation < current.generation ||
          (record.generation === current.generation &&
            record.issuedAt < current.issuedAt))
      ) {
        throw new Error(
          `corrupt provider continuity ledger${location}: launch proof identity moved backwards`
        );
      }
      this.proofsBySession.set(record.deskSessionId, record);
      return;
    }

    const current = this.transitionsBySession.get(record.deskSessionId);
    if (record.state === 'pending') {
      if (this.transitionIds.has(record.transitionId)) {
        throw new Error(
          `corrupt provider continuity ledger${location}: transition id reused`
        );
      }
      if (
        current?.state === 'pending' &&
        (current.provider !== record.provider ||
          current.generation !== record.generation ||
          current.expectedProviderSessionId !== record.expectedProviderSessionId)
      ) {
        throw new Error(
          `corrupt provider continuity ledger${location}: pending transition identity changed`
        );
      }
      if (
        current &&
        current.state !== 'pending' &&
        !isValidTransitionSuccessor(current, record)
      ) {
        throw new Error(
          `corrupt provider continuity ledger${location}: successor transition identity changed`
        );
      }
      this.transitionIds.add(record.transitionId);
      this.transitionsBySession.set(record.deskSessionId, record);
      return;
    }
    if (current === undefined) {
      throw new Error(
        `corrupt provider continuity ledger${location}: transition resolution is not current`
      );
    }
    const validPredecessor =
      record.state === 'resolved'
        ? current.state === 'pending'
        : current.state === 'pending' || current.state === 'resolved';
    if (
      !validPredecessor ||
      current.transitionId !== record.transitionId ||
      current.provider !== record.provider ||
      current.generation !== record.generation ||
      current.expectedProviderSessionId !== record.expectedProviderSessionId ||
      current.observedProviderSessionId !== record.observedProviderSessionId ||
      current.evidencePath !== record.evidencePath
    ) {
      throw new Error(
        `corrupt provider continuity ledger${location}: transition resolution is not current`
      );
    }
    this.transitionsBySession.set(record.deskSessionId, record);
  }

  private assertHealthy(): void {
    if (this.appendFailure) {
      throw new Error(
        `provider continuity ledger append failed; daemon restart required: ${this.appendFailure.message}`
      );
    }
  }

  private openDurableAppend(): number {
    const fd = this.openLedger(
        fsConstants.O_RDWR |
        fsConstants.O_APPEND |
        fsConstants.O_CREAT,
      0o600
    );
    try {
      this.assertPrivateLedger(fd);
      fsyncSync(fd);
      const directoryFd = openSync(dirname(this.path), 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  private replayReadOnly(): void {
    let fd: number;
    try {
      fd = this.openLedger(fsConstants.O_RDONLY);
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) return;
      throw error;
    }
    try {
      this.assertPrivateLedger(fd);
      this.replay(fd, true);
    } finally {
      closeSync(fd);
    }
  }

  private openLedger(flags: number, mode?: number): number {
    try {
      return openSync(
        this.path,
        flags | (fsConstants.O_NOFOLLOW ?? 0),
        mode
      );
    } catch (error) {
      if (isFileSystemError(error, 'ELOOP')) {
        throw new Error(
          'provider continuity ledger path must not be a symbolic link'
        );
      }
      throw error;
    }
  }

  private assertPrivateLedger(fd: number): void {
    const metadata = fstatSync(fd);
    if (!metadata.isFile()) {
      throw new Error('provider continuity ledger must be a regular file');
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error('provider continuity ledger permissions must be 0600');
    }
    if (
      typeof process.getuid === 'function' &&
      metadata.uid !== process.getuid()
    ) {
      throw new Error('provider continuity ledger must be owned by the daemon user');
    }
  }
}

function publicProof(record: ProofRecord): IssuedProviderLaunchProof {
  return {
    deskSessionId: record.deskSessionId,
    provider: record.provider,
    generation: record.generation,
    issuedAt: record.issuedAt,
    launchProof: record.launchProof
  };
}

function publicTransition(record: TransitionRecord): ProviderSessionTransition {
  const common = {
    transitionId: record.transitionId,
    deskSessionId: record.deskSessionId,
    provider: record.provider,
    generation: record.generation,
    expectedProviderSessionId: record.expectedProviderSessionId,
    observedProviderSessionId: record.observedProviderSessionId,
    evidencePath: record.evidencePath
  };
  return record.state === 'cancelled-by-reset'
    ? {
        ...common,
        state: record.state,
        resetAuthorizationId: record.resetAuthorizationId
      }
    : { ...common, state: record.state };
}

function publicProjection(
  record: TransitionRecord
): ProviderSessionTransitionProjection {
  return {
    deskSessionId: record.deskSessionId,
    provider: record.provider,
    generation: record.generation,
    expectedProviderSessionId: record.expectedProviderSessionId,
    observedProviderSessionId: record.observedProviderSessionId,
    state: record.state
  };
}

function decodeLaunchProof(value: string): Buffer | undefined {
  if (typeof value !== 'string' || value.length !== 43) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

function validateLaunchIdentity(input: IssueProviderLaunchProofInput): void {
  if (
    !isSafeSessionId(input.deskSessionId) ||
    !PROVIDERS.has(input.provider) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0 ||
    !Number.isSafeInteger(input.issuedAt) ||
    input.issuedAt < 0
  ) {
    throw new Error('provider launch proof identity is invalid');
  }
}

function validateTransitionIdentity(
  input: StageProviderSessionTransitionInput
): void {
  validateLaunchIdentity({
    deskSessionId: input.deskSessionId,
    provider: input.provider,
    generation: input.generation,
    issuedAt: 0
  });
  if (
    !isValidProviderSessionId(input.provider, input.expectedProviderSessionId) ||
    !isValidProviderSessionId(input.provider, input.observedProviderSessionId) ||
    input.expectedProviderSessionId === input.observedProviderSessionId ||
    input.evidencePath.length === 0 ||
    input.evidencePath.length > 16_384 ||
    input.evidencePath.includes('\0')
  ) {
    throw new Error('provider transition identity is invalid');
  }
}

function isValidTransitionSuccessor(
  current: Exclude<TransitionRecord, PendingProviderSessionTransition>,
  successor: StageProviderSessionTransitionInput
): boolean {
  if (current.provider !== successor.provider) return false;
  if (current.state === 'resolved') {
    return (
      successor.generation >= current.generation &&
      successor.expectedProviderSessionId ===
        current.observedProviderSessionId
    );
  }
  return successor.generation > current.generation;
}

function isSafeSessionId(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes('\0')
  );
}

function parseRecord(input: unknown, offset: number): ContinuityRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidRecord(offset);
  }
  const record = input as Record<string, unknown>;
  if (record.version !== 1 || (record.type !== 'proof-issued' && record.type !== 'transition')) {
    throw invalidRecord(offset);
  }
  if (record.type === 'proof-issued') {
    const keys = Object.keys(record).sort().join(',');
    if (
      keys !== 'deskSessionId,generation,issuedAt,launchProof,provider,type,version' ||
      typeof record.deskSessionId !== 'string' ||
      (record.provider !== 'claude' && record.provider !== 'codex') ||
      typeof record.launchProof !== 'string' ||
      decodeLaunchProof(record.launchProof) === undefined ||
      !Number.isSafeInteger(record.generation) ||
      !Number.isSafeInteger(record.issuedAt)
    ) {
      throw invalidRecord(offset);
    }
    const parsed: ProofRecord = {
      version: 1,
      type: 'proof-issued',
      deskSessionId: record.deskSessionId,
      provider: record.provider,
      generation: record.generation as number,
      issuedAt: record.issuedAt as number,
      launchProof: record.launchProof
    };
    validateLaunchIdentity(parsed);
    return parsed;
  }

  const state = record.state;
  const expectedKeys =
    state === 'cancelled-by-reset'
      ? 'deskSessionId,evidencePath,expectedProviderSessionId,generation,observedProviderSessionId,provider,resetAuthorizationId,state,transitionId,type,version'
      : 'deskSessionId,evidencePath,expectedProviderSessionId,generation,observedProviderSessionId,provider,state,transitionId,type,version';
  if (
    Object.keys(record).sort().join(',') !== expectedKeys ||
    (state !== 'pending' && state !== 'resolved' && state !== 'cancelled-by-reset') ||
    typeof record.transitionId !== 'string' ||
    typeof record.deskSessionId !== 'string' ||
    (record.provider !== 'claude' && record.provider !== 'codex') ||
    typeof record.expectedProviderSessionId !== 'string' ||
    typeof record.observedProviderSessionId !== 'string' ||
    typeof record.evidencePath !== 'string' ||
    !Number.isSafeInteger(record.generation) ||
    (state === 'cancelled-by-reset' &&
      (typeof record.resetAuthorizationId !== 'string' ||
        record.resetAuthorizationId.length === 0))
  ) {
    throw invalidRecord(offset);
  }
  const parsed = {
    version: 1 as const,
    type: 'transition' as const,
    transitionId: record.transitionId,
    deskSessionId: record.deskSessionId,
    provider: record.provider,
    generation: record.generation as number,
    expectedProviderSessionId: record.expectedProviderSessionId,
    observedProviderSessionId: record.observedProviderSessionId,
    evidencePath: record.evidencePath,
    state,
    ...(state === 'cancelled-by-reset'
      ? { resetAuthorizationId: record.resetAuthorizationId as string }
      : {})
  } as TransitionRecord;
  if (
    parsed.transitionId.length === 0 ||
    parsed.transitionId.length > 512
  ) {
    throw invalidRecord(offset);
  }
  validateTransitionIdentity(parsed);
  return parsed;
}

function invalidRecord(offset: number): Error {
  return new Error(
    `corrupt provider continuity ledger at byte ${offset}: invalid record`
  );
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
