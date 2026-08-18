// Adoption of a surviving Moor holder must not depend on the size of its
// retained scrollback. The §3/§6 exchange (HELLO → ATTACH_ACK → TERMINAL_STATE)
// is what makes a holder adopted; the retained-output replay that follows is
// ordinary output for the emulator, delivered on the same backpressured path
// as live output. It must therefore never sit between ATTACH_ACK and the
// adoption decision — a heavy tail (a TUI that redrew itself up to the log
// cap) must not stall this session's adoption nor starve sibling adoptions
// running in the same daemon.
//
// Observed live (2026-08-18): codex holders carrying ~4 MiB / ~24k retained
// frames failed `restore-attach-failed` across two daemon restarts while
// ~300 KB claude holders adopted, because the buffered replay was drained
// synchronously inside the adoption critical section.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/** Retained lines the child prints before any daemon attaches (the "tail"). */
const HEAVY_TAIL_LINES = 6_000;
/** A shell that prints the tail once, then idles like a live TUI. */
const HEAVY_TAIL_COMMAND = [
  '/bin/sh',
  '-c',
  `i=0; while [ $i -lt ${HEAVY_TAIL_LINES} ]; do echo "redraw line $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done; sleep 120`
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
   * Let `preambleFlushes` more flushes through, then hold every later flush
   * until `open()` is called. The replay that follows the preamble is what
   * stalls behind the shut gate.
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
    args: [...NODE_IMPORT_ARGS, 'start', '-T', input.storeDir, input.sessionPath, ...input.command],
    generation: input.generation,
    env: { ...process.env, TMPDIR: input.tmpdirRoot }
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? -1));
  });
  if (code !== 0) throw new Error(`fake moor launcher exited ${code}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the holder has retained the whole heavy tail (child finished printing). */
async function waitForTail(sessionPath: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  // The fake holder mirrors retained output count in its witness file only on
  // attach; instead give the child time to finish printing — a bounded settle
  // that a slow CI box still satisfies, verified below by the byte count the
  // emulator eventually receives.
  while (Date.now() - startedAt < 1_500) await sleep(100);
  void sessionPath;
  void timeoutMs;
}

describe('adoption is independent of the retained replay size', () => {
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
    await waitForTail(sessions[0]!.sessionPath);
    const emulators = new Map<string, GatedEmu>();
    let nextEmulatorFor = 0;
    const state = { gateClosed: false };
    const manager = new SessionManager({
      ledger,
      supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 16 }),
      emulatorFactory: {
        create: () => {
          const emulator = new GatedEmu();
          if (state.gateClosed) emulator.closeAfter(1); // the §6 preamble is 1 flush; the replay is what stalls
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
    'adopts a heavy-tailed holder before its replay reaches the emulator, then delivers the replay in order',
    async () => {
      const w = await world('single', 1);
      const [session] = w.sessions;
      // Every emulator this world creates lets the mandatory §6 preamble drain
      // (that IS part of the adoption gate by spec) and then shuts its flush
      // gate: the retained replay cannot reach the screen until the test opens
      // it. If the adoption decision waited on the replay, the attach below
      // could not complete until open() — so it is asserted to complete FIRST,
      // with the gate still shut.
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
      // Adoption is published on the state axis — the sidebar would say so.
      expect(w.manager.stateSnapshot(session!.sessionId)?.lifecycle).toBe('running');

      // Only now let the screen drain: the retained tail arrives on the
      // ordinary output path, complete and in order, having never gated the
      // adoption above.
      emulator!.open();
      const expectedBytes = HEAVY_TAIL_LINES * ('redraw line 0 '.length + 150);
      const startedAt = Date.now();
      while (emulator!.bytesWritten() < expectedBytes * 0.9 && Date.now() - startedAt < 15_000) {
        await sleep(50);
      }
      const text = Buffer.concat(emulator!.written.map((chunk) => Buffer.from(chunk))).toString('utf8');
      expect(text.startsWith('redraw line 0 ')).toBe(true);
      expect(text).toContain(`redraw line ${HEAVY_TAIL_LINES - 1} `);
      expect(processAlive(session!.pid)).toBe(true);
    },
    60_000
  );

  it(
    'adopts every heavy-tailed holder when several are restored concurrently in one daemon',
    async () => {
      const HOLDERS = 6;
      const w = await world('many', HOLDERS);
      // Every screen drains slowly (gate shut after the preamble): with the
      // replay drained INSIDE the adoption critical section, the first
      // adoption would hold the event loop and its siblings' 2 s protocol
      // deadlines would expire before their own preambles were even read.
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
        expect(processAlive(session.pid)).toBe(true);
      }
      // Let the screens drain so teardown does not wait on a shut gate.
      for (const emulator of w.emulators.values()) emulator.open();
    },
    120_000
  );
});
