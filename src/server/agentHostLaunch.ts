import type { SessionSpec } from '../core/types.js';
import { homedir } from 'node:os';
import { shellQuote } from '../shared/shell.js';
import { isProfileProvider, profileEnvPrefix, profileScrubPrefix } from '../shared/agentProfiles.js';

/**
 * Spawn-time enrichment for native-mode sessions (spec §5): the manifest keeps
 * a static `desk agent-host` command; the server rewrites it at launch with
 * the six locked env keys the host runner reads. Terminal-mode specs pass
 * through untouched. Sessions spawned without a running server (bare-CLI
 * `desk up`) keep the static command — the host's bounded pre-hello retry
 * exits nonzero and the pane shows the failure.
 */

export interface NativeLaunchContext {
  serverUrl: string;
  token: string;
  lspEnvFilePath?: string;
}

export function rewriteNativeLaunchCommand(spec: SessionSpec, context: NativeLaunchContext): SessionSpec {
  if (spec.uiMode !== 'native') {
    return spec;
  }
  // A profiled native launch scrubs inherited provider credentials and points
  // the SDK host at the profile's own directory; ambient stays byte-identical.
  const profileEnv =
    spec.profileId !== undefined && isProfileProvider(spec.agent)
      ? `${profileScrubPrefix()} ${profileEnvPrefix(spec.agent, spec.profileId, homedir())} `
      : '';
  const env = [
    `DESK_SESSION_ID=${shellQuote(spec.sessionId)}`,
    `DESK_AGENT=${shellQuote(spec.agent ?? '')}`,
    ...(spec.resume ? [`DESK_AGENT_RESUME=${shellQuote(spec.resume)}`] : []),
    `DESK_AGENT_BYPASS=${shellQuote(spec.bypassPermissions ? '1' : '0')}`,
    ...(spec.model ? [`DESK_AGENT_MODEL=${shellQuote(spec.model)}`] : []),
    ...(context.lspEnvFilePath ? [`DESK_LSP_ENV_FILE=${shellQuote(context.lspEnvFilePath)}`] : []),
    `DESK_SERVER_URL=${shellQuote(context.serverUrl)}`,
    `DESK_AGENT_HOST_TOKEN=${shellQuote(context.token)}`
  ].join(' ');
  return { ...spec, command: `cd ${shellQuote(spec.cwd)} && ${profileEnv}${env} exec desk agent-host` };
}
