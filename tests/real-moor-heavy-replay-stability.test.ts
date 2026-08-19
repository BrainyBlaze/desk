// Live-stand witness on the REAL Moor holder and the REAL @xterm/headless
// emulator: after a daemon restart adopts several holders that retained a
// heavy TUI tail (many small redraw records, up to the §6.7 4 MiB retention
// bound), the daemon must keep every adopted link alive while it drains those
// tails into the emulators — no holder-side disconnect, no controller-link
// recovery, no re-attach storm.
//
// Why the real holder: the holder keeps a 4 MiB per-peer outbound queue and
// silently disconnects a controller that stops reading its socket
// (moor io.rs Duplex::closing(…, 4 << 20); holder.rs disconnect on overflow;
// spec §6.7 "a viewer that cannot drain the baseline before later live bytes
// cross its bound is disconnected"). A fake holder without that bound cannot
// reproduce the production failure of 2026-08-18: adoption succeeded in
// seconds (PR #101) and then every link cycled through recovery at ~450% CPU
// because emulator drain starved socket reads.
//
// Why the real emulator: the fake emulators used elsewhere make flush cheap or
// gated; the failure needs the production parse cost per record.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { spawnMoorMaster } from '../src/server/runtime/moorSpawnMaster.js';
import { moorEventStoreRoot } from '../src/server/runtime/moorEventObserver.js';
import { XtermEmulator } from '../src/server/runtime/xtermEmulator.js';
import { GenerationLedger } from '../src/shared/controlPlane/generationLedger.js';
import { InMemoryGenerationLedger, type SessionStateTransition } from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG } from '../src/shared/runtime/workerSupervisor.js';

// The vendored Moor binary is a build artifact (libexec/moor); a worktree may
// not have it, so accept an explicit override and skip honestly otherwise.
const MOOR_BIN = process.env.DESK_STAND_MOOR_BIN ?? join(process.cwd(), 'libexec', 'moor');
const HAVE_MOOR = existsSync(MOOR_BIN);

/** How many holders restart adopts at once (the live incident had 9 heavy ones). */
const HOLDERS = 6;
/**
 * A TUI-like tail: many small redraw records (clear + home + a line), well
 * past 4 MiB in total so the holder's retention is at its bound, exactly like
 * a long-running codex session. ~120 B per record → 40 000 records ≈ 4.6 MiB.
 */
const HEAVY_TUI_TAIL = [
  '/bin/sh',
  '-c',
  // 40 000 retained redraw records (≈4.6 MiB, past the holder's 4 MiB cap),
  // then the TUI keeps LIVE-redrawing (~40 frames/s ≈ 5 KB/s) for the rest of
  // the run — spec §6.7 disconnects a viewer that cannot drain its baseline
  // before later live bytes cross the bound, so live output during the drain
  // is exactly the production condition.
  'i=0; while [ $i -lt 40000 ]; do printf "\\033[2J\\033[H redraw frame %d %080d\\n" $i $i; i=$((i+1)); done; while :; do printf "\\033[2J\\033[H live frame %d %080d\\n" $i $i; i=$((i+1)); sleep 0.025; done'
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function killHolder(sessionPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(MOOR_BIN, ['kill', '-f', '-q', sessionPath], { stdio: 'ignore' });
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
}

async function spawnHolder(input: {
  sessionPath: string;
  storeDir: string;
  generation: number;
  command: string[];
}): Promise<void> {
  const { child } = spawnMoorMaster({
    binPath: MOOR_BIN,
    args: ['start', '-T', input.storeDir, input.sessionPath, ...input.command],
    generation: input.generation,
    env: process.env
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? -1));
  });
  if (code !== 0) throw new Error(`moor launcher exited ${code}`);
}

