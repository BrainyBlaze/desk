import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionSpec } from '../core/types.js';
import { sessionStateSubjectFor } from '../shared/controlPlane/sessionSubject.js';
import { claudeMemoryProjectSlug } from './claudeProfileMemory.js';

import type { ProviderSessionProvider } from '../shared/providerSessionIdentity.js';

export type ClaudeContinuityAttentionCode =
  | 'continuity-resume-unconfirmed'
  | 'continuity-store-corrupt'
  | 'claude-memory-conflicts'
  | 'claude-memory-sync-failed'
  | 'provider-session-rebind-required'
  | 'provider-session-reset-incomplete'
  | 'provider-session-identity-missing';

export interface ClaudeContinuityAttention {
  sessionId: string;
  profileId?: string;
  cwd: string;
  code: ClaudeContinuityAttentionCode;
  message: string;
  count?: number;
  provider?: ProviderSessionProvider;
  durableProviderSessionId?: string;
  observedProviderSessionId?: string;
  action?: string;
}

export interface ClaudeContinuityStatus {
  issues: ClaudeContinuityAttention[];
}

interface ReadClaudeContinuityStatusOptions {
  homeDir: string;
  runningSessions: ReadonlySet<string>;
}

function providerIdentityIssue(
  session: SessionSpec,
  runningSessions: ReadonlySet<string>
): ClaudeContinuityAttention | undefined {
  if (
    !runningSessions.has(session.sessionId) ||
    session.resume !== undefined
  ) {
    return undefined;
  }
  const subject = sessionStateSubjectFor(session);
  if (subject.kind !== 'agent' || subject.mode !== 'terminal') {
    return undefined;
  }
  return {
    sessionId: session.sessionId,
    ...(session.profileId === undefined
      ? {}
      : { profileId: session.profileId }),
    cwd: session.cwd,
    code: 'provider-session-identity-missing',
    message: `Running ${subject.provider} terminal session has no durable provider session identity`
  };
}

function readJsonRecord(path: string): Record<string, unknown> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error('record is not a bounded regular file');
  }
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('record is not an object');
  }
  return value as Record<string, unknown>;
}

function activationIssue(
  session: SessionSpec,
  homeDir: string
): ClaudeContinuityAttention | undefined {
  const path = join(
    homeDir,
    '.config',
    'desk',
    'continuity',
    'claude',
    'activations',
    `${session.sessionId}.json`
  );
  if (!existsSync(path)) return undefined;
  try {
    const record = readJsonRecord(path);
    if (
      record.policyVersion !== 1 ||
      record.deskSessionId !== session.sessionId ||
      typeof record.generationId !== 'string' ||
      typeof record.providerSessionId !== 'string' ||
      typeof record.sourceProfileId !== 'string' ||
      typeof record.targetProfileId !== 'string' ||
      typeof record.projectSlug !== 'string' ||
      typeof record.state !== 'string'
    ) {
      throw new Error('activation identity is invalid');
    }
    if (record.state === 'ready') return undefined;
    if (
      record.state !== 'starting-unconfirmed' &&
      record.state !== 'needs-attention'
    ) {
      throw new Error('activation state is invalid');
    }
    const code =
      record.errorCode === 'continuity-store-corrupt'
        ? 'continuity-store-corrupt'
        : 'continuity-resume-unconfirmed';
    return {
      sessionId: session.sessionId,
      ...(session.profileId === undefined
        ? {}
        : { profileId: session.profileId }),
      cwd: session.cwd,
      code,
      message:
        record.state === 'starting-unconfirmed'
          ? 'Claude resume confirmation is pending'
          : code === 'continuity-store-corrupt'
            ? 'Claude continuity artifacts need attention'
            : 'Claude resumed with an unexpected provider session'
    };
  } catch (error) {
    return {
      sessionId: session.sessionId,
      ...(session.profileId === undefined
        ? {}
        : { profileId: session.profileId }),
      cwd: session.cwd,
      code: 'continuity-store-corrupt',
      message: `Claude continuity status is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
}

function memoryIssues(
  session: SessionSpec,
  homeDir: string
): ClaudeContinuityAttention[] {
  const slug = claudeMemoryProjectSlug(session.cwd);
  const path = join(
    homeDir,
    '.config',
    'desk',
    'continuity',
    'claude-memory',
    'projects',
    slug,
    'branches',
    session.profileId ?? '_ambient',
    'state.json'
  );
  if (!existsSync(path)) return [];
  const base = {
    sessionId: session.sessionId,
    ...(session.profileId === undefined
      ? {}
      : { profileId: session.profileId }),
    cwd: session.cwd
  };
  try {
    const record = readJsonRecord(path);
    if (
      record.policyVersion !== 1 ||
      record.projectSlug !== slug ||
      record.profileId !== (session.profileId ?? null) ||
      !Array.isArray(record.conflictIds) ||
      !record.conflictIds.every((value) => typeof value === 'string') ||
      (record.syncError !== undefined && typeof record.syncError !== 'string')
    ) {
      throw new Error('branch state is invalid');
    }
    const issues: ClaudeContinuityAttention[] = [];
    if (record.conflictIds.length > 0) {
      issues.push({
        ...base,
        code: 'claude-memory-conflicts',
        message: `${record.conflictIds.length} Claude memory conflict${
          record.conflictIds.length === 1 ? '' : 's'
        } preserved`,
        count: record.conflictIds.length
      });
    }
    if (typeof record.syncError === 'string' && record.syncError !== '') {
      issues.push({
        ...base,
        code: 'claude-memory-sync-failed',
        message: `Claude memory sync failed: ${record.syncError}`
      });
    }
    return issues;
  } catch (error) {
    return [
      {
        ...base,
        code: 'claude-memory-sync-failed',
        message: `Claude memory status is unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
    ];
  }
}

export function readClaudeContinuityStatus(
  sessions: readonly SessionSpec[],
  options: ReadClaudeContinuityStatusOptions
): ClaudeContinuityStatus {
  const issues: ClaudeContinuityAttention[] = [];
  for (const session of sessions) {
    const providerIdentity = providerIdentityIssue(
      session,
      options.runningSessions
    );
    if (providerIdentity) issues.push(providerIdentity);
    if (session.agent !== 'claude') continue;
    const activation = activationIssue(session, options.homeDir);
    if (activation) issues.push(activation);
    issues.push(...memoryIssues(session, options.homeDir));
  }
  return { issues };
}
