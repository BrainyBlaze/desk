import {
  clearProviderSessionIdentity,
  readProviderSessionBinding,
  type ClearProviderSessionIdentityInput,
  type ClearProviderSessionIdentityResult,
  type ProviderSessionBindingReadResult,
  type ReadProviderSessionBindingInput
} from './providerSessionBinding.js';
import {
  FileProviderSessionLaunchLedger,
  type ProviderSessionLaunchAuthorization
} from './runtime/providerSessionLaunchLedger.js';

export type ProviderSessionResetResult =
  | {
      ok: true;
      authorizationId: string;
      generation: number;
      state: 'authorized';
    }
  | {
      ok: false;
      reason:
        | 'provider-session-not-found'
        | 'provider-session-agent-mismatch'
        | 'provider-session-id-invalid'
        | 'provider-session-id-conflict'
        | 'provider-session-mismatch'
        | 'provider-session-store-failed';
      error: string;
    };

export interface ProviderSessionResetInput {
  deskSessionId: string;
  generation: number;
  manifestPath?: string;
  homeDir?: string;
}

interface ProviderSessionResetDependencies {
  ledger: FileProviderSessionLaunchLedger;
  readBinding?: (
    input: ReadProviderSessionBindingInput
  ) => ProviderSessionBindingReadResult;
  clearBinding?: (
    input: ClearProviderSessionIdentityInput
  ) => Promise<ClearProviderSessionIdentityResult>;
  afterBindingCleared?: (
    authorization: ProviderSessionLaunchAuthorization
  ) => void | Promise<void>;
}

export async function authorizeProviderSessionReset(
  input: ProviderSessionResetInput,
  dependencies: ProviderSessionResetDependencies
): Promise<ProviderSessionResetResult> {
  const readBinding =
    dependencies.readBinding ?? readProviderSessionBinding;
  const clearBinding =
    dependencies.clearBinding ?? clearProviderSessionIdentity;
  try {
    const binding = readBinding({
      deskSessionId: input.deskSessionId,
      ...(input.manifestPath === undefined
        ? {}
        : { manifestPath: input.manifestPath }),
      ...(input.homeDir === undefined ? {} : { homeDir: input.homeDir })
    });
    if (!binding.ok) {
      return { ok: false, reason: binding.code, error: binding.error };
    }

    let current = dependencies.ledger.current(input.deskSessionId);
    if (
      current?.state === 'claimed' &&
      current.provider === binding.provider &&
      current.generation === input.generation &&
      binding.providerSessionId !== null
    ) {
      const completed = dependencies.ledger.complete({
        deskSessionId: input.deskSessionId,
        provider: binding.provider,
        providerSessionId: binding.providerSessionId,
        generation: input.generation
      });
      if (!completed.ok) {
        return {
          ok: false,
          reason: 'provider-session-store-failed',
          error: `could not complete prior provider launch: ${completed.reason}`
        };
      }
      current = dependencies.ledger.current(input.deskSessionId);
    }

    const clearedPrepared =
      binding.providerSessionId === null &&
      current?.state === 'prepared' &&
      current.provider === binding.provider &&
      current.generation === input.generation
        ? current
        : undefined;
    const prepared =
      clearedPrepared ??
      dependencies.ledger.resumeRecoveredPrepared({
        deskSessionId: input.deskSessionId,
        provider: binding.provider,
        generation: input.generation
      }) ??
      dependencies.ledger.prepare({
          deskSessionId: input.deskSessionId,
          provider: binding.provider,
          expectedPriorBinding: binding.providerSessionId,
          generation: input.generation
        });
    const cleared = await clearBinding({
      deskSessionId: input.deskSessionId,
      provider: prepared.provider,
      expectedProviderSessionId: prepared.expectedPriorBinding,
      ...(input.manifestPath === undefined
        ? {}
        : { manifestPath: input.manifestPath }),
      ...(input.homeDir === undefined ? {} : { homeDir: input.homeDir })
    });
    if (!cleared.ok) {
      return { ok: false, reason: cleared.code, error: cleared.error };
    }
    await dependencies.afterBindingCleared?.(prepared);
    const authorized = dependencies.ledger.authorize(
      prepared.authorizationId
    );
    return {
      ok: true,
      authorizationId: authorized.authorizationId,
      generation: authorized.generation,
      state: 'authorized'
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'provider-session-store-failed',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
