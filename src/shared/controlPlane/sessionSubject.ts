import type { AgentMode, AgentProducer, AgentProvider } from './contract.js';
import type { SessionRegistration } from './authority.js';

export interface SessionSubjectSource {
  agent?: string;
  uiMode?: AgentMode;
  customCommand?: boolean;
}

const PRODUCER_BY_PROVIDER_AND_MODE = {
  codex: {
    terminal: 'codex-hooks',
    native: 'codex-native'
  },
  claude: {
    terminal: 'claude-hooks',
    native: 'claude-native'
  },
  opencode: {
    terminal: 'opencode-terminal',
    native: 'opencode-native'
  }
} as const satisfies Record<AgentProvider, Record<AgentMode, AgentProducer>>;

export function sessionStateSubjectFor(
  source: SessionSubjectSource
): SessionRegistration['subject'] {
  if (
    source.customCommand === true ||
    (source.agent !== 'codex' && source.agent !== 'claude' && source.agent !== 'opencode')
  ) {
    return { kind: 'terminal' };
  }
  const provider = source.agent;
  const mode = source.uiMode === 'native' ? 'native' : 'terminal';
  return {
    kind: 'agent',
    provider,
    mode,
    producer: PRODUCER_BY_PROVIDER_AND_MODE[provider][mode]
  };
}
