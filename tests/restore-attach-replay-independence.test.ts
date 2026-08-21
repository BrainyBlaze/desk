// Desk starts terminal holders with `-C 0` and adopts them live-only. Output
// produced before attachment is therefore neither retained by Moor nor replayed
// into the emulator. A large pre-attach redraw must have zero effect on attach
// latency, while output produced after attachment still follows the ordinary
// backpressured path.
//
// Observed live (2026-08-18): codex holders carrying ~4 MiB / ~24k retained
// frames failed `restore-attach-failed` across two daemon restarts while
// ~300 KB claude holders adopted, because the buffered replay was drained
// synchronously inside the adoption critical section.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { spawnMoorMaster } from '../src/server/runtime/moorSpawnMaster.js';
import { moorEventStoreRoot } from '../src/server/runtime/moorEventObserver.js';
import { GenerationLedger } from '../src/shared/controlPlane/generationLedger.js';
import { InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG } from '../src/shared/runtime/workerSupervisor.js';
import type { EmulatorEvent, EmulatorPort } from '../src/shared/runtime/emulatorPort.js';

const FAKE = fileURLToPath(new URL('./helpers/fake-moor-holder.ts', import.meta.url));
const NODE_IMPORT_ARGS = ['--import', 'tsx', FAKE];

/** Lines the child prints before any daemon attaches. They must be discarded. */
const HEAVY_TAIL_LINES = 6_000;
/** A shell that prints once, then emits a marker after the test signals attach. */
const HEAVY_TAIL_COMMAND = [
  '/bin/sh',
  '-c',
  `i=0; while [ $i -lt ${HEAVY_TAIL_LINES} ]; do echo "redraw line $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done; : > "$FAKE_MOOR_PREATTACH_DONE"; while [ ! -e "$FAKE_MOOR_LIVE_TRIGGER" ]; do sleep 0.01; done; printf 'live-after-attach\\n'; exec cat`
];

/**
 * An emulator whose write() is cheap but whose flush() is a promise the test
 * controls. That is exactly the shape of the real @xterm/headless adapter
 * (parse work drains asynchronously) with the cost made explicit and
 * deterministic instead of platform-dependent.
 */
