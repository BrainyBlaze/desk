import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../src/core/types';
import { createTerminalBrokerSnapshot, TerminalBroker, type BrokerPty, type BrokerTransport } from '../src/server/terminalBroker';
import { addAgentSignalListener, attentionTracker } from '../src/server/attention';

class FakePty implements BrokerPty {
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private dataHandlers: Array<(chunk: string) => void> = [];
  private exitHandlers: Array<(exit: { exitCode: number | null }) => void> = [];

  onData(handler: (chunk: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (exit: { exitCode: number | null }) => void): void {
    this.exitHandlers.push(handler);
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  emit(chunk: string): void {
    for (const handler of this.dataHandlers) {
      handler(chunk);
    }
  }

  exit(exitCode: number | null): void {
    for (const handler of this.exitHandlers) {
      handler({ exitCode });
    }
  }
}

class FakeTransport implements BrokerTransport {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

const sessions: SessionSpec[] = [
  { name: 'A', tmuxSession: 'agentdesk-a', cwd: '/tmp', command: 'bash', groupId: 'g', groupLabel: 'g' },
  { name: 'B', tmuxSession: 'agentdesk-b', cwd: '/tmp', command: 'bash', groupId: 'g', groupLabel: 'g' }
];

function createBroker(
  options: {
    now?: () => number;
    maxWarmPtys?: number;
    idleTtlMs?: number;
    backpressureBytes?: number;
    resizeTerminal?: (session: SessionSpec, cols: number, rows: number) => { ok: true; skipped?: boolean } | { ok: false; error: string };
  } = {}
) {
  const ptys = new Map<string, FakePty>();
  const broker = new TerminalBroker({
    sessions,
    runningSessions: () => new Set(sessions.map((session) => session.tmuxSession)),
    spawnPty: (session) => {
      const pty = new FakePty();
      ptys.set(session.tmuxSession, pty);
      return pty;
    },
    captureSnapshot: (session, ring) => `\x1b[2J\x1b[3J\x1b[Hsnapshot:${session.tmuxSession}:${ring}`,
    ringBytes: 100,
    ...options
  });
  return { broker, ptys };
}

describe('TerminalBroker', () => {
  it('builds self-contained capture snapshots and falls back to the output ring', () => {
    expect(
      createTerminalBrokerSnapshot(
        sessions[0],
        'ring-data',
        () => ({ ok: true, lines: ['screen-a', 'screen-b'] })
      )
    ).toBe('\x1b[2J\x1b[3J\x1b[Hscreen-a\r\nscreen-b');

    expect(
      createTerminalBrokerSnapshot(
        sessions[0],
        'ring-data',
        () => ({ ok: false, error: 'capture failed' })
      )
    ).toBe('\x1b[2J\x1b[3J\x1b[Hring-data');
  });

  it('delivers output only to visible subscriptions and replays hidden output on reveal', () => {
    const { broker, ptys } = createBroker();
    const client = new FakeTransport();
    broker.addClient(client);

    broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-a', visible: true });
    broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-b', surfaceId: 'cell-b', visible: false });

    ptys.get('agentdesk-a')?.emit('visible-a');
    ptys.get('agentdesk-b')?.emit('hidden-b');

    expect(client.sent).toContainEqual({ type: 'output', session: 'agentdesk-a', data: 'visible-a' });
    expect(client.sent).not.toContainEqual({ type: 'output', session: 'agentdesk-b', data: 'hidden-b' });

    broker.handleFrame(client, { type: 'visibility', session: 'agentdesk-b', surfaceId: 'cell-b', visible: true });

    expect(client.sent).toContainEqual({
      type: 'snapshot',
      session: 'agentdesk-b',
      surfaceId: 'cell-b',
      data: '\x1b[2J\x1b[3J\x1b[Hsnapshot:agentdesk-b:hidden-b'
    });
  });

  it('keeps xterm in control by stripping tmux mouse controls from broker output', () => {
    const { broker, ptys } = createBroker();
    const client = new FakeTransport();
    broker.addClient(client);

    broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-a', visible: true });
    ptys.get('agentdesk-a')?.emit('a\x1b[?1000h\x1b[?1006hb');

    expect(client.sent).toContainEqual({ type: 'output', session: 'agentdesk-a', data: 'ab' });
  });

  it('extracts agent notifications from broker output and fans out channel signals', () => {
    attentionTracker.clearEvents();
    const signals: Array<{ session: string; kind: string }> = [];
    const unsubscribe = addAgentSignalListener((session, kind) => signals.push({ session, kind }));
    try {
      const { broker, ptys } = createBroker();
      const client = new FakeTransport();
      broker.addClient(client);
      broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-a', visible: true });

      ptys.get('agentdesk-a')?.emit('\x1b]9;permission prompt\x07ready');

      expect(signals).toEqual([{ session: 'agentdesk-a', kind: 'approval-requested' }]);
      expect(attentionTracker.snapshot()).toHaveProperty('agentdesk-a');
      expect(attentionTracker.listEvents()[0]).toMatchObject({
        tmuxSession: 'agentdesk-a',
        kind: 'approval-requested',
        message: 'permission prompt',
        read: false
      });
      expect(client.sent).toContainEqual({ type: 'output', session: 'agentdesk-a', data: '\x1b]9;permission prompt\x07ready' });
    } finally {
      unsubscribe();
      attentionTracker.clearEvents();
    }
  });

  it('writes input to the subscribed PTY', () => {
    const { broker, ptys } = createBroker();
    const client = new FakeTransport();
    broker.addClient(client);
    broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-a', visible: true });

    broker.handleFrame(client, { type: 'input', session: 'agentdesk-a', surfaceId: 'cell-a', data: 'pwd\r' });

    expect(ptys.get('agentdesk-a')?.writes).toEqual(['pwd\r']);
  });

  it('routes resize through the guarded resize dependency before resizing the PTY', () => {
    const resizeCalls: Array<{ session: string; cols: number; rows: number }> = [];
    const { broker, ptys } = createBroker({
      resizeTerminal: (session, cols, rows) => {
        resizeCalls.push({ session: session.tmuxSession, cols, rows });
        return { ok: true };
      }
    });
    const client = new FakeTransport();
    broker.addClient(client);
    broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-a', visible: true });

    broker.handleFrame(client, { type: 'resize', session: 'agentdesk-a', surfaceId: 'cell-a', cols: 120, rows: 40 });

    expect(resizeCalls).toEqual([{ session: 'agentdesk-a', cols: 120, rows: 40 }]);
    expect(ptys.get('agentdesk-a')?.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('does not resize the PTY when the guarded resize dependency skips', () => {
    const { broker, ptys } = createBroker({
      resizeTerminal: () => ({ ok: true, skipped: true })
    });
    const client = new FakeTransport();
    broker.addClient(client);
    broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-a', visible: true });

    broker.handleFrame(client, { type: 'resize', session: 'agentdesk-a', surfaceId: 'cell-a', cols: 120, rows: 40 });

    expect(ptys.get('agentdesk-a')?.resizes).toEqual([]);
  });

  it('aggregates visibility across multiple surfaces for the same session', () => {
    const { broker, ptys } = createBroker();
    const client = new FakeTransport();
    broker.addClient(client);
    broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-visible', visible: true });
    broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-hidden', visible: false });

    ptys.get('agentdesk-a')?.emit('first');
    expect(client.sent.filter((frame) => JSON.stringify(frame).includes('first'))).toEqual([
      { type: 'output', session: 'agentdesk-a', data: 'first' }
    ]);

    broker.handleFrame(client, { type: 'visibility', session: 'agentdesk-a', surfaceId: 'cell-visible', visible: false });
    ptys.get('agentdesk-a')?.emit('second');

    expect(client.sent.filter((frame) => JSON.stringify(frame).includes('second'))).toEqual([]);
  });

  it('drops output for backpressured clients and records metrics', () => {
    const { broker, ptys } = createBroker({ backpressureBytes: 10 });
    const client = new FakeTransport();
    client.bufferedAmount = 11;
    broker.addClient(client);
    broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-a', visible: true });

    ptys.get('agentdesk-a')?.emit('too-much');

    expect(client.sent).not.toContainEqual({ type: 'output', session: 'agentdesk-a', data: 'too-much' });
    expect(broker.metrics().droppedOutputFrames).toBe(1);
  });

  it('retains idle PTYs until the idle TTL expires', () => {
    let now = 1000;
    const { broker, ptys } = createBroker({ now: () => now, idleTtlMs: 5000 });
    const client = new FakeTransport();
    broker.addClient(client);
    broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-a', visible: true });
    broker.handleFrame(client, { type: 'unsubscribe', session: 'agentdesk-a', surfaceId: 'cell-a' });

    now = 5999;
    broker.sweepIdle();
    expect(ptys.get('agentdesk-a')?.killed).toBe(false);

    now = 6000;
    broker.sweepIdle();
    expect(ptys.get('agentdesk-a')?.killed).toBe(true);
  });

  it('evicts the least recently idle PTY when the warm limit is exceeded', () => {
    let now = 1000;
    const { broker, ptys } = createBroker({ now: () => now, maxWarmPtys: 1, idleTtlMs: 60_000 });
    const client = new FakeTransport();
    broker.addClient(client);

    broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-a', visible: false });
    broker.handleFrame(client, { type: 'unsubscribe', session: 'agentdesk-a', surfaceId: 'cell-a' });
    now = 2000;
    broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-b', surfaceId: 'cell-b', visible: false });
    broker.handleFrame(client, { type: 'unsubscribe', session: 'agentdesk-b', surfaceId: 'cell-b' });

    expect(ptys.get('agentdesk-a')?.killed).toBe(true);
    expect(ptys.get('agentdesk-b')?.killed).toBe(false);
  });

  it('removes clients after a subscribed session is deleted from the session catalog', () => {
    let liveSessions = [...sessions];
    const broker = new TerminalBroker({
      sessions: () => liveSessions,
      runningSessions: () => new Set(liveSessions.map((session) => session.tmuxSession)),
      spawnPty: () => new FakePty(),
      captureSnapshot: () => '\x1b[2J\x1b[3J\x1b[Hscreen',
      ringBytes: 100
    });
    const client = new FakeTransport();
    broker.addClient(client);
    broker.handleFrame(client, { type: 'subscribe', session: 'agentdesk-a', surfaceId: 'cell-a', visible: true });

    liveSessions = liveSessions.filter((session) => session.tmuxSession !== 'agentdesk-a');

    expect(() => broker.removeClient(client)).not.toThrow();
    expect(broker.metrics().activeClients).toBe(0);
    expect(broker.metrics().visibleSubscriptions).toBe(0);
  });
});
