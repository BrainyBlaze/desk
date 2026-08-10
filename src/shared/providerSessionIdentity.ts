export const PROVIDER_SESSION_PROVIDERS = ['claude', 'codex', 'opencode'] as const;

export type ProviderSessionProvider = (typeof PROVIDER_SESSION_PROVIDERS)[number];

export const PROVIDER_SESSION_ID_PAYLOAD_FIELD = {
  claude: 'session_id',
  codex: 'session_id',
  opencode: 'sessionID'
} as const satisfies Record<ProviderSessionProvider, string>;

const UUID_PROVIDER_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENCODE_PROVIDER_SESSION_ID = /^ses_[A-Za-z0-9]{20,80}$/;

export function isProviderSessionProvider(
  value: unknown
): value is ProviderSessionProvider {
  return (
    typeof value === 'string' &&
    PROVIDER_SESSION_PROVIDERS.some((provider) => provider === value)
  );
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
  return provider === 'opencode'
    ? OPENCODE_PROVIDER_SESSION_ID.test(value)
    : UUID_PROVIDER_SESSION_ID.test(value);
}