class GatedEmu implements EmulatorPort {
  readonly written: Uint8Array[] = [];
  private gate: Promise<void> = Promise.resolve();
  private release: (() => void) | undefined;
  /** Flushes still allowed through before the gate shuts (the mandatory
   *  §6 preamble drains through the emulator too, and that one IS part of the
   *  adoption gate by spec — only the replay must not be). */
  private freeFlushes = 0;
  write(bytes: Uint8Array): void {
    this.written.push(bytes.slice());
  }
  /**
   * Let `preambleFlushes` more flushes through, then hold later live output
   * until `open()` is called.
   */
  closeAfter(preambleFlushes: number): void {
    this.freeFlushes = preambleFlushes;
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  open(): void {
    this.release?.();
    this.release = undefined;
  }
  flush(): Promise<void> {
    if (this.release === undefined) return Promise.resolve();
    if (this.freeFlushes > 0) {
      this.freeFlushes -= 1;
      return Promise.resolve();
    }
    return this.gate;
  }
  resize(): void {}
  readTailText(): string[] {
    return [];
  }
  serialize(): string {
    return '';
  }
  cursor(): { row: number; col: number } {
    return { row: 0, col: 0 };
  }
  onEvent(_cb: (e: EmulatorEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
  bytesWritten(): number {
    return this.written.reduce((sum, chunk) => sum + chunk.length, 0);
  }
}

function holderPid(sessionPath: string): number {
  return Number(readFileSync(`${sessionPath}.holder-pid`).toString().trim());
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killSurvivingHolder(sessionPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [...NODE_IMPORT_ARGS, 'kill', sessionPath], {
      stdio: 'ignore'
    });
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
}

async function spawnSurvivingHolder(input: {
  sessionPath: string;
  storeDir: string;
  generation: number;
  command: string[];
  tmpdirRoot: string;
}): Promise<void> {
  const { child } = spawnMoorMaster({
    binPath: process.execPath,
    args: [
      ...NODE_IMPORT_ARGS,
      'start',
      '-C',
      '0',
      '-T',
      input.storeDir,
      input.sessionPath,
      ...input.command
    ],
    generation: input.generation,
    env: {
      ...process.env,
      TMPDIR: input.tmpdirRoot,
      FAKE_MOOR_REQUIRE_C0: '1',
      FAKE_MOOR_PREATTACH_DONE: `${input.sessionPath}.pre-attach-done`,
      FAKE_MOOR_LIVE_TRIGGER: `${input.sessionPath}.live-trigger`
    }
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? -1));
  });
  if (code !== 0) throw new Error(`fake moor launcher exited ${code}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Give the child time to finish the pre-attach burst before adoption.
 */
async function waitForTail(sessionPaths: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (sessionPaths.every((sessionPath) => existsSync(`${sessionPath}.pre-attach-done`))) return;
    await sleep(20);
  }
  throw new Error('pre-attach output did not finish');
}

describe('live-only adoption with a zero-byte Moor cache', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function world(id: string, holders: number) {
    const root = mkdtempSync(join(tmpdir(), `desk-replay-${id}-`));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const ledger = new GenerationLedger(new InMemoryGenerationLedger());
    const sessions: Array<{ sessionId: string; sessionPath: string; pid: number }> = [];
    for (let index = 0; index < holders; index += 1) {
      const sessionId = `${id}-${index}`;
      const sessionPath = join(root, sessionId);
      cleanups.push(() => killSurvivingHolder(sessionPath));
      expect(ledger.allocate(sessionId)).toBe(2);
      await spawnSurvivingHolder({
        sessionPath,
        storeDir: join(moorEventStoreRoot(process.execPath, { tmpdir: root }), `${sessionId}.events`),
        generation: 2,
        command: HEAVY_TAIL_COMMAND,
        tmpdirRoot: root
      });
      const pid = holderPid(sessionPath);
      expect(processAlive(pid)).toBe(true);
      sessions.push({ sessionId, sessionPath, pid });
    }
    await waitForTail(sessions.map(({ sessionPath }) => sessionPath));
    const emulators = new Map<string, GatedEmu>();
    let nextEmulatorFor = 0;
    const state = { gateClosed: false };
    const manager = new SessionManager({
      ledger,
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 16 }),
      emulatorFactory: {
        create: () => {
          const emulator = new GatedEmu();
          if (state.gateClosed) emulator.closeAfter(1);
          emulators.set(sessions[nextEmulatorFor]!.sessionId, emulator);
          nextEmulatorFor += 1;
          return emulator;
        }
      },
      now: () => Date.now(),
      sendBrowser: () => {}
    });
    cleanups.push(() => manager.closeAllLinks());
    return {
      root,
      ledger,
      sessions,
      manager,
      emulators,
      set gateClosed(value: boolean) {
        state.gateClosed = value;
      }
    };
  }

  it(
    'drops all pre-attach output and delivers the first post-attach live bytes',
    async () => {
      const w = await world('single', 1);
      const [session] = w.sessions;
      w.gateClosed = true;
      let emulator: GatedEmu | undefined;
      const restored = await Promise.race([
        (async () => {
          const result = await w.manager.restoreAndAttachMoor(session!.sessionId, {
            sessionPath: session!.sessionPath,
            killSpec: { binPath: '/bin/sh', args: ['-c', `kill -9 ${session!.pid}`] }
          });
          emulator = w.emulators.get(session!.sessionId);
          return result;
        })(),
        sleep(10_000).then(() => 'timeout' as const)
      ]);
      expect(restored).not.toBe('timeout');
      expect((restored as { ok: boolean }).ok).toBe(true);
      expect(emulator).toBeDefined();
      expect(w.manager.stateSnapshot(session!.sessionId)?.lifecycle).toBe('running');
      expect(emulator!.bytesWritten()).toBe(0);

      emulator!.open();
      const liveMarker = 'live-after-attach\n';
      writeFileSync(`${session!.sessionPath}.live-trigger`, '');
      const startedAt = Date.now();
      let text = '';
      while (Date.now() - startedAt < 10_000) {
        text = Buffer.concat(emulator!.written.map((chunk) => Buffer.from(chunk))).toString('utf8');
        if (text.includes(liveMarker)) break;
        await sleep(20);
      }
      expect(text).toContain(liveMarker);
      expect(text).not.toContain('redraw line ');
      expect(processAlive(session!.pid)).toBe(true);
    },
    30_000
  );

  it(
    'adopts every zero-cache holder concurrently without writing pre-attach bytes',
    async () => {
      const HOLDERS = 6;
      const w = await world('many', HOLDERS);
      w.gateClosed = true;
      const results = await Promise.all(
        w.sessions.map((session) =>
          w.manager.restoreAndAttachMoor(session.sessionId, {
            sessionPath: session.sessionPath,
            killSpec: { binPath: '/bin/sh', args: ['-c', `kill -9 ${session.pid}`] }
          })
        )
      );
      // Every holder was alive and answering; a failed adoption here is the
      // daemon starving itself, not a holder refusal.
      const failed = results
        .map((result, index) => ({ result, session: w.sessions[index]! }))
        .filter(({ result }) => !result.ok)
        .map(({ session, result }) => `${session.sessionId}: ${JSON.stringify(result)}`);
      expect(failed).toEqual([]);
      for (const session of w.sessions) {
        expect(w.manager.stateSnapshot(session.sessionId)?.lifecycle).toBe('running');
        expect(w.emulators.get(session.sessionId)?.bytesWritten()).toBe(0);
        expect(processAlive(session.pid)).toBe(true);
      }
      for (const emulator of w.emulators.values()) emulator.open();
    },
    120_000
  );
});
