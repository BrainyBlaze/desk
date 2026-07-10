import type { DeskAgent } from '../../../core/types.js';

/** Environment contract shared by the host CLI, runner, and driver loader. */
export interface AgentHostEnv {
  DESK_TMUX_SESSION: string;
  DESK_AGENT: DeskAgent;
  DESK_AGENT_RESUME?: string;
  DESK_AGENT_BYPASS: string;
  DESK_AGENT_CWD?: string;
  DESK_AGENT_MODEL?: string;
  DESK_LSP_ENV_FILE?: string;
  DESK_SERVER_URL: string;
  DESK_AGENT_HOST_TOKEN: string;
  DESK_AGENT_HOST_LOG_LEVEL?: 'debug' | 'info' | 'warn' | 'error';
}
