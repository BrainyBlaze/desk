import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ServeMode = 'vite' | 'standalone';

export interface ServeOptions {
  mode: ServeMode;
  host: string;
  port: number;
}

export interface ServeEnvironment {
  DESK_HOST?: string;
  DESK_PORT?: string;
}

export interface ServeLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
}

export function parseServeOptions(
  argv: readonly string[],
  env: ServeEnvironment = process.env
): ServeOptions {
  let mode: ServeMode = 'standalone';
  let hostFlag: string | undefined;
  let portFlag: string | undefined;
  const seen = new Set<string>();

  let cursor = 0;
  while (cursor < argv.length) {
    const argument = argv[cursor];

    if (argument === '--dev') {
      if (seen.has(argument)) {
        throw new Error(`${argument} may be specified only once`);
      }
      seen.add(argument);
      mode = 'vite';
      cursor += 1;
      continue;
    }

    if (argument === '--host' || argument === '--port') {
      if (seen.has(argument)) {
        throw new Error(`${argument} may be specified only once`);
      }
      seen.add(argument);

      const value = argv[cursor + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }

      if (argument === '--host') {
        hostFlag = value;
      } else {
        portFlag = value;
      }
      cursor += 2;
      continue;
    }

    if (argument.startsWith('--')) {
      throw new Error(`unknown option ${argument}`);
    }
    throw new Error(`unexpected argument ${argument}`);
  }

  const host = hostFlag ?? env.DESK_HOST ?? '127.0.0.1';
  const portValue = portFlag ?? env.DESK_PORT ?? '5173';
  if (host.length === 0) {
    throw new Error('host must not be empty');
  }
  if (!/^\d+$/.test(portValue)) {
    throw new Error('port must be an integer from 1 through 65535');
  }

  const port = Number(portValue);
  if (port < 1 || port > 65535) {
    throw new Error('port must be an integer from 1 through 65535');
  }

  return { mode, host, port };
}

export function findPackageRoot(fromUrl: string): string {
  let directory = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      existsSync(join(directory, 'package.json')) &&
      (existsSync(join(directory, 'vite.config.ts')) || existsSync(join(directory, 'dist', 'cli', 'main.js')))
    ) {
      return directory;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error('cannot locate the desk package root (reinstall desk)');
}

export function createServeLaunch(
  root: string,
  options: ServeOptions,
  nodeExecutable: string = process.execPath,
  parentEnv: NodeJS.ProcessEnv = process.env
): ServeLaunch {
  if (options.mode === 'vite') {
    const viteEntry = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
    if (!existsSync(viteEntry)) {
      throw new Error(`Vite runtime is missing at ${viteEntry}; reinstall desk`);
    }
    return {
      command: nodeExecutable,
      args: [viteEntry, '--host', options.host, '--port', String(options.port), '--strictPort'],
      cwd: root,
      env: parentEnv,
      label: `desk starting (dev) on http://${options.host}:${options.port}  (Ctrl-C to stop)`
    };
  }

  const standaloneEntry = join(root, 'libexec', 'desk-standalone');
  if (!existsSync(standaloneEntry)) {
    throw new Error(`Standalone runtime is missing at ${standaloneEntry}; reinstall desk`);
  }
  return {
    command: standaloneEntry,
    args: [],
    cwd: root,
    env: {
      ...parentEnv,
      DESK_HOST: options.host,
      DESK_PORT: String(options.port)
    },
    label: `desk starting (standalone) on http://${options.host}:${options.port}  (Ctrl-C to stop)`
  };
}

type ForwardedSignal = 'SIGINT' | 'SIGTERM';

function signalExitCode(signal: NodeJS.Signals | undefined): number {
  if (signal === 'SIGINT') {
    return 130;
  }
  if (signal === 'SIGTERM') {
    return 143;
  }
  return 1;
}

export function runServeLaunch(launch: ServeLaunch): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let child: ChildProcess | undefined;
    let settled = false;
    let pendingSignal: ForwardedSignal | undefined;
    let forwardedSignal: ForwardedSignal | undefined;

    const removeSignalHandlers = () => {
      process.off('SIGINT', handleSigint);
      process.off('SIGTERM', handleSigterm);
    };
    const resolveOnce = (status: number) => {
      if (settled) {
        return;
      }
      settled = true;
      removeSignalHandlers();
      resolve(status);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      removeSignalHandlers();
      reject(error);
    };
    const forwardSignal = (signal: ForwardedSignal) => {
      forwardedSignal = signal;
      if (child?.pid === undefined) {
        pendingSignal = signal;
        return;
      }
      pendingSignal = child.kill(signal) ? undefined : signal;
    };
    function handleSigint(): void {
      forwardSignal('SIGINT');
    }
    function handleSigterm(): void {
      forwardSignal('SIGTERM');
    }

    process.on('SIGINT', handleSigint);
    process.on('SIGTERM', handleSigterm);

    try {
      child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio: 'inherit'
      });
    } catch (error) {
      rejectOnce(error);
      return;
    }

    child.once('spawn', () => {
      if (pendingSignal !== undefined) {
        forwardSignal(pendingSignal);
      }
    });
    child.once('error', rejectOnce);
    child.once('close', (code, signal) => {
      resolveOnce(code ?? signalExitCode(signal ?? forwardedSignal));
    });
  });
}
