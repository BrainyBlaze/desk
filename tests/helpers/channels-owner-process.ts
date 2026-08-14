import { spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  ChannelsEngine,
  defaultPidStarttimeReader
} from '../../src/server/channelsEngine.js';

const CHILD_MARKER = '--channels-owner-child';

export type ChannelsOwnerMode = 'versioned' | 'legacy-two-line';

export interface ChannelsOwnerResult {
  pid: number;
  record: string;
  passive: boolean;
  lockError: string | null;
}

export interface RunningChannelsOwner {
  child: ChildProcess;
  exit: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>;
  ready: Promise<ChannelsOwnerResult>;
  release(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function startChannelsOwner(
  home: string,
  mode: ChannelsOwnerMode = 'versioned'
): RunningChannelsOwner {
  const token = randomUUID();
  const releasePath = join(home, `owner-release-${token}`);
  const resultPath = join(home, `owner-result-${token}.json`);
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(import.meta.url),
      CHILD_MARKER,
      mode,
      home,
      releasePath,
      resultPath
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
    while (!existsSync(resultPath)) {
      if (child.exitCode !== null || child.signalCode !== null) {
        const result = await exit;
        throw new Error(
          `channels owner exited before acquiring: ${result.stderr || result.stdout || result.code}`
        );
      }
      if (Date.now() >= deadline) {
        throw new Error('timed out waiting for channels owner acquisition');
      }
      await delay(5);
    }
    return JSON.parse(readFileSync(resultPath, 'utf8')) as ChannelsOwnerResult;
  })();

  return {
    child,
    exit,
    ready,
    async release() {
      if (child.exitCode === null && child.signalCode === null) {
        writeFileSync(releasePath, 'release');
      }
      const result = await exit;
      if (result.code !== 0) {
        throw new Error(
          `channels owner exited ${result.code}: ${result.stderr || result.stdout}`
        );
      }
    }
  };
}

function writeLegacyClaim(home: string): string {
  const engineDir = join(home, '_engine');
  const lockPath = join(engineDir, 'engine.pid');
  mkdirSync(engineDir, { recursive: true });
  const identity = defaultPidStarttimeReader(process.pid);
  if (identity.status !== 'known') {
    throw new Error(identity.diagnostic);
  }
  const record = `${process.pid}\n${identity.value}\n`;
  const fd = openSync(lockPath, 'wx');
  try {
    writeFileSync(fd, record);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return record;
}

function runOwnerChild(): void {
  const [modeRaw, home, releasePath, resultPath] = process.argv.slice(3);
  const mode = modeRaw as ChannelsOwnerMode;
  if (!home || !releasePath || !resultPath) {
    throw new Error('missing channels owner child arguments');
  }
  let engine: ChannelsEngine | undefined;
  const record =
    mode === 'versioned'
      ? (() => {
          engine = new ChannelsEngine({
            home,
            pumpIntervalMs: 1_000_000,
            sendText: async () => true,
            capturePane: async () => null,
            sendEnter: async () => true
          });
          if (engine.passive) {
            throw new Error(engine.lockError ?? 'versioned owner unexpectedly passive');
          }
          return readFileSync(join(home, '_engine', 'engine.pid'), 'utf8');
        })()
      : writeLegacyClaim(home);

  writeFileSync(
    resultPath,
    JSON.stringify({
      pid: process.pid,
      record,
      passive: engine?.passive ?? false,
      lockError: engine?.lockError ?? null
    } satisfies ChannelsOwnerResult)
  );
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(releasePath)) {
    Atomics.wait(waitCell, 0, 0, 5);
  }
  engine?.dispose();
}

if (process.argv[2] === CHILD_MARKER) {
  try {
    runOwnerChild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
