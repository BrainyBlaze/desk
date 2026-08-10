import { homedir } from 'node:os';
import {
  readManifestFile,
  resolveManifestPath,
  updateManifestFile
} from '../core/config.js';
import { buildSessionSpecs } from '../core/manifest.js';
import type { DeskManifest, DeskSession } from '../core/types.js';
import {
  isValidProviderSessionId,
  type ProviderSessionProvider
} from '../shared/providerSessionIdentity.js';

export interface BindProviderSessionIdentityInput {
  deskSessionId: string;
  provider: ProviderSessionProvider;
  providerSessionId: string;
  manifestPath?: string;
  homeDir?: string;
}

export type ProviderSessionBindingFailureCode =
  | 'provider-session-not-found'
  | 'provider-session-agent-mismatch'
  | 'provider-session-id-invalid'
  | 'provider-session-id-conflict'
  | 'provider-session-mismatch';

export type ProviderSessionBindingResult =
  | { ok: true; kind: 'persisted' | 'already-bound' }
  | { ok: false; code: ProviderSessionBindingFailureCode; error: string };

export interface ReadProviderSessionBindingInput {
  deskSessionId: string;
  manifestPath?: string;
  homeDir?: string;
}

export type ProviderSessionBindingReadResult =
  | {
      ok: true;
      provider: ProviderSessionProvider;
      providerSessionId: string | null;
    }
  | { ok: false; code: ProviderSessionBindingFailureCode; error: string };

export interface ClearProviderSessionIdentityInput {
  deskSessionId: string;
  provider: ProviderSessionProvider;
  expectedProviderSessionId: string | null;
  manifestPath?: string;
  homeDir?: string;
}

export type ClearProviderSessionIdentityResult =
  | { ok: true; kind: 'cleared' | 'already-cleared' }
  | { ok: false; code: ProviderSessionBindingFailureCode; error: string };

function failure(
  code: ProviderSessionBindingFailureCode,
  error: string
): ProviderSessionBindingResult {
  return { ok: false, code, error };
}

function manifestSessions(manifest: DeskManifest): DeskSession[] {
  return [
    ...manifest.groups.flatMap((group) => group.sessions),
    ...(manifest.projects ?? []).flatMap((project) =>
      project.groups.flatMap((group) => group.sessions)
    )
  ];
}

export function readProviderSessionBinding(
  input: ReadProviderSessionBindingInput
): ProviderSessionBindingReadResult {
  const manifestPath = input.manifestPath ?? resolveManifestPath();
  const homeDir = input.homeDir ?? homedir();
  const specs = buildSessionSpecs(readManifestFile(manifestPath), {
    homeDir
  });
  const target = specs.find(
    (candidate) => candidate.sessionId === input.deskSessionId
  );
  if (!target) {
    return {
      ok: false,
      code: 'provider-session-not-found',
      error: `Desk session not found: ${input.deskSessionId}`
    };
  }
  if (
    target.agent !== 'claude' &&
    target.agent !== 'codex' &&
    target.agent !== 'opencode'
  ) {
    return {
      ok: false,
      code: 'provider-session-agent-mismatch',
      error: `Desk session ${input.deskSessionId} is not configured for a supported provider`
    };
  }
  if (
    target.resume !== undefined &&
    !isValidProviderSessionId(target.agent, target.resume)
  ) {
    return {
      ok: false,
      code: 'provider-session-id-invalid',
      error: `Desk session ${input.deskSessionId} has an invalid ${target.agent} provider session id`
    };
  }
  const conflictingOwner = specs.find(
    (candidate) =>
      candidate.sessionId !== target.sessionId &&
      target.resume !== undefined &&
      candidate.resume === target.resume
  );
  if (conflictingOwner) {
    return {
      ok: false,
      code: 'provider-session-id-conflict',
      error: `Provider session id is also bound to Desk session ${conflictingOwner.sessionId}`
    };
  }
  return {
    ok: true,
    provider: target.agent,
    providerSessionId: target.resume ?? null
  };
}

