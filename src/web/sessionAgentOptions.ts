import type { DeskSelectOption } from './arwes/primitives.js';
import {
  AGENTS,
  nativeProducerOf,
  profileEnvVarOf,
  providerSupportsBypass
} from '../shared/agentRegistry.js';

export const SESSION_AGENT_OPTIONS: DeskSelectOption[] = AGENTS.map((agent) => ({
  value: agent.id,
  label: agent.label
}));

export function supportsBypassPermissions(agent: string): boolean {
  return providerSupportsBypass(agent);
}

export function supportsNativeUi(agent: string, hasCustomCommand: boolean): boolean {
  return !hasCustomCommand && nativeProducerOf(agent) !== undefined;
}

export function supportsAgentProfiles(
  agent: string,
  hasCustomCommand: boolean
): boolean {
  return !hasCustomCommand && profileEnvVarOf(agent) !== undefined;
}