describe.skipIf(!HAVE_MOOR)('real Moor holder × real emulator: heavy replay never starves the adopted links', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it(
    'adopts every heavy-tailed holder and keeps every link alive through the drain (no holder disconnect, no recovery)',
    async () => {
      // Sockets must stay under the sun_path bound: a short root under /tmp.
      const root = mkdtempSync(join(tmpdir(), 'desk-hr-'));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const storeRoot = moorEventStoreRoot(MOOR_BIN);
      const ledger = new GenerationLedger(new InMemoryGenerationLedger());
      const sessions: Array<{ sessionId: string; sessionPath: string; storeDir: string }> = [];
      for (let index = 0; index < HOLDERS; index += 1) {
        const sessionId = `hr${process.pid}-${index}`;
        const sessionPath = join(root, sessionId);
        const generation = ledger.allocate(sessionId);
        expect(generation).toBe(2);
        const storeDir = join(storeRoot, `${sessionId}.${generation}.events`);
        cleanups.push(async () => {
          await killHolder(sessionPath);
          rmSync(storeDir, { recursive: true, force: true });
        });
        await spawnHolder({ sessionPath, storeDir, generation, command: HEAVY_TUI_TAIL });
        sessions.push({ sessionId, sessionPath, storeDir });
      }
      // Let the children print their tails (the holder caps retention at 4 MiB;
      // we want it AT the cap, like a long-lived TUI).
      await sleep(6_000);

      const recoveries: string[] = [];
      let browserFrames = 0;
      let browserBytes = 0;
      const manager = new SessionManager({
        ledger,
        supervisor: new WorkerSupervisor({ ...DEFAULT_SUPERVISOR_CONFIG, maxLiveWorkers: 16 }),
        emulatorFactory: { create: () => new XtermEmulator({ rows: 48, cols: 160 }) },
        now: () => Date.now(),
        // A browser tab keeps every group's cells mounted (keep-alive), so each
        // session has a live, visible subscriber receiving fan-out and reveal
        // snapshots — the production shape, not a headless daemon.
        sendBrowser: (_sessionId, _channelId, frame) => {
          browserFrames += 1;
          const bytes = (frame as { bytes?: Uint8Array; text?: string }).bytes?.length ?? (frame as { text?: string }).text?.length ?? 0;
          browserBytes += bytes;
        },
        onStateTransition: (transition: SessionStateTransition) => {
          const health = transition.to.health;
          if (health.status === 'degraded' && health.detail === 'controller-link-recovery') {
            recoveries.push(`${transition.sessionId}@${transition.generation}`);
          }
        }
      });
      cleanups.push(() => manager.closeAllLinks());

      // The restart: adopt everything at once, like terminalDaemonMain does.
      const startedAt = Date.now();
      const results = await Promise.all(
        sessions.map((session) =>
          manager.restoreAndAttachMoor(session.sessionId, {
            sessionPath: session.sessionPath,
            killSpec: { binPath: MOOR_BIN, args: ['kill', '-f', session.sessionPath] }
          })
        )
      );
      const adoptionMs = Date.now() - startedAt;
      // One visible surface per session, subscribed right after adoption —
      // the browser re-subscribes its mounted cells the moment the daemon is back.
      for (const session of sessions) {
        expect(manager.subscribe(session.sessionId, `surf-${session.sessionId}`, 48, 160)).toBeDefined();
      }
      const failed = results
        .map((result, index) => ({ result, session: sessions[index]! }))
        .filter(({ result }) => !result.ok)
        .map(({ session, result }) => `${session.sessionId}: ${JSON.stringify(result)}`);
      expect(failed).toEqual([]);
      // Adoption is bounded by the protocol, not by the tails (PR #101).
      expect(adoptionMs).toBeLessThan(10_000);

      // Now the part PR #101 exposed: while the daemon drains ~4 MiB × N into
      // real emulators, it must keep reading every holder socket. The holder's
      // 4 MiB per-peer bound would otherwise disconnect the link (silently),
      // Desk would see a close, and recovery would re-attach and re-drain —
      // the storm. Watch for long enough to cover the whole drain.
      const cpuStart = process.cpuUsage();
      await sleep(45_000);
      const cpu = process.cpuUsage(cpuStart);
      const cpuSeconds = (cpu.user + cpu.system) / 1e6;
      for (const session of sessions) {
        const snapshot = manager.stateSnapshot(session.sessionId);
        expect(snapshot?.lifecycle).toBe('running');
        expect(snapshot?.health).not.toMatchObject({ reason: 'moor-holder-liveness' });
        expect(manager.moorStatus(session.sessionId)).toBeDefined();
      }
      expect(recoveries).toEqual([]);
      // Draining N × 4 MiB through xterm is real work, but it must not pin the
      // process: well under one core over the observation window.
      // eslint-disable-next-line no-console
      console.log(`stand: adoption ${adoptionMs} ms, cpu ${cpuSeconds.toFixed(1)} s / 45 s, browser frames ${browserFrames} bytes ${browserBytes}, recoveries ${recoveries.length}`);
      expect(cpuSeconds).toBeLessThan(45 * 0.75);
    },
    120_000
  );
});
