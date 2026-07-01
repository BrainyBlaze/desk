import type { SessionSpec, TmuxPlanAction } from './types.js';

export function createTmuxPlan(
  desiredSessions: SessionSpec[],
  existingSessions: Set<string>
): TmuxPlanAction[] {
  return desiredSessions.map((session) => {
    if (existingSessions.has(session.tmuxSession)) {
      return {
        type: 'preserve',
        session,
        argv: []
      };
    }

    return {
      type: 'start',
      session,
      argv: createStartSessionArgv(session)
    };
  });
}

export function createAttachArgv(tmuxSession: string): string[] {
  return ['attach-session', '-t', tmuxSession];
}

export function createCaptureArgv(tmuxSession: string, lines = 200): string[] {
  return ['capture-pane', '-p', '-t', tmuxSession, '-S', `-${lines}`];
}

export function createKillSessionArgv(tmuxSession: string): string[] {
  return ['kill-session', '-t', tmuxSession];
}

export function createStartSessionArgv(session: SessionSpec): string[] {
  return ['new-session', '-d', '-s', session.tmuxSession, '-c', session.cwd, session.command];
}
