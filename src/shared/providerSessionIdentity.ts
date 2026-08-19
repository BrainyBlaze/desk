import {
  AGENT_PROVIDER_ENTRIES,
  AGENT_PROVIDER_IDS,
  agentProvider,
  isAgentProviderId,
  terminalProducerOf,
  type AgentHookIdentityEntry,
  type AgentProviderId
} from './agentRegistry.js';

export const PROVIDER_SESSION_PROVIDERS = AGENT_PROVIDER_IDS;

export const DESK_PROVIDER_LAUNCH_PROOF = 'DESK_PROVIDER_LAUNCH_PROOF';

export type ProviderSessionProvider = AgentProviderId;

export type HookIdentityProvider = AgentHookIdentityEntry['id'];

export const HOOK_IDENTITY_PRODUCERS = Object.fromEntries(
  AGENT_PROVIDER_ENTRIES.filter(
    (agent): agent is AgentHookIdentityEntry => agent.identity.kind === 'hooks'
  ).map((agent) => [agent.id, terminalProducerOf(agent.id)])
) as Record<HookIdentityProvider, string>;

export function hookIdentityProvider(
  provider: unknown,
  producer: unknown
): HookIdentityProvider | undefined {
  if (typeof provider !== 'string' || !(provider in HOOK_IDENTITY_PRODUCERS)) {
    return undefined;
  }
  const key = provider as HookIdentityProvider;
  return HOOK_IDENTITY_PRODUCERS[key] === producer ? key : undefined;
}

export const PROVIDER_SESSION_ID_PAYLOAD_FIELD = Object.fromEntries(
  AGENT_PROVIDER_ENTRIES.map((agent) => [agent.id, agent.identity.payloadField])
) as Record<ProviderSessionProvider, string>;

const UUID_PROVIDER_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENCODE_PROVIDER_SESSION_ID = /^ses_[A-Za-z0-9]{20,80}$/;
const OPAQUE_PROVIDER_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function isProviderSessionProvider(
  value: unknown
): value is ProviderSessionProvider {
  return isAgentProviderId(value);
}

/**
 * Providers whose hooks can actually carry a provider session id back to the
 * daemon. The launch-proof flow is only meaningful for these: a provider
 * without a hook identity path (opencode reports through its plugin) can
 * receive a proof but nothing can ever present it, so gating on the broader
 * registry predicate would issue dead-weight proofs and couple that
 * provider's launches to continuity-store health for no benefit.
 */
export function isHookIdentityProvider(
  value: unknown
): value is HookIdentityProvider {
  return typeof value === 'string' && value in HOOK_IDENTITY_PRODUCERS;
}

export function extractProviderSessionId(
  provider: ProviderSessionProvider,
  payload: unknown
): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const field = PROVIDER_SESSION_ID_PAYLOAD_FIELD[provider];
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isValidProviderSessionId(
  provider: ProviderSessionProvider,
  value: string
): boolean {
  switch (agentProvider(provider)?.identity.sessionIdShape) {
    case 'opencode':
      return OPENCODE_PROVIDER_SESSION_ID.test(value);
    case 'opaque':
      return OPAQUE_PROVIDER_SESSION_ID.test(value);
    default:
      return UUID_PROVIDER_SESSION_ID.test(value);
  }
}
