import { AgentHost, type AgentHostEnv } from './runner.js';
import { AgentHostLogger, type AgentHostLogLevel } from './logger.js';
import type { DeskAgent } from '../../../core/types.js';

/**
 * `desk agent-host` CLI entry — read the locked env contract (msg-20260705-154138) and
 * run the AgentHost until shutdown / fatal error / signal.
 *
 * The native launch path (buildAgentCommand + agentHostLaunch.rewriteNativeLaunchCommand)
 * injects the env keys into the tmux session's spawn env. This entry reads them and
 * constructs the AgentHost. Production exits when AgentHost.run() returns (the runner
 * wires its exit callback to process.exit).
 *
 * Required env:
 *   DESK_TMUX_SESSION     — tmux session name (broker hello field, ring key)
 *   DESK_AGENT            — claude | codex | opencode
 *   DESK_AGENT_BYPASS     — '1' or '0'
 *   DESK_SERVER_URL       — desk server URL (e.g. http://127.0.0.1:5173)
 *   DESK_AGENT_HOST_TOKEN — HMAC derived from persistent desk host secret
 *
 * Optional env:
 *   DESK_AGENT_RESUME     — existing agent-native session id to resume
 *   DESK_AGENT_CWD        — cwd for the driver (defaults to process.cwd())
 *   DESK_LSP_ENV_FILE     — managed agent LSP MCP env file
 *   DESK_AGENT_HOST_LOG_LEVEL — debug | info | warn | error (default: info)
 */
export function runAgentHostFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const parsed = parseAgentHostEnv(env);
  const logger = new AgentHostLogger(parsed.DESK_AGENT_HOST_LOG_LEVEL ?? 'info');
  logger.banner(parsed);
  const host = new AgentHost({ env: parsed });
  return host.run();
}

/** Parse + validate the env contract. Throws on missing/invalid required keys. */
export function parseAgentHostEnv(env: NodeJS.ProcessEnv): AgentHostEnv {
  const DESK_TMUX_SESSION = requireEnv(env, 'DESK_TMUX_SESSION');
  const DESK_AGENT = requireEnv(env, 'DESK_AGENT') as DeskAgent;
  if (!isDeskAgent(DESK_AGENT)) {
    throw new Error(`DESK_AGENT must be one of claude | codex | opencode | bash; got ${String(DESK_AGENT)}`);
  }
  const DESK_AGENT_BYPASS = requireEnv(env, 'DESK_AGENT_BYPASS');
  if (DESK_AGENT_BYPASS !== '0' && DESK_AGENT_BYPASS !== '1') {
    throw new Error(`DESK_AGENT_BYPASS must be '0' or '1'; got ${JSON.stringify(DESK_AGENT_BYPASS)}`);
  }
  const DESK_SERVER_URL = requireEnv(env, 'DESK_SERVER_URL');
  const DESK_AGENT_HOST_TOKEN = requireEnv(env, 'DESK_AGENT_HOST_TOKEN');

  const result: AgentHostEnv = {
    DESK_TMUX_SESSION,
    DESK_AGENT,
    DESK_AGENT_BYPASS,
    DESK_SERVER_URL,
    DESK_AGENT_HOST_TOKEN
  };

  if (env.DESK_AGENT_RESUME) {
    result.DESK_AGENT_RESUME = env.DESK_AGENT_RESUME;
  }
  if (env.DESK_AGENT_CWD) {
    result.DESK_AGENT_CWD = env.DESK_AGENT_CWD;
  }
  if (env.DESK_AGENT_MODEL) {
    result.DESK_AGENT_MODEL = env.DESK_AGENT_MODEL;
  }
  if (env.DESK_LSP_ENV_FILE) {
    result.DESK_LSP_ENV_FILE = env.DESK_LSP_ENV_FILE;
  }
  const level = env.DESK_AGENT_HOST_LOG_LEVEL;
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
    result.DESK_AGENT_HOST_LOG_LEVEL = level;
  } else if (level !== undefined) {
    throw new Error(`DESK_AGENT_HOST_LOG_LEVEL must be debug | info | warn | error; got ${JSON.stringify(level)}`);
  }

  return result;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`agent-host requires ${key} env var`);
  }
  return value;
}

function isDeskAgent(value: string): value is DeskAgent {
  return value === 'claude' || value === 'codex' || value === 'opencode' || value === 'bash';
}
