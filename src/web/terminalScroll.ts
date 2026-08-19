export type TerminalBufferType = 'normal' | 'alternate';
export type TerminalScrollStrategy = 'local' | 'history' | 'application';
export type ApplicationScrollProfile = 'opencode' | 'page-keys';

export interface TerminalScrollStrategyInput {
  activeBufferType?: TerminalBufferType;
  running: boolean;
  localScrollbackRows: number;
  localViewportY?: number;
  requestedLines: number;
}

export function chooseScrollStrategy(input: TerminalScrollStrategyInput): TerminalScrollStrategy {
  if (!input.requestedLines) {
    return 'local';
  }
  if (input.running && input.activeBufferType === 'alternate') {
    return 'application';
  }
  if (
    input.running &&
    input.requestedLines < 0 &&
    (input.localScrollbackRows <= 0 || (input.localViewportY ?? input.localScrollbackRows) <= 0)
  ) {
    return 'history';
  }
  return 'local';
}

export function applicationScrollProfileForAgent(agent?: string): ApplicationScrollProfile {
  return agent === 'opencode' ? 'opencode' : 'page-keys';
}

/**
 * Who renders the scroll position indicator for this agent's pane. Grok's
 * OpenTUI draws its own scrollbar and owns wheel/click scrolling entirely, so
 * showing Desk's rail beside it produces two competing bars; every other CLI
 * leaves position indication to the host.
 */
export function terminalScrollOwnerForAgent(agent?: string): 'host' | 'agent' {
  return agent === 'grok' ? 'agent' : 'host';
}

export function encodeApplicationScrollInput(
  requestedLines: number,
  profile: ApplicationScrollProfile
): string | undefined {
  if (!requestedLines) {
    return undefined;
  }
  const amount = Math.max(1, Math.min(12, Math.abs(Math.trunc(requestedLines))));
  if (profile === 'opencode') {
    // OpenCode defaults: ctrl+alt+y/e are message line up/down. Alt is ESC-prefixed.
    return (requestedLines < 0 ? '\x1b\x19' : '\x1b\x05').repeat(amount);
  }
  return requestedLines < 0 ? '\x1b[5~' : '\x1b[6~';
}
