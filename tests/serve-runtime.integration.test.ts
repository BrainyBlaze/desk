import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, createConnection, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runServeLaunch } from '../src/cli/serveCommand.js';

interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface TrackedCli {
  child: ChildProcess;
  closed: Promise<ProcessOutcome>;
  stdout: string;
  stderr: string;
}

const activeCliProcesses = new Set<TrackedCli>();
const cliEntry = join(process.cwd(), 'src', 'cli', 'main.ts');
const cliExitTimeoutMs = 10_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T | null> {
  return await new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), milliseconds);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function trackCli(child: ChildProcess): TrackedCli {
  const tracked: TrackedCli = {
    child,
    stdout: '',
    stderr: '',
    closed: Promise.resolve({ code: null, signal: null })
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    tracked.stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    tracked.stderr += chunk;
  });
  tracked.closed = new Promise<ProcessOutcome>((resolve, reject) => {
    let settled = false;
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('close', (code, signal) => {
      if (!settled) {
        settled = true;
        resolve({ code, signal });
      }
    });
  });
  activeCliProcesses.add(tracked);
  return tracked;
}

function startNpxCli(argv: string[], port: number): TrackedCli {
  return trackCli(
    spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'src/cli/main.ts', ...argv], {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        DESK_HOST: '127.0.0.1',
        DESK_PORT: String(port),
        FORCE_COLOR: '0',
        NO_COLOR: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  );
}

function startDirectCli(argv: string[]): TrackedCli {
  return trackCli(
    spawn(process.execPath, ['--import', 'tsx', cliEntry, ...argv], {
      cwd: process.cwd(),
      detached: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  );
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

async function stopProcessGroup(tracked: TrackedCli): Promise<void> {
  const pid = tracked.child.pid;
  if (pid === undefined || !processGroupIsAlive(pid)) {
    return;
  }

  signalProcessGroup(pid, 'SIGTERM');
  const terminated = await waitForProcessGroupExit(pid, 1_000);
  if (!terminated) {
    signalProcessGroup(pid, 'SIGKILL');
  }
  expect(await waitForProcessGroupExit(pid, 5_000)).toBe(true);
  await within(tracked.closed.catch(() => ({ code: null, signal: null })), 1_000);
}

async function waitForProcessGroupExit(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (processGroupIsAlive(pid) && Date.now() < deadline) {
    await delay(25);
  }
  return !processGroupIsAlive(pid);
}

afterEach(async () => {
  const processes = [...activeCliProcesses];
  activeCliProcesses.clear();
  for (const tracked of processes) {
    await stopProcessGroup(tracked);
  }
});

async function bindRandomPort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('expected a TCP port');
  }
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function randomUnusedPort(): Promise<number> {
  const bound = await bindRandomPort();
  await closeServer(bound.server);
  return bound.port;
}

async function portIsOpen(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function directChildPids(parentPid: number): number[] {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`cannot inspect process tree: ${result.stderr}`);
  }
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, ppid]) => ppid === parentPid)
    .map(([pid]) => pid);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function waitForRuntimeChild(parentPid: number): Promise<number> {
  let runtimePid: number | undefined;
  await waitUntil(() => {
    runtimePid = directChildPids(parentPid)[0];
    return runtimePid !== undefined;
  }, 'the CLI runtime child');
  return runtimePid as number;
}

