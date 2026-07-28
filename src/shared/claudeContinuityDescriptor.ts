import { isAbsolute } from 'node:path';
import { isValidProfileId } from './agentProfiles.js';

export interface ClaudeContinuityDescriptor {
  schemaVersion: 1;
  provider: 'claude';
  providerSessionId: string;
  cwd: string;
  profileId: string | null;
}

export interface ClaudeProfileMemoryDescriptor {
  schemaVersion: 1;
  provider: 'claude';
  cwd: string;
  profileId: string;
}

interface ClaudeContinuitySession {
  agent?: string;
  resume?: string;
  cwd: string;
  profileId?: string;
}

const CLAUDE_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function claudeContinuityDescriptorFor(
  session: ClaudeContinuitySession
): ClaudeContinuityDescriptor | undefined {
  if (session.agent !== 'claude' || !session.resume) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    provider: 'claude',
    providerSessionId: session.resume,
    cwd: session.cwd,
    profileId: session.profileId ?? null
  };
}

export function claudeProfileMemoryDescriptorFor(
  session: ClaudeContinuitySession
): ClaudeProfileMemoryDescriptor | undefined {
  if (session.agent !== 'claude' || !session.profileId) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    provider: 'claude',
    cwd: session.cwd,
    profileId: session.profileId
  };
}

export function readClaudeContinuityDescriptor(
  value: unknown
): ClaudeContinuityDescriptor | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('continuity must be a Claude continuity descriptor');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.provider !== 'claude' ||
    typeof record.providerSessionId !== 'string' ||
    !CLAUDE_SESSION_UUID.test(record.providerSessionId) ||
    typeof record.cwd !== 'string' ||
    !isAbsolute(record.cwd) ||
    !(
      record.profileId === null ||
      (typeof record.profileId === 'string' && isValidProfileId(record.profileId))
    )
  ) {
    throw new Error('invalid Claude continuity descriptor');
  }
  return {
    schemaVersion: 1,
    provider: 'claude',
    providerSessionId: record.providerSessionId,
    cwd: record.cwd,
    profileId: record.profileId
  };
}

export function readClaudeProfileMemoryDescriptor(
  value: unknown
): ClaudeProfileMemoryDescriptor | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('claudeMemory must be a Claude profile memory descriptor');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.provider !== 'claude' ||
    typeof record.cwd !== 'string' ||
    !isAbsolute(record.cwd) ||
    typeof record.profileId !== 'string' ||
    !isValidProfileId(record.profileId)
  ) {
    throw new Error('invalid Claude profile memory descriptor');
  }
  return {
    schemaVersion: 1,
    provider: 'claude',
    cwd: record.cwd,
    profileId: record.profileId
  };
}
