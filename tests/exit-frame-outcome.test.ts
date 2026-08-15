// desk#70 inventory 4 — the browser EXIT frame reported an unprovable session
// ending as "exited code 0". The observer's legacyExitCode folded `unknown` to
// 0 because the frame had no way to say "unknown", and TerminalSurface printed
// that number as a clean exit. The durable record was honest all along (it
// persists the tagged outcome); only this edge view lied.
//
// These witnesses drive the REAL path end to end — SessionManager (the moor
// observer's consumer) → DaemonCore → SessionRuntime → EXIT frame → codec →
// BinaryTerminalBrokerClient → the line TerminalSurface writes — and assert the
// word, never a zero. Harness shapes are the ones exit-provenance-real-path and
// the broker-client suite already use.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BpFrameType, encodeBpFrame, type BpFrame } from '../src/shared/browserProtocol/index.js';
import type { MoorExitOutcome } from '../src/shared/controlPlane/contract.js';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  WorkerSupervisor,
  type EmulatorPort
} from '../src/shared/runtime/index.js';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { BinaryTerminalBrokerClient } from '../src/web/binaryTerminalBrokerClient.js';
import { describeSessionExit } from '../src/web/terminalExitLine.js';
import { FakeBinaryBrokerSocket } from './helpers/fake-binary-broker-socket.js';

class NullEmu implements EmulatorPort {
  write(): void {}
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
  onEvent(): () => void {
    return () => {};
  }
  dispose(): void {}
}

/**
 * One browser tab against one daemon: every frame the daemon sends is encoded
 * exactly as the WS router encodes it and delivered into the real broker
 * client; the surface's onExit renders the line the way TerminalSurface does.
 */
function tab() {
  const socket = new FakeBinaryBrokerSocket();
  const client = new BinaryTerminalBrokerClient(() => socket, 'ws://test');
  const daemonFrames: BpFrame[] = [];
  const mgr = new SessionManager({
    ledger: new GenerationLedger(new InMemoryGenerationLedger()),
    supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
    emulatorFactory: { create: () => new NullEmu() },
    now: () => 1_000,
    sendBrowser: (_sessionId, _channelId, frame) => {
      daemonFrames.push(frame);
      socket.deliverBytes(encodeBpFrame(frame));
    }
  });
  const rendered: string[] = [];
  const exits: MoorExitOutcome[] = [];
  client.subscribe('surface-1', 'sess', 24, 80, true, {
    onOutput: () => {},
    onSnapshot: () => {},
    onExit: (outcome) => {
      exits.push(outcome);
      rendered.push(describeSessionExit(outcome));
    },
    onClientError: () => {}
  });
  socket.fireOpen();
  // The router's SUBSCRIBE handling, fed the SUBSCRIBE the client actually sent.
  const subscribe = socket.ofType(BpFrameType.SUBSCRIBE)[0]!;
  const ens = mgr.ensure(subscribe.sessionId, { rows: subscribe.rows, cols: subscribe.cols });
  expect(ens.ok).toBe(true);
  const generation = ens.ok ? ens.generation : 0;
  const channelId = mgr.subscribe(subscribe.sessionId, subscribe.surfaceId, subscribe.rows, subscribe.cols);
  expect(channelId).toBeTypeOf('number');
  return { mgr, generation, daemonFrames, rendered, exits };
}

