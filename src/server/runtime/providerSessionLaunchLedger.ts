import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  isValidProviderSessionId,
  PROVIDER_SESSION_PROVIDERS,
  type ProviderSessionProvider
} from '../../shared/providerSessionIdentity.js';

export type ProviderSessionLaunchState =
  | 'prepared'
  | 'authorized'
  | 'claimed'
  | 'completed';

export interface ProviderSessionLaunchAuthorization {
  authorizationId: string;
  deskSessionId: string;
  provider: ProviderSessionProvider;
  expectedPriorBinding: string | null;
  /** Current generation while prepared/authorized; claimed generation afterwards. */
  generation: number;
  state: ProviderSessionLaunchState;
}

export interface PrepareProviderSessionLaunchInput {
  deskSessionId: string;
  provider: ProviderSessionProvider;
  expectedPriorBinding: string | null;
  generation: number;
}

export interface ClaimProviderSessionLaunchInput {
  deskSessionId: string;
  provider: ProviderSessionProvider;
  currentGeneration: number;
  nextGeneration: number;
}

export type ClaimProviderSessionLaunchResult =
  | { ok: true; authorization: ProviderSessionLaunchAuthorization }
  | {
      ok: false;
      reason:
        | 'not-authorized'
        | 'reset-incomplete'
        | 'authorization-consumed'
        | 'provider-mismatch'
        | 'generation-mismatch';
    };

export interface CompleteProviderSessionLaunchInput {
  deskSessionId: string;
  provider: ProviderSessionProvider;
  providerSessionId: string;
  generation: number;
}

export type CompleteProviderSessionLaunchResult =
  | {
      ok: true;
      kind: 'completed';
      authorization: ProviderSessionLaunchAuthorization;
    }
  | { ok: true; kind: 'not-required' }
  | {
      ok: false;
      reason:
        | 'invalid-provider-session-id'
        | 'reset-incomplete'
        | 'authorization-unclaimed'
        | 'provider-mismatch'
        | 'provider-session-mismatch'
        | 'generation-mismatch';
    };

interface ProviderSessionLaunchLedgerOptions {
  createAuthorizationId?: () => string;
}

const PROVIDERS = new Set<ProviderSessionProvider>(PROVIDER_SESSION_PROVIDERS);

/**
 * Daemon-owned, append-only authorization ledger. Every mutation is fsync'd
 * before it becomes observable to its caller, so a daemon restart can never
 * turn a consumed reset into another claimable fresh launch.
 */
export class FileProviderSessionLaunchLedger {
  private readonly currentBySession = new Map<
    string,
    ProviderSessionLaunchAuthorization
  >();
  private readonly sessionByAuthorization = new Map<string, string>();
  private readonly recoveredPreparedAuthorizationIds = new Set<string>();
  private readonly createAuthorizationId: () => string;
  private fd: number | null = null;
  private appendFailure: Error | null = null;

  constructor(
    private readonly path: string,
    options: ProviderSessionLaunchLedgerOptions = {}
  ) {
    this.createAuthorizationId =
      options.createAuthorizationId ?? randomUUID;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.replay();
    this.fd = this.openDurableAppend();
  }

  current(
    deskSessionId: string
  ): ProviderSessionLaunchAuthorization | undefined {
    this.assertHealthy();
    const current = this.currentBySession.get(deskSessionId);
    return current === undefined ? undefined : structuredClone(current);
  }

  resumeRecoveredPrepared(input: {
    deskSessionId: string;
    provider: ProviderSessionProvider;
    generation: number;
  }): ProviderSessionLaunchAuthorization | undefined {
    this.assertHealthy();
    validateIdentity({ ...input, expectedPriorBinding: null });
    const current = this.currentBySession.get(input.deskSessionId);
    if (
      current?.state !== 'prepared' ||
      current.provider !== input.provider ||
      current.generation !== input.generation ||
      !this.recoveredPreparedAuthorizationIds.delete(current.authorizationId)
    ) {
      return undefined;
    }
    return structuredClone(current);
  }

