import type { AgentMode, AgentProducer } from './contract.js';
import type { SessionRegistration } from './authority.js';
import {
  isAgentProviderId,
  nativeProducerOf,
  terminalProducerOf
} from '../agentRegistry.js';

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
  const nativeProducer = nativeProducerOf(provider);
  const mode = source.uiMode === 'native' && nativeProducer !== undefined ? 'native' : 'terminal';
  const producer = mode === 'native' ? nativeProducer : terminalProducerOf(provider);
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
