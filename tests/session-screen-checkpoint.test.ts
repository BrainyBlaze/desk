import { describe, expect, it } from 'vitest';
import { BpFrameType, type BpFrame } from '../src/shared/browserProtocol/index.js';
import {
  GenerationLedger,
  InMemoryGenerationLedger
} from '../src/shared/controlPlane/index.js';
import {
  DaemonCore,
  DEFAULT_SUPERVISOR_CONFIG,
  InMemorySessionScreenCheckpointStore,
  WorkerSupervisor,
  type EmulatorEvent,
  type EmulatorPort
} from '../src/shared/runtime/index.js';

class RestorableEmulator implements EmulatorPort {
  private readonly bytes: number[] = [];

  write(bytes: Uint8Array): void {
    this.bytes.push(...bytes);
  }

  resize(): void {}

  readTailText(): string[] {
    return [];
  }

  serialize(): string {
    return new TextDecoder().decode(Uint8Array.from(this.bytes));
  }

  cursor(): { row: number; col: number } {
    return { row: 0, col: this.bytes.length };
  }

  onEvent(_cb: (event: EmulatorEvent) => void): () => void {
    return () => {};
  }

  dispose(): void {}
}

function core(
  ledger: GenerationLedger,
  screens: InMemorySessionScreenCheckpointStore,
  browser: BpFrame[],
  redraws: number[]
): DaemonCore {
  return new DaemonCore({
    ledger,
    supervisor: new WorkerSupervisor({
      ...DEFAULT_SUPERVISOR_CONFIG,
      maxLiveWorkers: 8
    }),
    emulatorFactory: { create: () => new RestorableEmulator() },
    screenCheckpoints: screens,
    now: () => 1_000,
    sendBrowser: (_sessionId, _channelId, frame) => browser.push(frame),
    sendMasterInput: () => true,
    sendMasterResize: () => {},
    sendMasterRedraw: () => redraws.push(1)
  });
}

describe('daemon current-screen checkpoint', () => {
  it('restores the exact generation baseline without Moor replay or child redraw', () => {
    const generationStore = new InMemoryGenerationLedger();
    const screens = new InMemorySessionScreenCheckpointStore();
    const first = core(new GenerationLedger(generationStore), screens, [], []);
    const ensured = first.ensure('screened', { rows: 24, cols: 80 });
    expect(ensured).toEqual({ ok: true, generation: 2, created: true });
    first.onMoorOutput('screened', new TextEncoder().encode('painted screen'), 0n);

    expect(screens.get('screened', 2)).toMatchObject({
      sessionId: 'screened',
      generation: 2,
      outputOffset: 14n,
      geometry: { rows: 24, cols: 80 },
      snapshot: 'painted screen'
    });

    const browser: BpFrame[] = [];
    const redraws: number[] = [];
    const restarted = core(
      new GenerationLedger(generationStore),
      screens,
      browser,
      redraws
    );
    expect(restarted.restore('screened')).toEqual({
      ok: true,
      generation: 2,
      screenBaseline: 'checkpoint'
    });
    restarted.subscribe('screened', 'surface', 24, 80);

    expect(browser.at(-1)).toEqual({
      type: BpFrameType.SNAPSHOT,
      channelId: 1,
      generation: 2,
      revision: 0,
      offset: 14n,
      text: 'painted screen'
    });
    expect(redraws).toEqual([]);
  });

  it('never restores a checkpoint from an earlier generation', () => {
    const generationStore = new InMemoryGenerationLedger();
    const ledger = new GenerationLedger(generationStore);
    ledger.allocate('screened');
    const screens = new InMemorySessionScreenCheckpointStore();
    screens.record({
      sessionId: 'screened',
      generation: 1,
      outputOffset: 99n,
      geometry: { rows: 24, cols: 80 },
      snapshot: 'stale screen'
    });
    const browser: BpFrame[] = [];
    const restarted = core(ledger, screens, browser, []);

    expect(restarted.restore('screened')).toEqual({
      ok: true,
      generation: 2,
      screenBaseline: 'missing'
    });
    restarted.subscribe('screened', 'surface', 24, 80);

    expect(browser.at(-1)).toMatchObject({
      type: BpFrameType.SNAPSHOT,
      generation: 2,
      offset: 0n,
      text: ''
    });
  });

  it('does not persist an empty screen after adopting an uncovered Moor frontier', () => {
    const generationStore = new InMemoryGenerationLedger();
    const ledger = new GenerationLedger(generationStore);
    ledger.allocate('screened');
    const screens = new InMemorySessionScreenCheckpointStore();
    const restarted = core(ledger, screens, [], []);

    expect(restarted.restore('screened')).toEqual({
      ok: true,
      generation: 2,
      screenBaseline: 'missing'
    });
    restarted.adoptMoorOutputFrontier('screened', 123n);
    restarted.subscribe('screened', 'surface', 24, 80);

    expect(screens.get('screened', 2)).toBeUndefined();

    const terminalModes = new TextEncoder().encode('\x1b[?2004h\x1b[?1004h');
    restarted.onMoorOutput('screened', terminalModes, 123n);
    expect(screens.get('screened', 2)).toBeUndefined();

    restarted.onMoorOutput(
      'screened',
      new TextEncoder().encode('fresh repaint'),
      123n + BigInt(terminalModes.length)
    );
    expect(screens.get('screened', 2)).toMatchObject({
      outputOffset: 136n + BigInt(terminalModes.length),
      snapshot: '\x1b[?2004h\x1b[?1004hfresh repaint'
    });
  });
});
