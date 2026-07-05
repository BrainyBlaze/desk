import type { DeskSelectOption } from './arwes/primitives.js';

export const SESSION_AGENT_OPTIONS: DeskSelectOption[] = [
  { value: 'codex', label: 'codex' },
  { value: 'claude', label: 'claude' },
  { value: 'opencode', label: 'opencode' },
  { value: 'bash', label: 'bash' }
];

export function supportsBypassPermissions(agent: string): boolean {
  return agent === 'codex' || agent === 'claude' || agent === 'opencode';
}

export function supportsNativeUi(agent: string, hasCustomCommand: boolean): boolean {
  return !hasCustomCommand && (agent === 'codex' || agent === 'claude' || agent === 'opencode');
}