  prepare(
    input: PrepareProviderSessionLaunchInput
  ): ProviderSessionLaunchAuthorization {
    this.assertHealthy();
    validateIdentity(input);
    const authorizationId = this.createAuthorizationId().trim();
    if (
      authorizationId.length === 0 ||
      authorizationId.length > 512 ||
      this.sessionByAuthorization.has(authorizationId)
    ) {
      throw new Error('provider launch authorization id is invalid or reused');
    }
    const record: ProviderSessionLaunchAuthorization = {
      authorizationId,
      ...input,
      state: 'prepared'
    };
    this.append(record);
    return structuredClone(record);
  }

  authorize(authorizationId: string): ProviderSessionLaunchAuthorization {
    this.assertHealthy();
    const sessionId = this.sessionByAuthorization.get(authorizationId);
    const current =
      sessionId === undefined
        ? undefined
        : this.currentBySession.get(sessionId);
    if (current?.authorizationId !== authorizationId) {
      throw new Error(
        `provider launch authorization ${authorizationId} is not the current authorization`
      );
    }
    if (current.state === 'authorized') return structuredClone(current);
    if (current.state !== 'prepared') {
      throw new Error(
        `provider launch authorization ${authorizationId} cannot advance from ${current.state} to authorized`
      );
    }
    const authorized = { ...current, state: 'authorized' as const };
    this.append(authorized);
    return structuredClone(authorized);
  }

  claim(
    input: ClaimProviderSessionLaunchInput
  ): ClaimProviderSessionLaunchResult {
    this.assertHealthy();
    const current = this.currentBySession.get(input.deskSessionId);
    if (current === undefined || current.state === 'completed') {
      return { ok: false, reason: 'not-authorized' };
    }
    if (current.state === 'prepared') {
      return { ok: false, reason: 'reset-incomplete' };
    }
    if (current.state === 'claimed') {
      return { ok: false, reason: 'authorization-consumed' };
    }
    if (current.provider !== input.provider) {
      return { ok: false, reason: 'provider-mismatch' };
    }
    if (
      current.generation !== input.currentGeneration ||
      input.nextGeneration !== input.currentGeneration + 1 ||
      !Number.isSafeInteger(input.nextGeneration)
    ) {
      return { ok: false, reason: 'generation-mismatch' };
    }
    const claimed: ProviderSessionLaunchAuthorization = {
      ...current,
      generation: input.nextGeneration,
      state: 'claimed'
    };
    this.append(claimed);
    return { ok: true, authorization: structuredClone(claimed) };
  }

  complete(
    input: CompleteProviderSessionLaunchInput
  ): CompleteProviderSessionLaunchResult {
    this.assertHealthy();
    if (!isValidProviderSessionId(input.provider, input.providerSessionId)) {
      return { ok: false, reason: 'invalid-provider-session-id' };
    }
    const current = this.currentBySession.get(input.deskSessionId);
    if (current === undefined || current.state === 'completed') {
      return { ok: true, kind: 'not-required' };
    }
    if (current.state === 'prepared') {
      return { ok: false, reason: 'reset-incomplete' };
    }
    if (current.state === 'authorized') {
      return { ok: false, reason: 'authorization-unclaimed' };
    }
    if (current.provider !== input.provider) {
      return { ok: false, reason: 'provider-mismatch' };
    }
    if (current.generation !== input.generation) {
      return { ok: false, reason: 'generation-mismatch' };
    }
    const completed: ProviderSessionLaunchAuthorization = {
      ...current,
      state: 'completed'
    };
    this.append(completed);
    return {
      ok: true,
      kind: 'completed',
      authorization: structuredClone(completed)
    };
  }

