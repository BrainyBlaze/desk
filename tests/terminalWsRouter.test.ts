// Terminal WS router (spec §7.4). Verifies daemon-global channelId allocation,
// per-WS channel ownership (INPUT only from the owning connection), the four
// @codex scenarios: two sessions on one WS, one session on two WS, unknown/stale
// channel rejection, and close cleanup.

import { describe, expect, it, beforeEach } from 'vitest';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG, type EmulatorPort, type EmulatorEvent } from '../src/shared/runtime/index.js';
import { TerminalWsRouter, type WsConn } from '../src/server/runtime/terminalWsRouter.js';
import { BpError, BpFrameType, decodeBpFrame, encodeBpFrame, type BpFrame } from '../src/shared/browserProtocol/index.js';

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
const input = (channelId: number, text: string) => encodeBpFrame({ type: BpFrameType.INPUT, channelId, binary: false, bytes: new TextEncoder().encode(text) });
const resize = (channelId: number, rows: number, cols: number) => encodeBpFrame({ type: BpFrameType.RESIZE, channelId, rows, cols });
const visibility = (channelId: number, visible: boolean) => encodeBpFrame({ type: BpFrameType.VISIBILITY, channelId, visible });
const queryReply = (channelId: number) => encodeBpFrame({ type: BpFrameType.QUERY_REPLY, channelId, queryOffset: 0n, leaseEpoch: 0, bytes: Uint8Array.of(0x1b) });

describe('terminal WS router (§7.4)', () => {
  let router: TerminalWsRouter;
  beforeEach(() => {
    createdEmus.length = 0; // emulators are created at ensure(): [0]=s1, [1]=s2
    router = new TerminalWsRouter({
      ledger: new GenerationLedger(new InMemoryGenerationLedger()),
      supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
      emulatorFactory: { create: () => new FakeEmu() },
      now: () => 1000
    });
    router.sessions.ensure('s1', { rows: 40, cols: 120 });
    router.sessions.ensure('s2', { rows: 40, cols: 120 });
  });

  it('SUBSCRIBE routes ACK + SNAPSHOT back to the subscribing WS', () => {
    const ws = new FakeWs();
    router.onWsFrame(ws, subscribe('s1'));
    expect(ws.frames.map((f) => f.type)).toEqual([BpFrameType.SUBSCRIBE_ACK, BpFrameType.SNAPSHOT]);
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
    // B may not drive A's channel 1 → rejected; A may drive its own → accepted.
    router.onWsFrame(b, input(1, 'x'));
    expect(b.errors()).toContain(BpError.BAD_CHANNEL);
    a.frames.length = 0;
    router.onWsFrame(a, input(1, 'x'));
    expect(a.errors()).toHaveLength(0); // owner accepted
  });

  it('INPUT on an unknown/stale channel is rejected', () => {
    const ws = new FakeWs();
    router.onWsFrame(ws, subscribe('s1')); // owns channel 1
    router.onWsFrame(ws, input(999, 'x')); // never allocated
    expect(ws.errors()).toContain(BpError.BAD_CHANNEL);
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

  it('VISIBILITY from the owner is accepted; from a non-owner is rejected', () => {
    const a = new FakeWs();
    const b = new FakeWs();
    router.onWsFrame(a, subscribe('s1')); // a owns channel 1
    router.onWsFrame(a, visibility(1, false));
    expect(a.errors()).toHaveLength(0); // owner → accepted
    router.onWsFrame(b, visibility(1, false)); // non-owner
    expect(b.errors()).toContain(BpError.BAD_CHANNEL);
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
