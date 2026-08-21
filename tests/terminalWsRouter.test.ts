// Terminal WS router (spec §7.4). Verifies daemon-global channelId allocation,
// per-WS channel ownership (INPUT only from the owning connection), the four
// @codex scenarios: two sessions on one WS, one session on two WS, unknown/stale
// channel rejection, and close cleanup.

import { describe, expect, it, beforeEach } from 'vitest';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG, type EmulatorPort, type EmulatorEvent } from '../src/shared/runtime/index.js';
import { TerminalWsRouter, type WsConn } from '../src/server/runtime/terminalWsRouter.js';
import type { SessionMasterLink } from '../src/server/runtime/sessionManager.js';
import { BpError, BpFrameType, decodeBpFrame, encodeBpFrame, type BpFrame } from '../src/shared/browserProtocol/index.js';
import { describeBpError } from '../src/web/terminalBpError.js';

const createdEmus: FakeEmu[] = [];
class FakeEmu implements EmulatorPort {
  resizes: { rows: number; cols: number }[] = [];
  constructor() {
    createdEmus.push(this);
  }
  write(): void {}
  resize(rows: number, cols: number): void {
    this.resizes.push({ rows, cols });
  }
  readTailText(): string[] {
    return [];
  }
  serialize(): string {
    return 'SCREEN';
  }
  cursor(): { row: number; col: number } {
    return { row: 0, col: 0 };
  }
  onEvent(_cb: (e: EmulatorEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
}

class FakeWs implements WsConn {
  frames: BpFrame[] = [];
  send(data: Uint8Array): void {
    this.frames.push(decodeBpFrame(data));
  }
  acks(): number[] {
    return this.frames.filter((f) => f.type === BpFrameType.SUBSCRIBE_ACK).map((f) => (f as Extract<BpFrame, { type: BpFrameType.SUBSCRIBE_ACK }>).channelId);
  }
  errors(): number[] {
    return this.frames.filter((f) => f.type === BpFrameType.ERROR).map((f) => (f as Extract<BpFrame, { type: BpFrameType.ERROR }>).code);
  }
}

const subscribe = (sessionId: string, surfaceId = 'main') => encodeBpFrame({ type: BpFrameType.SUBSCRIBE, sessionId, surfaceId, rows: 40, cols: 120 });
const unsubscribe = (channelId: number) => encodeBpFrame({ type: BpFrameType.UNSUBSCRIBE, channelId });
const input = (channelId: number, text: string) => encodeBpFrame({ type: BpFrameType.INPUT, channelId, binary: false, bytes: new TextEncoder().encode(text) });
const resize = (channelId: number, rows: number, cols: number) => encodeBpFrame({ type: BpFrameType.RESIZE, channelId, rows, cols });
const queryReply = (channelId: number) => encodeBpFrame({ type: BpFrameType.QUERY_REPLY, channelId, queryOffset: 0n, leaseEpoch: 0, bytes: Uint8Array.of(0x1b) });

describe('terminal WS router (§7.4)', () => {
  let router: TerminalWsRouter;
  beforeEach(() => {
    createdEmus.length = 0; // emulators are created at ensure(): [0]=s1, [1]=s2
    router = new TerminalWsRouter({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: { create: () => new FakeEmu() },
      now: () => 1000,
      // This router-only suite has no durable Moor store; acknowledge the
      // production-required recovery gate explicitly.
      onLateMoorAdoption: async () => true
    });
    router.sessions.ensure('s1', { rows: 40, cols: 120 });
    router.sessions.ensure('s2', { rows: 40, cols: 120 });
  });

  it('SUBSCRIBE routes one live-baseline ACK back to the subscribing WS', () => {
    const ws = new FakeWs();
    router.onWsFrame(ws, subscribe('s1'));
    expect(ws.frames).toEqual([
      expect.objectContaining({ type: BpFrameType.SUBSCRIBE_ACK, channelId: 1, offset: 0n })
    ]);
    expect(ws.acks()).toEqual([1]); // first global channelId
  });

  it('two sessions on one WS get distinct global channelIds', () => {
    const ws = new FakeWs();
    router.onWsFrame(ws, subscribe('s1'));
    router.onWsFrame(ws, subscribe('s2'));
    expect(ws.acks()).toEqual([1, 2]); // distinct — no per-session collision
  });

  it('the same session on two WS gets distinct channelIds, each owned by its WS', () => {
    const a = new FakeWs();
    const b = new FakeWs();
    router.onWsFrame(a, subscribe('s1'));
    router.onWsFrame(b, subscribe('s1'));
    expect(a.acks()).toEqual([1]);
    expect(b.acks()).toEqual([2]);
    // B may not drive A's channel 1 → BAD_CHANNEL. A owns it, but this unit
    // has no attached controller link, so the honest result is INPUT_UNAVAILABLE.
    router.onWsFrame(b, input(1, 'x'));
    expect(b.errors()).toContain(BpError.BAD_CHANNEL);
    a.frames.length = 0;
    router.onWsFrame(a, input(1, 'x'));
    expect(a.errors()).toEqual([BpError.INPUT_UNAVAILABLE]);
  });

  it('INPUT on an unknown/stale channel is rejected', () => {
    const ws = new FakeWs();
    router.onWsFrame(ws, subscribe('s1')); // owns channel 1
    router.onWsFrame(ws, input(999, 'x')); // never allocated
    expect(ws.errors()).toContain(BpError.BAD_CHANNEL);
  });

  it('reports truthful browser text when a valid channel has no controller link', () => {
    const ws = new FakeWs();
    router.onWsFrame(ws, subscribe('s1'));
    router.onWsFrame(ws, input(1, 'not-silently-dropped'));
    expect(ws.errors()).toContain(BpError.INPUT_UNAVAILABLE);
    expect(ws.errors()).not.toContain(BpError.BAD_CHANNEL);
    expect(describeBpError(ws.errors().at(-1)!)).toBe(
      'terminal input is unavailable while the session reconnects or exits'
    );
  });

  it('rejects INPUT after hide detaches the channel without forwarding master bytes', () => {
    const ws = new FakeWs();
    router.onWsFrame(ws, subscribe('s1'));
    const channelId = ws.acks()[0]!;
    const forwarded: Uint8Array[] = [];
    const link: SessionMasterLink = {
      sendInput: (bytes) => {
        forwarded.push(bytes.slice());
        return true;
      },
      cancelQueuedInput: () => {},
      sealInput: () => {},
      sendResize: () => {},
      close: () => {}
    };
    (router.sessions as unknown as { masters: Map<string, SessionMasterLink> }).masters.set(
      's1',
      link
    );
    ws.frames.length = 0;

    router.onWsFrame(ws, unsubscribe(channelId));
    router.onWsFrame(ws, input(channelId, 'must-not-reach-master'));

    expect(forwarded).toEqual([]);
    expect(ws.errors()).toEqual([BpError.BAD_CHANNEL]);
  });

  it('WS close unsubscribes its channels; later INPUT on them is rejected', () => {
    const a = new FakeWs();
    router.onWsFrame(a, subscribe('s1')); // channel 1
    router.onWsFrame(a, subscribe('s2')); // channel 2
    router.onWsClose(a);
    // a new WS cannot drive the now-stale channels
    const b = new FakeWs();
    router.onWsFrame(b, input(1, 'x'));
    router.onWsFrame(b, input(2, 'x'));
    expect(b.errors()).toEqual([BpError.BAD_CHANNEL, BpError.BAD_CHANNEL]);
  });

  it('SUBSCRIBE to a non-existent session returns an error', () => {
    const ws = new FakeWs();
    router.onWsFrame(ws, subscribe('ghost'));
    expect(ws.errors()).toContain(BpError.BAD_CHANNEL);
  });

  it('RESIZE from the owner reaches the session emulator', () => {
    const ws = new FakeWs();
    router.onWsFrame(ws, subscribe('s1')); // channel 1
    const emu = createdEmus[0]; // s1's emulator (created first in beforeEach)
    router.onWsFrame(ws, resize(1, 24, 80));
    expect(emu.resizes).toContainEqual({ rows: 24, cols: 80 });
    expect(ws.errors()).toHaveLength(0); // owner → routed, no rejection
  });

  it('RESIZE on a channel the WS does not own is rejected (§7.4)', () => {
    const a = new FakeWs();
    const b = new FakeWs();
    router.onWsFrame(a, subscribe('s1')); // a owns channel 1
    const emu = createdEmus[0]; // s1's emulator
    router.onWsFrame(b, resize(1, 24, 80)); // b is not the owner
    expect(b.errors()).toContain(BpError.BAD_CHANNEL);
    expect(emu.resizes).not.toContainEqual({ rows: 24, cols: 80 }); // never routed
  });

  // ---- desk#68: a closing connection removes its channels in BULK -----------
  // The three tests below assert on the emulator's resize sequence, which is
  // written by the same single writer as the master resize (commandOwnerSize):
  // this unit has no attached master link, so the emulator is the observable.
  const sized = (sessionId: string, surfaceId: string, rows: number, cols: number) =>
    encodeBpFrame({ type: BpFrameType.SUBSCRIBE, sessionId, surfaceId, rows, cols });

  it('desk#68: closing a WS with two channels elects at most once, never through the dying sibling', () => {
    const a = new FakeWs();
    const b = new FakeWs();
    router.onWsFrame(a, sized('s1', 'cell-one', 48, 95)); // channel 1 — owner
    router.onWsFrame(a, sized('s1', 'cell-two', 41, 137)); // channel 2 — observer, same conn
    router.onWsFrame(b, sized('s1', 'cell-other', 30, 90)); // channel 3 — the true survivor
    const emu = createdEmus[0]!;
    const before = emu.resizes.length;

    router.onWsClose(a);

    // Exactly one command: the survivor's. Sequential removal would first
    // promote dying channel 2 and command 41x137 through it.
    expect(emu.resizes.slice(before)).toEqual([{ rows: 30, cols: 90 }]);
    expect(emu.resizes).toEqual([
      { rows: 48, cols: 95 },
      { rows: 30, cols: 90 }
    ]);
  });

  it('desk#68: a WS holding ALL channels closes — zero commands, size left alone', () => {
    const a = new FakeWs();
    router.onWsFrame(a, sized('s1', 'cell-one', 48, 95)); // owner
    router.onWsFrame(a, sized('s1', 'cell-two', 41, 137)); // observer, same conn
    const emu = createdEmus[0]!;
    const before = emu.resizes.length;

    router.onWsClose(a);

    expect(emu.resizes.slice(before)).toEqual([]);
    expect(emu.resizes).toEqual([{ rows: 48, cols: 95 }]);
  });

  it('desk#68: a close spanning two sessions elects independently per session', () => {
    const a = new FakeWs();
    const b = new FakeWs();
    router.onWsFrame(a, sized('s1', 'one', 48, 95)); // s1 owner
    router.onWsFrame(a, sized('s2', 'two', 41, 137)); // s2 owner
    router.onWsFrame(b, sized('s1', 'other', 30, 90)); // s1 survivor

    router.onWsClose(a);

    expect(createdEmus[0]!.resizes).toEqual([
      { rows: 48, cols: 95 },
      { rows: 30, cols: 90 }
    ]);
    // s2 loses its only surface: no election, size left alone.
    expect(createdEmus[1]!.resizes).toEqual([{ rows: 41, cols: 137 }]);
  });

  it('QUERY_REPLY from the owner is dropped fail-closed (no error, no crash); a non-owner is rejected', () => {
    const a = new FakeWs();
    const b = new FakeWs();
    router.onWsFrame(a, subscribe('s1')); // a owns channel 1
    router.onWsFrame(a, queryReply(1)); // uncorrelated → §7.7 fail-closed drop
    expect(a.errors()).toHaveLength(0); // dropped silently, not an error
    router.onWsFrame(b, queryReply(1)); // non-owner
    expect(b.errors()).toContain(BpError.BAD_CHANNEL);
  });
});