  completeForResumedLaunch(
    input: CompleteProviderSessionLaunchInput
  ): CompleteProviderSessionLaunchResult {
    this.assertHealthy();
    if (!isValidProviderSessionId(input.provider, input.providerSessionId)) {
      return { ok: false, reason: 'invalid-provider-session-id' };
    }
    const current = this.currentBySession.get(input.deskSessionId);
    if (current === undefined || current.state === 'completed') {
      return { ok: true, kind: 'not-required' };
    }
    if (current.state === 'claimed') {
      return this.complete(input);
    }
    if (current.provider !== input.provider) {
      return { ok: false, reason: 'provider-mismatch' };
    }
    if (current.generation !== input.generation) {
      return { ok: false, reason: 'generation-mismatch' };
    }
    if (current.expectedPriorBinding !== input.providerSessionId) {
      return { ok: false, reason: 'provider-session-mismatch' };
    }
    const completed: ProviderSessionLaunchAuthorization = {
      ...current,
      state: 'completed'
    };
    this.append(completed);
    return {
      ok: true,
      kind: 'completed',
      authorization: structuredClone(completed)
    };
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  private replay(): void {
    this.recoveredPreparedAuthorizationIds.clear();
    if (!existsSync(this.path)) return;
    const bytes = readFileSync(this.path);
    const foreignProviders = new Set<string>();
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
          this.truncateTail(offset);
          this.markRecoveredPrepared();
          return;
        }
        throw new Error(
          `corrupt provider launch ledger at byte ${offset}: malformed interior record`
        );
      }
      const foreignProvider = foreignProviderOf(parsed);
      if (foreignProvider !== undefined) {
        foreignProviders.add(foreignProvider);
        this.applyForeignRecord(parsed as Record<string, unknown>);
        if (newline === -1) this.appendRecordSeparator();
        offset = next;
        continue;
      }
      const record = parseRecord(parsed, offset);
      this.applyRecord(record, offset);
      if (newline === -1) this.appendRecordSeparator();
      offset = next;
    }
    for (const provider of foreignProviders) {
      process.stderr.write(
        `provider launch ledger: skipped records for unknown provider "${provider}"\n`
      );
    }
    this.markRecoveredPrepared();
  }

  private applyForeignRecord(record: Record<string, unknown>): void {
    if (record.state !== 'prepared' || typeof record.deskSessionId !== 'string') {
      return;
    }
    const displaced = this.currentBySession.get(record.deskSessionId);
    if (displaced !== undefined) {
      this.currentBySession.delete(record.deskSessionId);
      this.sessionByAuthorization.delete(displaced.authorizationId);
    }
  }

  private markRecoveredPrepared(): void {
    for (const current of this.currentBySession.values()) {
      if (current.state === 'prepared') {
        this.recoveredPreparedAuthorizationIds.add(current.authorizationId);
      }
    }
  }

  private append(record: ProviderSessionLaunchAuthorization): void {
    this.assertHealthy();
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
          throw new Error('provider launch ledger append made no progress');
        }
        written += count;
      }
      fsyncSync(this.fd);
      this.applyRecord(record);
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error(String(error));
      this.appendFailure = failure;
      if (this.fd !== null) {
        closeSync(this.fd);
        this.fd = null;
      }
      throw failure;
    }
  }

  private applyRecord(
    record: ProviderSessionLaunchAuthorization,
    offset?: number
  ): void {
    const current = this.currentBySession.get(record.deskSessionId);
    const location =
      offset === undefined ? '' : ` at byte ${offset}`;
    if (record.state === 'prepared') {
      if (this.sessionByAuthorization.has(record.authorizationId)) {
        throw new Error(
          `corrupt provider launch ledger${location}: authorization id reused`
        );
      }
      this.currentBySession.set(record.deskSessionId, record);
      this.sessionByAuthorization.set(
        record.authorizationId,
        record.deskSessionId
      );
      return;
    }
    if (
      current === undefined ||
      current.authorizationId !== record.authorizationId
    ) {
      throw new Error(
        `corrupt provider launch ledger${location}: transition is not current`
      );
    }
    if (
      current.provider !== record.provider ||
      current.expectedPriorBinding !== record.expectedPriorBinding
    ) {
      throw new Error(
        `corrupt provider launch ledger${location}: authorization identity changed`
      );
    }
    const legal =
      (current.state === 'prepared' &&
        record.state === 'authorized' &&
        record.generation === current.generation) ||
      (current.state === 'authorized' &&
        record.state === 'claimed' &&
        record.generation === current.generation + 1) ||
      ((current.state === 'prepared' || current.state === 'authorized') &&
        record.state === 'completed' &&
        current.expectedPriorBinding !== null &&
        record.generation === current.generation) ||
      (current.state === 'claimed' &&
        record.state === 'completed' &&
        record.generation === current.generation);
    if (!legal) {
      throw new Error(
        `corrupt provider launch ledger${location}: illegal ${current.state} -> ${record.state} transition`
      );
    }
    this.currentBySession.set(record.deskSessionId, record);
  }

  private assertHealthy(): void {
    if (this.appendFailure !== null) {
      throw new Error(
        `provider launch ledger append failed; daemon restart required: ${this.appendFailure.message}`
      );
    }
  }

  private openDurableAppend(): number {
    const fd = openSync(this.path, 'a', 0o600);
    try {
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

  private truncateTail(offset: number): void {
    const fd = openSync(this.path, 'r+');
    try {
      ftruncateSync(fd, offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private appendRecordSeparator(): void {
    const fd = openSync(this.path, 'a');
    try {
      if (writeSync(fd, '\n') !== 1) {
        throw new Error(
          'provider launch ledger separator repair made no progress'
        );
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

function validateIdentity(input: PrepareProviderSessionLaunchInput): void {
  if (
    input.deskSessionId.trim().length === 0 ||
    input.deskSessionId.length > 512
  ) {
    throw new Error('provider launch Desk session id is invalid');
  }
  if (!PROVIDERS.has(input.provider)) {
    throw new Error('provider launch provider is invalid');
  }
  if (
    input.expectedPriorBinding !== null &&
    !isValidProviderSessionId(input.provider, input.expectedPriorBinding)
  ) {
    throw new Error('provider launch expected prior binding is invalid');
  }
  if (
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0
  ) {
    throw new Error('provider launch generation is invalid');
  }
}

function foreignProviderOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  if (
    typeof record.provider !== 'string' ||
    record.provider.trim().length === 0 ||
    PROVIDERS.has(record.provider as ProviderSessionProvider)
  ) {
    return undefined;
  }
  if (
    typeof record.authorizationId !== 'string' ||
    record.authorizationId.trim().length === 0 ||
    typeof record.deskSessionId !== 'string'
  ) {
    return undefined;
  }
  return record.provider;
}

function parseRecord(
  input: unknown,
  offset: number
): ProviderSessionLaunchAuthorization {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidRecord(offset);
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(',') !==
    'authorizationId,deskSessionId,expectedPriorBinding,generation,provider,state'
  ) {
    throw invalidRecord(offset);
  }
  const state = record.state;
  if (
    typeof record.authorizationId !== 'string' ||
    record.authorizationId.trim().length === 0 ||
    record.authorizationId.length > 512 ||
    typeof record.deskSessionId !== 'string' ||
    typeof record.provider !== 'string' ||
    !PROVIDERS.has(record.provider as ProviderSessionProvider) ||
    (state !== 'prepared' &&
      state !== 'authorized' &&
      state !== 'claimed' &&
      state !== 'completed') ||
    (record.expectedPriorBinding !== null &&
      typeof record.expectedPriorBinding !== 'string') ||
    !Number.isSafeInteger(record.generation)
  ) {
    throw invalidRecord(offset);
  }
  const parsed: ProviderSessionLaunchAuthorization = {
    authorizationId: record.authorizationId,
    deskSessionId: record.deskSessionId,
    provider: record.provider as ProviderSessionProvider,
    expectedPriorBinding: record.expectedPriorBinding as string | null,
    generation: record.generation as number,
    state
  };
  validateIdentity({
    deskSessionId: parsed.deskSessionId,
    provider: parsed.provider,
    expectedPriorBinding: parsed.expectedPriorBinding,
    generation: parsed.generation
  });
  return parsed;
}

function invalidRecord(offset: number): Error {
  return new Error(
    `corrupt provider launch ledger at byte ${offset}: invalid authorization record`
  );
}