export async function clearProviderSessionIdentity(
  input: ClearProviderSessionIdentityInput
): Promise<ClearProviderSessionIdentityResult> {
  const manifestPath = input.manifestPath ?? resolveManifestPath();
  const homeDir = input.homeDir ?? homedir();
  if (
    input.expectedProviderSessionId !== null &&
    !isValidProviderSessionId(
      input.provider,
      input.expectedProviderSessionId
    )
  ) {
    return {
      ok: false,
      code: 'provider-session-id-invalid',
      error: `Invalid ${input.provider} provider session id`
    };
  }
  let result: ClearProviderSessionIdentityResult | undefined;
  await updateManifestFile(manifestPath, (manifest) => {
    const specs = buildSessionSpecs(manifest, { homeDir });
    const target = specs.find(
      (candidate) => candidate.sessionId === input.deskSessionId
    );
    if (!target) {
      result = {
        ok: false,
        code: 'provider-session-not-found',
        error: `Desk session not found: ${input.deskSessionId}`
      };
      return null;
    }
    if (target.agent !== input.provider) {
      result = {
        ok: false,
        code: 'provider-session-agent-mismatch',
        error: `Desk session ${input.deskSessionId} is configured for ${target.agent ?? 'no provider'}, not ${input.provider}`
      };
      return null;
    }
    if (target.resume === undefined) {
      result = { ok: true, kind: 'already-cleared' };
      return null;
    }
    if (target.resume !== input.expectedProviderSessionId) {
      result = {
        ok: false,
        code: 'provider-session-mismatch',
        error: `Desk session ${input.deskSessionId} provider session binding changed during reset`
      };
      return null;
    }
    const next = structuredClone(manifest);
    const mutableTarget = manifestSessions(next).find(
      (session) => session.sessionId === input.deskSessionId
    );
    if (!mutableTarget) {
      throw new Error(
        `manifest session disappeared during provider identity reset: ${input.deskSessionId}`
      );
    }
    delete mutableTarget.resume;
    result = { ok: true, kind: 'cleared' };
    return next;
  });
  if (!result) {
    throw new Error(
      `provider identity reset produced no result for Desk session ${input.deskSessionId}`
    );
  }
  return result;
}

export async function bindProviderSessionIdentity(
  input: BindProviderSessionIdentityInput
): Promise<ProviderSessionBindingResult> {
  const manifestPath = input.manifestPath ?? resolveManifestPath();
  const homeDir = input.homeDir ?? homedir();
  let result: ProviderSessionBindingResult | undefined;

  await updateManifestFile(manifestPath, (manifest) => {
    const specs = buildSessionSpecs(manifest, { homeDir });
    const target = specs.find((candidate) => candidate.sessionId === input.deskSessionId);

    if (!target) {
      result = failure(
        'provider-session-not-found',
        `Desk session not found: ${input.deskSessionId}`
      );
      return null;
    }
    if (target.agent !== input.provider) {
      result = failure(
        'provider-session-agent-mismatch',
        `Desk session ${input.deskSessionId} is configured for ${target.agent ?? 'no provider'}, not ${input.provider}`
      );
      return null;
    }
    if (!isValidProviderSessionId(input.provider, input.providerSessionId)) {
      result = failure(
        'provider-session-id-invalid',
        `Invalid ${input.provider} provider session id`
      );
      return null;
    }

    const conflictingOwner = specs.find(
      (candidate) =>
        candidate.sessionId !== input.deskSessionId &&
        candidate.resume === input.providerSessionId
    );
    if (conflictingOwner) {
      result = failure(
        'provider-session-id-conflict',
        `Provider session id is already bound to Desk session ${conflictingOwner.sessionId}`
      );
      return null;
    }
    if (target.resume === input.providerSessionId) {
      result = { ok: true, kind: 'already-bound' };
      return null;
    }
    if (target.resume) {
      result = failure(
        'provider-session-mismatch',
        `Desk session ${input.deskSessionId} is already bound to a different provider session id`
      );
      return null;
    }

    const next = structuredClone(manifest);
    const mutableTarget = manifestSessions(next).find(
      (session) => session.sessionId === input.deskSessionId
    );
    if (!mutableTarget) {
      throw new Error(
        `manifest session disappeared during provider identity binding: ${input.deskSessionId}`
      );
    }
    mutableTarget.resume = input.providerSessionId;
    result = { ok: true, kind: 'persisted' };
    return next;
  });

  if (!result) {
    throw new Error(
      `provider identity binding produced no result for Desk session ${input.deskSessionId}`
    );
  }
  return result;
}
