import {
  AGENT_PROVIDER_ENTRIES,
  AGENT_PROVIDER_IDS,
  agentProvider,
  isAgentProviderId,
  type AgentProviderId
} from './agentRegistry.js';

export const PROVIDER_SESSION_PROVIDERS = AGENT_PROVIDER_IDS;

export type ProviderSessionProvider = AgentProviderId;

export const PROVIDER_SESSION_ID_PAYLOAD_FIELD = Object.fromEntries(
  AGENT_PROVIDER_ENTRIES.map((agent) => [agent.id, agent.sessionIdField])
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
  switch (agentProvider(provider)?.sessionIdShape) {
    case 'opencode':
      return OPENCODE_PROVIDER_SESSION_ID.test(value);
    case 'opaque':
      return OPAQUE_PROVIDER_SESSION_ID.test(value);
    default:
      return UUID_PROVIDER_SESSION_ID.test(value);
  }
}