describe('public CLI serve dispatch', () => {
  it.each([
    {
      argv: ['serve', '--dev', 'true'],
      expectedError: 'unexpected argument true'
    },
    {
      argv: ['serve', '--port'],
      expectedError: '--port requires a value'
    },
    {
      argv: ['serve', '--standalone'],
      expectedError: 'unknown option --standalone'
    },
    {
      argv: ['status', '--dev'],
      expectedError: 'unknown option --dev'
    },
    {
      argv: ['channels', 'list', '--dev'],
      expectedError: 'unknown option --dev'
    },
    {
      argv: ['agent-host', '--dev'],
      expectedError: 'unknown option --dev'
    },
    {
      argv: ['status', '--standalone'],
      expectedError: 'unknown option --standalone'
    },
    {
      argv: ['channels', 'list', '--standalone'],
      expectedError: 'unknown option --standalone'
    },
    {
      argv: ['agent-host', '--standalone'],
      expectedError: 'unknown option --standalone'
    }
  ])('rejects $argv before opening a port', { timeout: 30_000 }, async ({ argv, expectedError }) => {
    const port = await randomUnusedPort();
    const cli = startNpxCli(argv, port);
    const outcome = await within(cli.closed, cliExitTimeoutMs);

    expect(outcome).not.toBeNull();
    expect(outcome?.code).not.toBe(0);
    expect(cli.stderr).toContain(expectedError);
    expect(cli.stdout).not.toContain('Local:');
    expect(await portIsOpen(port)).toBe(false);
  });

  it('documents both serve forms, precedence, and no second public server command', { timeout: 30_000 }, async () => {
    const cli = startNpxCli(['help'], await randomUnusedPort());
    const outcome = await within(cli.closed, cliExitTimeoutMs);
    const helpLines = cli.stdout.split('\n').map((line) => line.trim());

    expect(outcome).toEqual({ code: 0, signal: null });
    expect(cli.stdout).toContain(
      'desk serve [--host HOST] [--port PORT]\n      Start the private standalone runtime.'
    );
    expect(cli.stdout).toContain(
      'desk serve --dev [--host HOST] [--port PORT]\n      Start the Vite dev server + UI.'
    );
    expect(helpLines).toContain('desk serve [--host HOST] [--port PORT]');
    expect(helpLines).toContain('Start the private standalone runtime.');
    expect(helpLines).toContain('desk serve --dev [--host HOST] [--port PORT]');
    expect(helpLines).toContain('Start the Vite dev server + UI.');
    expect(helpLines.filter((line) => /^desk (?:serve|server|standalone)\b/.test(line))).toEqual([
      'desk serve [--host HOST] [--port PORT]',
      'desk serve --dev [--host HOST] [--port PORT]'
    ]);
    expect(cli.stdout).not.toContain('--standalone');
    expect(cli.stdout).toContain('flags > DESK_HOST/DESK_PORT > 127.0.0.1/5173');
  });
});

describe('serve runtime supervision', () => {
  it('propagates a controlled child\'s exact nonzero status without leaking signal listeners', async () => {
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');

    const status = await runServeLaunch({
      command: process.execPath,
      args: ['--input-type=module', '--eval', 'process.exit(37)'],
      cwd: tmpdir(),
      env: process.env,
      label: 'controlled runtime'
    });

    expect(status).toBe(37);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ] as const)(
    'forwards %s from only the CLI PID and closes the Vite runtime',
    { timeout: 20_000 },
    async (signal, expectedCode) => {
      const port = await randomUnusedPort();
      const cli = startDirectCli(['serve', '--dev', '--host', '127.0.0.1', '--port', String(port)]);
      const cliPid = cli.child.pid;
      if (cliPid === undefined) {
        throw new Error('CLI did not receive a pid');
      }

      await waitUntil(() => portIsOpen(port), `Vite to listen on ${port}`);
      const runtimePid = await waitForRuntimeChild(cliPid);

      expect(cli.child.kill(signal)).toBe(true);
      const outcome = await within(cli.closed, 10_000);

      expect(outcome).toEqual({ code: expectedCode, signal: null });
      await waitUntil(() => !processIsAlive(runtimePid), `runtime child ${runtimePid} to exit`);
      await waitUntil(async () => !(await portIsOpen(port)), `port ${port} to close`);
      expect(processIsAlive(runtimePid)).toBe(false);
      expect(await portIsOpen(port)).toBe(false);
    }
  );

  it('fails on a pre-bound port instead of selecting another one', { timeout: 20_000 }, async () => {
    const bound = await bindRandomPort();
    try {
      const cli = startDirectCli(['serve', '--dev', '--host', '127.0.0.1', '--port', String(bound.port)]);
      const outcome = await within(cli.closed, 10_000);

      expect(outcome).toEqual({ code: 1, signal: null });
      expect(`${cli.stdout}\n${cli.stderr}`).toContain(`Port ${bound.port} is already in use`);
      expect(`${cli.stdout}\n${cli.stderr}`).not.toContain('trying another one');
      expect(cli.stdout).not.toContain('Local:');
      expect(await portIsOpen(bound.port)).toBe(true);
    } finally {
      await closeServer(bound.server);
    }
  });
});
