import { spawnSync } from 'node:child_process';

type TmuxOptionExecutor = (
  file: string,
  args: string[],
  options: { encoding: 'utf8' }
) => { status: number | null };

let applied = false;

/** Apply Desk's process-wide tmux policy once for the current tmux server. */
export function ensureTmuxGlobalOptions(exec: TmuxOptionExecutor = spawnSync): boolean {
  if (applied) {
    return true;
  }

  const results = [
    exec('tmux', ['set-option', '-g', 'mouse', 'off'], { encoding: 'utf8' }),
    exec('tmux', ['set-option', '-g', 'allow-passthrough', 'on'], { encoding: 'utf8' })
  ];
  applied = results.every((result) => result.status === 0);
  return applied;
}

/** A drained broker may indicate that the tmux server restarted; reapply on next attach. */
export function markTmuxGlobalOptionsStale(): void {
  applied = false;
}

export function resetTmuxGlobalOptionsForTests(): void {
  applied = false;
}
