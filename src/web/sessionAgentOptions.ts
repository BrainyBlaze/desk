import type { DeskSelectOption } from './arwes/primitives.js';
import { AGENTS, agentProvider } from '../shared/agentRegistry.js';

export const SESSION_AGENT_OPTIONS: DeskSelectOption[] = AGENTS.map((agent) => ({
  value: agent.id,
  label: agent.label
}));

export function supportsBypassPermissions(agent: string): boolean {
  return agentProvider(agent)?.bypass === true;
}

export function supportsNativeUi(agent: string, hasCustomCommand: boolean): boolean {
  return !hasCustomCommand && agentProvider(agent)?.native === true;
}

export function supportsAgentProfiles(
  agent: string,
  hasCustomCommand: boolean
): boolean {
  return !hasCustomCommand && agentProvider(agent)?.profileEnvVar !== undefined;
}
