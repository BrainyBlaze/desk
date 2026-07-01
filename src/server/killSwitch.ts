import { spawnSync } from 'node:child_process';

/**
 * Emergency kill switch.
 *
 * Finds and terminates ALL codex / claude CLI processes and every tmux session
 * that hosts one — not just Desk-managed sessions. Deliberately broad: this is
 * the "stop everything now" control behind a confirm dialog.
 */

export interface KillTargets {
  tmuxSessions: string[];
  pids: number[];
}

/** A tmux session is a kill target when it is an agentdesk session or runs an agent CLI. */
export function parseTmuxKillTargets(listOutput: string, paneCommands: string): string[] {
  const sessions = new Set<string>();
  for (const line of listOutput.split('\n')) {
    const name = line.trim();
    if (name.startsWith('agentdesk-')) {
      sessions.add(name);
    }
  }
  // `session\tpane_command` lines: include any session running codex/claude.
  for (const line of paneCommands.split('\n')) {
    const [name, command] = line.split('\t');
    if (name && command && /(?:^|[\s/])(codex|claude)(?:\s|$)/i.test(command)) {
      sessions.add(name.trim());
    }
  }
  return [...sessions];
}

/** Parse `ps` output to agent CLI pids, excluding this server and the parser itself. */
export function parseAgentPids(psOutput: string, selfPid: number): number[] {
  const pids = new Set<number>();
  for (const line of psOutput.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const cmd = match[2]!;
    if (pid === selfPid || pid === process.pid) {
      continue;
    }
    // Match the codex/claude binaries, not arbitrary strings that contain the word.
    if (/(?:^|\/)(codex|claude)(?:-[a-z0-9-]+)?(?:\s|$)/i.test(cmd) || /\bnode\b.*\/(codex|claude)(?:\.js|\b)/i.test(cmd)) {
      pids.add(pid);
    }
  }
  return [...pids];
}

export function collectKillTargets(): KillTargets {
  const sessionsList = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
  const paneList = spawnSync('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_command} #{pane_start_command}'], {
    encoding: 'utf8'
  });
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  const tmuxSessions = parseTmuxKillTargets(sessionsList.stdout ?? '', paneList.stdout ?? '');
  const pids = parseAgentPids(ps.stdout ?? '', process.pid);
  return { tmuxSessions, pids };
}

export interface KillResult {
  killedSessions: string[];
  killedPids: number[];
  errors: string[];
}

export function executeKillSwitch(): KillResult {
  const targets = collectKillTargets();
  const result: KillResult = { killedSessions: [], killedPids: [], errors: [] };

  for (const session of targets.tmuxSessions) {
    const killed = spawnSync('tmux', ['kill-session', '-t', session], { encoding: 'utf8' });
    if (killed.status === 0) {
      result.killedSessions.push(session);
    } else if (killed.stderr && !/can't find session/i.test(killed.stderr)) {
      result.errors.push(killed.stderr.trim());
    }
  }

  // Killing the tmux sessions takes their panes' agent processes with them;
  // sweep any survivors (detached / orphaned) by pid.
  for (const pid of targets.pids) {
    try {
      process.kill(pid, 'SIGTERM');
      result.killedPids.push(pid);
    } catch {
      // already gone with its tmux pane
    }
  }
  return result;
}
