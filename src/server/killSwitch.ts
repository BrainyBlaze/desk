import { spawnSync } from 'node:child_process';
import { loadDesk } from '../core/runner.js';
import { retireNativeSession } from './runtime/nativeSessionControl.js';

/**
 * Emergency kill switch.
 *
 * Retires EVERY manifest session's atch master via the daemon control plane
 * (bounded kill + socket-gone before each 200), then sweeps surviving agent
 * CLI processes by pid — detached hosts, orphans, or agents started outside
 * desk entirely. Deliberately broad: this is the "stop everything now"
 * control behind a confirm dialog.
 */

export interface KillResult {
  killedSessions: string[];
  killedPids: number[];
  errors: string[];
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

export async function executeKillSwitch(): Promise<KillResult> {
  const result: KillResult = { killedSessions: [], killedPids: [], errors: [] };

  // Retire every manifest session. Retire is idempotent and awaited — a
  // session with no live master is a harmless no-op, a refusing daemon is a
  // reported error, never a silent skip.
  let sessionIds: string[] = [];
  try {
    sessionIds = loadDesk({}).sessions.map((session) => session.sessionId);
  } catch (error) {
    result.errors.push(`manifest unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const sessionId of sessionIds) {
    const retired = await retireNativeSession(sessionId);
    if (retired.ok) {
      result.killedSessions.push(sessionId);
    } else if (retired.error) {
      result.errors.push(`retire ${sessionId}: ${retired.error}`);
    }
  }

  // Retiring the masters takes their agent processes with them; sweep any
  // survivors (detached hosts, orphans, agents started outside desk) by pid.
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  for (const pid of parseAgentPids(ps.stdout ?? '', process.pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      result.killedPids.push(pid);
    } catch {
      // already gone with its master
    }
  }
  return result;
}
