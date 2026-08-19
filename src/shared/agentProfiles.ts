// Agent profiles: one isolated provider credential directory per account.
//
// A profile is a POINTER, never a secret store — Desk creates the directory
// and points the provider CLI at it through that CLI's own credential-dir
// variable; the CLI writes (and owns) everything inside. Absent selection is
// the ambient account, byte-identical to pre-profile behavior.
//
// Both launch seams consume THIS module (R8.4: one shared capability, not two
// copies) — the terminal command prefix in core/manifest.ts and the native
// spawn rewrite in server/agentHostLaunch.ts. Shared stays a leaf: structural
// params only, no core type imports.

import { shellQuote } from './shell.js';
import {
  AGENT_PROFILE_PROVIDER_IDS,
  profileEnvVarOf,
  type AgentProfileProviderId
} from './agentRegistry.js';

/** Providers with a documented credential-directory override. */
export type ProfileProviderId = AgentProfileProviderId;

/** The credential-directory variable each provider CLI reads. */
export const PROFILE_ENV_VAR: Record<ProfileProviderId, string> = Object.fromEntries(
  AGENT_PROFILE_PROVIDER_IDS.map((provider) => [provider, profileEnvVarOf(provider)])
) as Record<ProfileProviderId, string>;

/**
 * Inherited provider credential variables removed from a PROFILED child.
 * An ambient key in the environment would otherwise silently outrank the
 * selected account's OAuth credentials — the profile must be the only
 * credential the child can see (R2: fail closed on identity).
 * Ambient launches keep their environment untouched.
 */
export const SCRUBBED_PROVIDER_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN'
];

/** Profile id grammar — same class as sessionId, safe as a path segment. */
const PROFILE_ID_RE = /^[a-z][a-z0-9-]{2,63}$/;

export function isValidProfileId(id: unknown): id is string {
  return typeof id === 'string' && PROFILE_ID_RE.test(id);
}

export function isProfileProvider(value: unknown): value is ProfileProviderId {
  return typeof value === 'string' && profileEnvVarOf(value) !== undefined;
}

/** The Desk-owned credential directory for a profile. */
export function profileRoot(profileId: string, homeDir: string): string {
  const root = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
  return `${root}/.config/desk/profiles/${profileId}`;
}

/**
 * The launch environment a profile contributes: the provider's credential-dir
 * variable pointed at the profile root. Returns an empty record for an
 * unknown provider so callers fail closed at their own validation rather than
 * silently launching ambient.
 */
export function profileLaunchEnv(
  provider: ProfileProviderId,
  profileId: string,
  homeDir: string
): Record<string, string> {
  return { [PROFILE_ENV_VAR[provider]]: profileRoot(profileId, homeDir) };
}

/**
 * The same environment as a shell assignment prefix, quoted through the one
 * audited quoter (R6.1). Empty string when there is nothing to add, so
 * callers can interpolate unconditionally.
 */
export function profileEnvPrefix(
  provider: ProfileProviderId,
  profileId: string,
  homeDir: string
): string {
  return Object.entries(profileLaunchEnv(provider, profileId, homeDir))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
}

/**
 * A `sh` prologue that UNSETS inherited provider credentials for a profiled
 * launch. Emitted before the profile's own assignments so the child sees the
 * profile and nothing else.
 */
export function profileScrubPrefix(): string {
  return `unset ${SCRUBBED_PROVIDER_ENV.join(' ')};`;
}

/** Remove inherited provider credentials from a spawn environment (native seam). */
export function scrubProviderEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of SCRUBBED_PROVIDER_ENV) {
    delete next[key];
  }
  return next;
}
