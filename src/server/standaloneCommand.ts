export const STANDALONE_USAGE = [
  'Usage: desk-server',
  '',
  'Starts the embedded Desk UI and API server.',
  'Environment: DESK_HOST (default 127.0.0.1), DESK_PORT (default 5173).'
].join('\n');

export interface StandaloneCommandIo {
  stdout(message: string): void;
  stderr(message: string): void;
  start(): Promise<void>;
}

export async function runStandaloneCommand(
  argv: readonly string[],
  io: StandaloneCommandIo
): Promise<number> {
  if (argv.length === 0) {
    await io.start();
    return 0;
  }
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    io.stdout(`${STANDALONE_USAGE}\n`);
    return 0;
  }
  io.stderr(
    `desk-server does not accept commands or options. Run it without arguments.\n${STANDALONE_USAGE}\n` +
      'For desk commands such as channels or serve, use the source-checkout desk CLI.\n'
  );
  return 2;
}