describe('the browser EXIT frame tells the truth about an unprovable ending (desk#70)', () => {
  beforeEach(() => {
    vi.useFakeTimers(); // neutralize the broker client's heartbeat/reconnect timers
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the word unknown, and never a code 0, from observer to terminal line', () => {
    const { mgr, generation, daemonFrames, rendered, exits } = tab();

    const observed = mgr.observeMoorEvent('sess', generation, {
      type: 'exit',
      outcome: { kind: 'unknown' },
      outputEnd: 0n,
      ts: 1.028
    });
    expect(observed).toMatchObject({ ok: true, authority: { kind: 'applied' } });

    // What left the daemon: the tagged outcome and no number of any kind.
    const exitFrames = daemonFrames.filter((frame) => frame.type === BpFrameType.EXIT);
    expect(exitFrames).toHaveLength(1);
    expect(exitFrames[0]).toEqual({ type: BpFrameType.EXIT, channelId: expect.any(Number), outcome: { kind: 'unknown' } });
    expect(exitFrames[0]).not.toHaveProperty('code');
    expect(exitFrames[0]).not.toHaveProperty('signal');

    // What the browser client handed the surface, after a real encode/decode.
    expect(exits).toEqual([{ kind: 'unknown' }]);

    // What the terminal shows.
    expect(rendered).toEqual(['[session ended: unknown]']);
    expect(rendered[0]).toContain('unknown');
    expect(rendered[0]).not.toContain('code 0');
    expect(rendered[0]).not.toMatch(/[0-9]/);
  });

  it('renders a signalled ending as signalled with the signal number, not as code 143', () => {
    const { mgr, generation, daemonFrames, rendered, exits } = tab();

    const observed = mgr.observeMoorEvent('sess', generation, {
      type: 'exit',
      outcome: { kind: 'signalled', signal: 15 },
      outputEnd: 0n,
      ts: 1.028
    });
    expect(observed).toMatchObject({ ok: true, authority: { kind: 'applied' } });

    const exitFrames = daemonFrames.filter((frame) => frame.type === BpFrameType.EXIT);
    expect(exitFrames).toHaveLength(1);
    expect(exitFrames[0]).toMatchObject({ outcome: { kind: 'signalled', signal: 15 } });
    expect(exits).toEqual([{ kind: 'signalled', signal: 15 }]);
    expect(rendered).toEqual(['[session signalled 15 (SIGTERM)]']);
    expect(rendered[0]).not.toContain('code 143');
    expect(rendered[0]).not.toContain('exited');
  });

  it('renders a plain exit as exited with its code', () => {
    const { mgr, generation, rendered } = tab();
    const observed = mgr.observeMoorEvent('sess', generation, {
      type: 'exit',
      outcome: { kind: 'exited', code: 7 },
      outputEnd: 0n,
      ts: 1.028
    });
    expect(observed).toMatchObject({ ok: true, authority: { kind: 'applied' } });
    expect(rendered).toEqual(['[session exited 7]']);
  });

  it('leaves the durable record exactly as honest as it already was', () => {
    // Guard against "fixing" the layer that was never broken: the persisted
    // exit still carries the tagged outcome, `unknown` included, and the
    // numeric view is null for an unprovable ending and 128+signal for a
    // signalled one — unchanged by the browser-edge work.
    const unknown = tab();
    expect(
      unknown.mgr.observeMoorEvent('sess', unknown.generation, {
        type: 'exit',
        outcome: { kind: 'unknown' },
        outputEnd: 0n,
        ts: 1.028
      })
    ).toMatchObject({ ok: true, authority: { kind: 'applied' } });
    expect(unknown.mgr.stateSnapshot('sess')?.exit).toMatchObject({
      origin: 'observed',
      code: null,
      signal: null,
      outcome: { kind: 'unknown' }
    });

    const signalled = tab();
    expect(
      signalled.mgr.observeMoorEvent('sess', signalled.generation, {
        type: 'exit',
        outcome: { kind: 'signalled', signal: 15 },
        outputEnd: 0n,
        ts: 1.028
      })
    ).toMatchObject({ ok: true, authority: { kind: 'applied' } });
    expect(signalled.mgr.stateSnapshot('sess')?.exit).toMatchObject({
      origin: 'observed',
      code: 143,
      signal: '15',
      outcome: { kind: 'signalled', signal: 15 }
    });
  });

  it('TerminalSurface writes exactly the line describeSessionExit produces', () => {
    // The surface is a React/xterm component with no unit harness in this
    // repo (see terminal-clipboard.test.ts for the same pinning technique), so
    // the wiring is pinned at the source: the onExit handler receives the
    // tagged outcome and prints describeSessionExit of it — no code, no signal
    // arithmetic of its own.
    const source = readFileSync(new URL('../src/web/TerminalSurface.tsx', import.meta.url), 'utf8');
    expect(source).toContain('onExit: (outcome) => {');
    expect(source).toContain('${describeSessionExit(outcome)}');
    expect(source).not.toContain('session exited ${');
    expect(source).not.toContain('`code ${');
  });
});

describe('describeSessionExit — the terminal line for each moor ending', () => {
  it('states each ending in its own words', () => {
    expect(describeSessionExit({ kind: 'exited', code: 0 })).toBe('[session exited 0]');
    expect(describeSessionExit({ kind: 'exited', code: 143 })).toBe('[session exited 143]');
    expect(describeSessionExit({ kind: 'signalled', signal: 9 })).toBe('[session signalled 9 (SIGKILL)]');
    expect(describeSessionExit({ kind: 'terminated', code: 0, method: 'graceful' })).toBe(
      '[session terminated (graceful) code 0]'
    );
    expect(describeSessionExit({ kind: 'terminated', code: 1, method: 'forced' })).toBe(
      '[session terminated (forced) code 1]'
    );
    expect(describeSessionExit({ kind: 'unknown' })).toBe('[session ended: unknown]');
  });

  it('names only signals whose number is the same on every POSIX platform, else the number alone', () => {
    // 1 HUP, 2 INT, 3 QUIT, 6 ABRT, 9 KILL, 15 TERM are fixed everywhere; 10 is
    // SIGUSR1 on Linux but SIGBUS on macOS/BSD, and the browser cannot know
    // which OS the holder ran on — so a name there would be a guess.
    expect(describeSessionExit({ kind: 'signalled', signal: 1 })).toBe('[session signalled 1 (SIGHUP)]');
    expect(describeSessionExit({ kind: 'signalled', signal: 2 })).toBe('[session signalled 2 (SIGINT)]');
    expect(describeSessionExit({ kind: 'signalled', signal: 10 })).toBe('[session signalled 10]');
    expect(describeSessionExit({ kind: 'signalled', signal: 64 })).toBe('[session signalled 64]');
  });
});
