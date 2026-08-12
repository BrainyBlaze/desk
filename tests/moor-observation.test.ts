// Moor event-observation state machine (the live observeMoorEvent surface):
// ready/state/link/exit projection into the terminal observation and the
// authority, generation fencing, post-exit rejection, and the cutover-parity
// EXIT push to subscribed browser surfaces. Salvaged from the removed ATV3
// sessionManager.integration suite (#2b-4 slice 3) and rehosted transport-free
// on the moor-era manager (OB-18: the first supervised generation is 2).

import { describe, expect, it } from 'vitest';
import { SessionManager } from '../src/server/runtime/sessionManager.js';
import { GenerationLedger, InMemoryGenerationLedger } from '../src/shared/controlPlane/index.js';
import { WorkerSupervisor, DEFAULT_SUPERVISOR_CONFIG } from '../src/shared/runtime/workerSupervisor.js';
import { BpFrameType, type BpFrame } from '../src/shared/browserProtocol/index.js';
import type { EmulatorEvent, EmulatorPort } from '../src/shared/runtime/emulatorPort.js';

class FakeEmu implements EmulatorPort {
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
  onEvent(_cb: (e: EmulatorEvent) => void): () => void {
    return () => {};
  }
  dispose(): void {}
}

const agentSubject = {
  kind: 'agent',
  provider: 'codex',
  mode: 'terminal',
  producer: 'codex-hooks'
} as const;

function makeManager() {
  const browserOut: { sessionId: string; channelId: number; frame: BpFrame }[] = [];
  const mgr = new SessionManager({
    ledger: new GenerationLedger(new InMemoryGenerationLedger()),
    supervisor: new WorkerSupervisor(DEFAULT_SUPERVISOR_CONFIG),
    emulatorFactory: { create: () => new FakeEmu() },
    now: () => 1000,
    sendBrowser: (sessionId, channelId, frame) => browserOut.push({ sessionId, channelId, frame })
  });
  return { mgr, browserOut };
}

describe('moor event observation (state machine + browser EXIT parity)', () => {
  it('binds state, readiness, links, and exit to one session generation', () => {
    const { mgr, browserOut } = makeManager();
    const ensured = mgr.ensure('web-1', { rows: 1, cols: 1 }, agentSubject);
    expect(ensured).toMatchObject({ ok: true, generation: 2 });
    const channelId = mgr.subscribe('web-1', 'main', 1, 1);
    expect(channelId).toBeDefined();

    expect(mgr.observeMoorEvent('web-1', 2, { ts: 1.1, type: 'ready' })).toMatchObject({
      ok: true
    });
    expect(
      mgr.observeMoorEvent('web-1', 2, {
        ts: 1.2,
        type: 'state',
        state: 'busy',
        title: '⠋ desk'
      })
    ).toMatchObject({ ok: true });
    expect(
      mgr.observeMoorEvent('web-1', 2, {
        ts: 1.3,
        type: 'link',
        uri: 'https://example.test/run'
      })
    ).toMatchObject({ ok: true });

    expect(mgr.terminalObservation('web-1')).toEqual({
      sessionId: 'web-1',
      generation: 2,
      ready: true,
      readyAt: 1_100,
      activity: 'working',
      activityAt: 1_200,
      title: '⠋ desk',
      link: { uri: 'https://example.test/run', at: 1_300 },
      exit: null,
      updatedAt: 1_300
    });
    expect(mgr.stateSnapshot('web-1')).toMatchObject({
      health: { status: 'degraded', reason: 'title-fallback' },
      subject: {
        kind: 'agent',
        activity: 'working',
        evidence: { source: 'terminal-title', observedAt: 1_200 }
      }
    });

    expect(
      mgr.observeMoorEvent('web-1', 2, { ts: 1.4, type: 'exit', code: 7 })
    ).toMatchObject({ ok: true });
    expect(mgr.terminalObservation('web-1')).toMatchObject({
      exit: { code: 7, at: 1_400 },
      updatedAt: 1_400
    });
    expect(mgr.stateSnapshot('web-1')).toMatchObject({
      lifecycle: 'exited',
      exit: { code: 7, signal: null, at: 1_400 }
    });

    // Cutover parity: the APPLIED exit also pushed an explicit EXIT frame to
    // the subscribed surface — the browser is told, not left to poll.
    const exits = browserOut.filter((entry) => entry.frame.type === BpFrameType.EXIT);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      sessionId: 'web-1',
      channelId,
      frame: { type: BpFrameType.EXIT, code: 7, signal: 0 }
    });
  });

  it('rejects stale-generation and post-exit events without mutating observations', () => {
    const { mgr, browserOut } = makeManager();
    mgr.ensure('web-1', { rows: 1, cols: 1 }, agentSubject);
    const initial = mgr.terminalObservation('web-1');

    expect(
      mgr.observeMoorEvent('web-1', 3, {
        ts: 1.1,
        type: 'state',
        state: 'busy',
        title: 'stale'
      })
    ).toEqual({ ok: false, reason: 'generation-mismatch' });
    expect(mgr.terminalObservation('web-1')).toEqual(initial);

    mgr.observeMoorEvent('web-1', 2, { ts: 1.2, type: 'exit', code: 0 });
    const exited = mgr.terminalObservation('web-1');
    expect(
      mgr.observeMoorEvent('web-1', 2, {
        ts: 1.3,
        type: 'state',
        state: 'idle',
        title: 'late'
      })
    ).toEqual({ ok: false, reason: 'lifecycle-exited' });
    expect(mgr.terminalObservation('web-1')).toEqual(exited);

    // A REPLAYED duplicate exit is an authority noop and must never
    // re-announce EXIT to the browser.
    mgr.subscribe('web-1', 'main', 1, 1);
    browserOut.length = 0;
    mgr.observeMoorEvent('web-1', 2, { ts: 1.4, type: 'exit', code: 0 });
    expect(browserOut.filter((e) => e.frame.type === BpFrameType.EXIT)).toHaveLength(0);
  });
});
