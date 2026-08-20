import type { ITheme } from '@xterm/xterm';

export interface TerminalSnapshotTarget {
  options: { theme?: ITheme };
  reset(): void;
  write(data: string, callback?: () => void): void;
}

/** Reset and restore one baseline, notifying callers only after xterm parses it. */
export function applyTerminalSnapshot(
  terminal: TerminalSnapshotTarget,
  data: string,
  theme: ITheme,
  onApplied: () => void
): void {
  terminal.reset();
  terminal.options.theme = { ...theme };
  terminal.write(data, onApplied);
}
