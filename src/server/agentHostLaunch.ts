import type { SessionSpec } from '../core/types.js';

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
}

export function rewriteNativeLaunchCommand(spec: SessionSpec, context: NativeLaunchContext): SessionSpec {
  if (spec.uiMode !== 'native') {
    return spec;
  }
  const env = [
    `DESK_TMUX_SESSION=${shellQuote(spec.tmuxSession)}`,
    `DESK_AGENT=${shellQuote(spec.agent ?? '')}`,
    ...(spec.resume ? [`DESK_AGENT_RESUME=${shellQuote(spec.resume)}`] : []),
    `DESK_AGENT_BYPASS=${shellQuote(spec.bypassPermissions ? '1' : '0')}`,
    ...(spec.model ? [`DESK_AGENT_MODEL=${shellQuote(spec.model)}`] : []),
    `DESK_SERVER_URL=${shellQuote(context.serverUrl)}`,
    `DESK_AGENT_HOST_TOKEN=${shellQuote(context.token)}`
  ].join(' ');
  return { ...spec, command: `cd ${shellQuote(spec.cwd)} && ${env} exec desk agent-host` };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
