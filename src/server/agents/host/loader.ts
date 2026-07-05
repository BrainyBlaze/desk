import { createClaudeDriver } from '../drivers/claudeDriver.js';
import { createCodexDriver } from '../drivers/codexDriver.js';
import { OpencodeDriver } from '../drivers/opencodeDriver.js';
import type { DeskAgent } from '../../../core/types.js';
import { driverCommandError, type AgentDriver } from './driver.js';
import type { AgentHostEnv } from './runner.js';
import type { AgentHostLogger } from './logger.js';

/**
 * Driver loader — maps DESK_AGENT to the matching AgentDriver implementation.
 *
 * Failures (unsupported agent kind) surface as DriverCommandError 'driver-start-failed'
 * so the host runner can emit agent-error fatal:true and exit nonzero. Constructor-time
 * failures from individual drivers (e.g., opencode with no resumeId + no creds) propagate
 * the same way via start() rather than here.
 *
 * claude and codex drivers are imported eagerly because their npm deps are pinned in
 * package.json (per spec §10 dependency manifest). If we later support host bundles that
 * omit one of the deps, switch to dynamic import per agent kind — but the static graph
 * stays simpler for now.
 */
export function loadDriver(env: AgentHostEnv, _logger: AgentHostLogger): AgentDriver {
  const agent = env.DESK_AGENT as DeskAgent;
  const bypass = env.DESK_AGENT_BYPASS === '1';
  const cwd = env.DESK_AGENT_CWD ?? process.cwd();

  switch (agent) {
    case 'opencode':
      return new OpencodeDriver({
        cwd,
        bypass,
        resumeId: env.DESK_AGENT_RESUME
      });
    case 'claude':
      return createClaudeDriver({
        cwd,
        resume: env.DESK_AGENT_RESUME,
        bypassPermissions: bypass
      });
    case 'codex':
      return createCodexDriver({
        cwd,
        resumeId: env.DESK_AGENT_RESUME
      });
    default:
      throw driverCommandError(
        `unsupported DESK_AGENT value: ${String(agent)}`,
        'driver-start-failed',
        false
      );
  }
}
