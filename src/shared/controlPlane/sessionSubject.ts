import type { AgentMode, AgentProducer } from './contract.js';
import type { SessionRegistration } from './authority.js';
import { agentProvider, isAgentProviderId } from '../agentRegistry.js';

export interface SessionSubjectSource {
  agent?: string;
  uiMode?: AgentMode;
  customCommand?: boolean;
}

export function sessionStateSubjectFor(
  source: SessionSubjectSource
): SessionRegistration['subject'] {
  if (source.customCommand === true || !isAgentProviderId(source.agent)) {
    return { kind: 'terminal' };
  }
  const provider = source.agent;
  const entry = agentProvider(provider);
  const mode = source.uiMode === 'native' && entry?.nativeProducer !== undefined ? 'native' : 'terminal';
  const producer = mode === 'native' ? entry?.nativeProducer : entry?.terminalProducer;
  if (producer === undefined) {
    return { kind: 'terminal' };
  }
  return {
    kind: 'agent',
    provider,
    mode,
    producer: producer as AgentProducer
  };
}
