import type { AgentMode, AgentProducer, AgentProvider } from './contract.js';
import type { SessionRegistration } from './authority.js';
import { AGENT_PROVIDER_ENTRIES, isAgentProviderId } from '../agentRegistry.js';

export interface SessionSubjectSource {
  agent?: string;
  uiMode?: AgentMode;
  customCommand?: boolean;
}

const PRODUCER_BY_PROVIDER_AND_MODE = Object.fromEntries(
  AGENT_PROVIDER_ENTRIES.map((agent) => [
    agent.id,
    { terminal: agent.terminalProducer, native: agent.nativeProducer }
  ])
) as Record<AgentProvider, Record<AgentMode, AgentProducer>>;

export function sessionStateSubjectFor(
  source: SessionSubjectSource
): SessionRegistration['subject'] {
  if (source.customCommand === true || !isAgentProviderId(source.agent)) {
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
