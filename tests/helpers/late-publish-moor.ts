import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, Socket as NetSocket, type Server } from 'node:net';
import { moorLaunchChannelEnvKey } from '../../src/server/runtime/moorLaunchChannel.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const pidfileOf = (sessionPath: string): string => `${sessionPath}.holder-pid`;
const startedPidfileOf = (sessionPath: string): string => `${sessionPath}.started-pid`;

function readChannelToEof(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new NetSocket({ fd, readable: true, writable: false });
    channel.on('data', () => undefined);
    channel.on('end', resolve);
    channel.on('error', reject);
  });
}

async function launcher(sessionPath: string): Promise<void> {
  const selector = Number(process.env[moorLaunchChannelEnvKey(process.execPath)]);
  await readChannelToEof(selector);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', process.argv[1]!, '--holder', sessionPath],
    { detached: true, stdio: 'ignore', env: { ...process.env } }
  );
  child.unref();
  writeFileSync(`${sessionPath}.spawned-proof`, String(child.pid));
  await sleep(60_000);
}

async function holder(sessionPath: string): Promise<void> {
  let server: Server | undefined;
  let shuttingDown = false;
  const finish = (): void => {
    try {
      unlinkSync(sessionPath);
    } catch {
      // The rendezvous may not have been published yet.
    }
    try {
      unlinkSync(pidfileOf(sessionPath));
    } catch {
      // The pidfile may not have been published yet.
    }
    try {
      unlinkSync(startedPidfileOf(sessionPath));
    } catch {
      // The pre-publication pidfile may already be gone.
    }
    process.exit(0);
  };
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (server?.listening) server.close(finish);
    else finish();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  writeFileSync(startedPidfileOf(sessionPath), String(process.pid));

  await sleep(Number(process.env.LATE_MOOR_DELAY_MS ?? 250));
  if (shuttingDown) return;
  server = createServer();
  server.listen(sessionPath, () => {
    writeFileSync(pidfileOf(sessionPath), String(process.pid));
  });
}

async function killHolder(sessionPath: string): Promise<void> {
  try {
    const pidfile = existsSync(pidfileOf(sessionPath))
      ? pidfileOf(sessionPath)
      : startedPidfileOf(sessionPath);
    process.kill(Number(readFileSync(pidfile, 'utf8')), 'SIGTERM');
  } catch {
    process.exit(1);
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!existsSync(sessionPath)) process.exit(0);
    await sleep(10);
  }
  process.exit(1);
}

function parseStartSessionPath(argv: string[]): string | undefined {
  let index = 0;
  let cacheBytes: number | undefined;
  while (argv[index] === '-C' || argv[index] === '-T') {
    const option = argv[index];
    const value = argv[index + 1];
    if (value === undefined) return undefined;
    if (option === '-C') cacheBytes = Number(value);
    index += 2;
  }
  if (cacheBytes !== 0) return undefined;
  return argv[index];
}

const [mode, ...args] = process.argv.slice(2);
const sessionPath = mode === 'start' ? parseStartSessionPath(args) : args[0];
if (sessionPath === undefined) process.exit(1);
if (mode === 'start') void launcher(sessionPath);
else if (mode === '--holder') void holder(sessionPath);
else if (mode === 'kill') void killHolder(sessionPath);
else process.exit(1);
