import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BpFrameType } from '../src/shared/browserProtocol/index.js';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { crc32c } from '../src/shared/moorWire/crc32c.js';
import {
  DaemonCore,
  DEFAULT_SUPERVISOR_CONFIG,
  WorkerSupervisor,
  type BpFrame,
  type EmulatorEvent,
  type EmulatorPort
} from '../src/shared/runtime/index.js';
import {
  MoorCurrentExitEvidenceError,
  readCurrentMoorGenerationExitEvidence
} from '../src/server/runtime/moorGenerationStores.js';
import {
  MoorEventObserver,
  type MoorSessionEvent
} from '../src/server/runtime/moorEventObserver.js';
import { MoorStoreKind } from '../src/server/runtime/moorStore.js';

const encoder = new TextEncoder();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function identity(sessionPath: string): Uint8Array {
  return Uint8Array.of(1, ...Buffer.from(sessionPath));
}

function eventBody(sessionPath: string, code: number): Uint8Array {
  const session = Buffer.from(identity(sessionPath)).toString('base64');
  return encoder.encode(
    `{"v":2,"type":"header","ts":1,"session":"${session}","generation":2,"epoch":1,"next_seq":2,"first_retained":1}\n` +
      `{"type":"exit","ts":1,"epoch":1,"seq":1,"kind":"transition","ended":"exited","code":${code},"method":"none"}\n`
  );
}

function lifecycleBody(
  sessionPath: string,
  code: number,
  method: 'none' | 'graceful' | 'forced' = 'none'
): Uint8Array {
  const session = Buffer.from(identity(sessionPath)).toString('base64');
  const nonce = Buffer.alloc(16).toString('base64');
  return encoder.encode(
    `{"v":2,"type":"lifecycle","phase":"exited","session":"${session}","generation":2,"wire_generation":2,"incarnation":"${nonce}","start_wall_ms":"1","start_mono_ms":"1","boot_id":"${nonce}","path_encoding":"posix-bytes","event_path":null,"instrument_path":null,"end_wall_ms":"2","output_end":"2","ended":"exited","code":${code},"method":"${method}"}\n`
  );
}

function commitRecord(
  kind: MoorStoreKind,
  bytes: Uint8Array,
  index: bigint,
  start: bigint,
  end: bigint
): Uint8Array {
  const record = new Uint8Array(92);
  const view = new DataView(record.buffer);
  record.set(encoder.encode('MOORCMT1'), 0);
  record[8] = 1;
  record[9] = 0;
  record[10] = 0;
  record[11] = kind;
  view.setUint32(12, 2, true);
  view.setUint32(16, 1, true);
  view.setBigUint64(24, index, true);
  view.setBigUint64(32, BigInt(bytes.length), true);
  view.setBigUint64(40, start, true);
  view.setBigUint64(48, end, true);
  record.set(createHash('sha256').update(bytes).digest(), 56);
  view.setUint32(88, crc32c(record.subarray(0, 88)), true);
  return record;
}

async function writeStore(
  directory: string,
  kind: MoorStoreKind,
  bytes: Uint8Array,
  index: bigint,
  start: bigint,
  end: bigint
): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  await Promise.all([
    writeFile(join(directory, 'body.0'), bytes, { mode: 0o600 }),
    writeFile(join(directory, 'body.1'), new Uint8Array(), { mode: 0o600 }),
    writeFile(join(directory, 'commit.0'), commitRecord(kind, bytes, index, start, end), {
      mode: 0o600
    }),
    writeFile(join(directory, 'commit.1'), new Uint8Array(), { mode: 0o600 })
  ]);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class BlockingEmulator implements EmulatorPort {
  readonly written: number[] = [];
  private releaseDrain!: () => void;
  private readonly drain = new Promise<void>((resolve) => {
    this.releaseDrain = resolve;
  });

  write(bytes: Uint8Array): void {
    this.written.push(...bytes);
  }
  flush(): Promise<void> {
    return this.drain;
  }
  release(): void {
    this.releaseDrain();
  }
  resize(): void {}
  readTailText(): string[] {
    return [];
  }
  serialize(): string {
    return new TextDecoder().decode(Uint8Array.from(this.written));
  }
  cursor(): { row: number; col: number } {
    return { row: 0, col: 0 };
  }
  onEvent(_callback: (event: EmulatorEvent) => void): () => void {
    return () => undefined;
  }
  dispose(): void {}
}

function classifyExitError(
  error: unknown,
  event: MoorSessionEvent
): 'continue' | 'retry' | 'terminal' {
  if (error instanceof MoorCurrentExitEvidenceError) {
    return error.code === 'UNAVAILABLE' ? 'retry' : 'terminal';
  }
  return event.type === 'exit' ? 'terminal' : 'continue';
}

