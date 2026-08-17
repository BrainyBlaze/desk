import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  disposeChannelsRuntime,
  initChannelsRuntime
} from '../../src/server/channels/api.js';

const CHILD_MARKER = '--channels-runtime-owner-child';

export interface RunningChannelsRuntimeOwner {
  child: ChildProcess;
  ready: Promise<{ pid: number }>;
  exit: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>;
  release(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startChannelsRuntimeOwner(home: string): RunningChannelsRuntimeOwner {
  const token = randomUUID();
  const readyPath = join(home, `runtime-owner-ready-${token}.json`);
  const releasePath = join(home, `runtime-owner-release-${token}`);
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(import.meta.url),
      CHILD_MARKER,
      home,
      readyPath,
      releasePath
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit({ code, signal, stdout, stderr }));
  });
  const ready = (async () => {
    const deadline = Date.now() + 5_000;
    while (!existsSync(readyPath)) {
      if (child.exitCode !== null || child.signalCode !== null) {
        const result = await exit;
        throw new Error(
          `channels runtime owner exited before acquiring: ${result.stderr || result.stdout || result.code}`
        );
      }
      if (Date.now() >= deadline) {
        throw new Error('timed out waiting for channels runtime owner acquisition');
      }
      await delay(5);
    }
    return JSON.parse(readFileSync(readyPath, 'utf8')) as { pid: number };
  })();

  return {
    child,
    ready,
    exit,
    async release() {
      if (child.exitCode === null && child.signalCode === null) {
        writeFileSync(releasePath, 'release');
      }
      const result = await exit;
      if (result.code !== 0) {
        throw new Error(
          `channels runtime owner exited ${result.code}: ${result.stderr || result.stdout}`
        );
      }
    }
  };
}

function runOwnerChild(): void {
  const [home, readyPath, releasePath] = process.argv.slice(3);
  if (!home || !readyPath || !releasePath) {
    throw new Error('missing channels runtime owner child arguments');
  }
  initChannelsRuntime({ home });
  writeFileSync(readyPath, JSON.stringify({ pid: process.pid }));
  // Poll on the event loop, NOT with Atomics.wait: the ownership lease
  // refreshes itself from a timer, and a blocked loop would silently stop
  // the heartbeat this helper exists to exercise.
  const poll = setInterval(() => {
    if (!existsSync(releasePath)) {
      return;
    }
    clearInterval(poll);
    disposeChannelsRuntime();
  }, 5);
}

if (process.argv[2] === CHILD_MARKER) {
  try {
    runOwnerChild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
