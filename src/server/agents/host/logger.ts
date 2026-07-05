/**
 * Adapter host structured logger — writes one-line ISO-stamped lines to stdout so the
 * tmux pane shows a running diagnostic trail (spec §5 R5: explanatory banner + adapter
 * log). Levels mirror syslog severity; default is 'info'. DEBUG is verbose (every event
 * emit) and intended for local dev only.
 */
export type AgentHostLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<AgentHostLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class AgentHostLogger {
  constructor(private readonly level: AgentHostLogLevel = 'info') {}

  /** Print the static pane banner so a `tmux attach`er sees what they're looking at. */
  banner(env: { DESK_TMUX_SESSION: string; DESK_AGENT: string; DESK_SERVER_URL?: string }): void {
    process.stdout.write(
      [
        '═══════════════════════════════════════════════════════════════════',
        'desk agent-host — native UI mode adapter',
        `  session : ${env.DESK_TMUX_SESSION}`,
        `  agent   : ${env.DESK_AGENT}`,
        env.DESK_SERVER_URL ? `  server  : ${env.DESK_SERVER_URL}` : '',
        '  view this session in the desk UI; logs follow.',
        '═══════════════════════════════════════════════════════════════════'
      ]
        .filter((line) => line !== '')
        .join('\n')
    );
    process.stdout.write('\n');
  }

  debug(message: string): void {
    this.write('debug', message);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  private write(level: AgentHostLogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }
    const ts = new Date().toISOString();
    process.stdout.write(`${ts} ${level.toUpperCase()} ${message}\n`);
  }
}