describe('Moor current exit output boundary', () => {
  it('retries a missing stable exit without advancing, then renders x,y,EXIT exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desk-current-exit-'));
    roots.push(root);
    await chmod(root, 0o700);
    const sessionPath = join(root, 'session.sock');
    const eventsPath = join(root, 'final.events');
    await writeStore(eventsPath, MoorStoreKind.Event, eventBody(sessionPath, 7), 1n, 1n, 2n);

    const emulator = new BlockingEmulator();
    const browserOut: BpFrame[] = [];
    const core = new DaemonCore({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: { create: () => emulator },
      now: () => 1,
      sendBrowser: (_sessionId, _channelId, frame) => browserOut.push(frame),
      sendMasterInput: () => undefined,
      sendMasterResize: () => undefined
    });
    core.ensure('session', { rows: 24, cols: 80 });
    core.subscribe('session', 'surface', 24, 80);
    browserOut.length = 0;

    const x = core.onMoorOutput('session', encoder.encode('x'), 0n);
    let exitAttempts = 0;
    let exitApplications = 0;
    const observer = new MoorEventObserver({
      directory: eventsPath,
      generation: 2,
      identity: identity(sessionPath),
      pollIntervalMs: 10,
      onEvent: async (event) => {
        if (event.type !== 'exit') return;
        exitAttempts += 1;
        const evidence = await readCurrentMoorGenerationExitEvidence(sessionPath, 2);
        if (
          evidence.outcome.ended !== 'exited' ||
          event.outcome.kind !== 'exited' ||
          evidence.outcome.code !== event.outcome.code ||
          evidence.outcome.method !== event.outcome.method
        ) {
          throw new Error('lifecycle/event exit mismatch');
        }
        exitApplications += 1;
        await core.emitExit('session', event.code, BigInt(evidence.outputEnd));
      },
      onEventError: classifyExitError,
      onDiagnostic: () => undefined
    });

    expect(await observer.start()).toBe(true);
    expect(exitAttempts).toBe(1);
    expect(exitApplications).toBe(0);

    const staging = `${sessionPath}.exit.next`;
    await writeStore(staging, MoorStoreKind.Exit, lifecycleBody(sessionPath, 7), 2n, 2n, 2n);
    await rename(staging, `${sessionPath}.exit`);
    expect(await readCurrentMoorGenerationExitEvidence(sessionPath, 2)).toMatchObject({
      generation: 2,
      outputEnd: '2',
      outcome: { ended: 'exited', code: 7, method: 'none' }
    });
    await waitFor(() => core.hasPendingExitBoundary('session'), 'validated exit boundary');

    const y = core.onMoorOutput('session', encoder.encode('y'), 1n);
    emulator.release();
    await Promise.all([x, y]);
    await waitFor(
      () => browserOut.some((frame) => frame.type === BpFrameType.EXIT),
      'browser EXIT'
    );

    expect(exitAttempts).toBeGreaterThanOrEqual(2);
    expect(exitApplications).toBe(1);
    expect(emulator.serialize()).toBe('xy');
    expect(browserOut.map((frame) => frame.type)).toEqual([
      BpFrameType.OUTPUT,
      BpFrameType.OUTPUT,
      BpFrameType.EXIT
    ]);
    observer.stop();
  });

  it('terminally rejects a contradictory stable exit without advancing the event cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desk-current-exit-mismatch-'));
    roots.push(root);
    await chmod(root, 0o700);
    const sessionPath = join(root, 'session.sock');
    const eventsPath = join(root, 'final.events');
    await writeStore(eventsPath, MoorStoreKind.Event, eventBody(sessionPath, 7), 1n, 1n, 2n);
    await writeStore(
      `${sessionPath}.exit`,
      MoorStoreKind.Exit,
      lifecycleBody(sessionPath, 7, 'forced'),
      2n,
      2n,
      2n
    );

    let terminal = 0;
    const observer = new MoorEventObserver({
      directory: eventsPath,
      generation: 2,
      identity: identity(sessionPath),
      onEvent: async (event) => {
        if (event.type !== 'exit') return;
        const evidence = await readCurrentMoorGenerationExitEvidence(sessionPath, 2);
        if (
          evidence.outcome.ended !== 'exited' ||
          event.outcome.kind !== 'exited' ||
          evidence.outcome.code !== event.outcome.code ||
          evidence.outcome.method !== event.outcome.method
        ) {
          throw new Error('lifecycle/event exit mismatch');
        }
      },
      onEventError: classifyExitError,
      onDiagnostic: () => undefined,
      onTerminal: () => {
        terminal += 1;
      }
    });

    expect(await observer.start()).toBe(false);
    expect(terminal).toBe(1);
    expect(
      (observer as unknown as { cursor?: { commitIndex: bigint } }).cursor
    ).toBeUndefined();
  });
});
