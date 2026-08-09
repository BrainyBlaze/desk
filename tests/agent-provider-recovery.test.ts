import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync
} from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_STATE_SCHEMA_VERSION,
  parseSessionStateSnapshot
} from '../src/shared/controlPlane/index.js';
import { FrameReassembler, encodeFrame } from '../src/shared/atchWire/codec.js';
import { FrameType } from '../src/shared/atchWire/frames.js';
import { encodeBody, type Body } from '../src/shared/atchWire/messages.js';
import { prepareAtchEventSink } from '../src/server/runtime/atchEvents.js';
import {
  createTerminalDaemon,
  type TerminalDaemon
} from '../src/server/runtime/terminalDaemon.js';

type UpgradeListener = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => void;

const PROVIDER_SESSION_ID = 'ses_aaaaaaaaaaaaaaaaaaaa';

class FakeUpgradeServer {
  listeners: UpgradeListener[] = [];

  on(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners.push(listener);
  }

  off(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }
}

const ATTACH_ACK: Body = {
  generation: 1,
  retained_start_offset: 0n,
  retained_start_record_seq: 0n,
  retained_end_offset: 0n,
  retained_end_record_seq: 0n,
  controller_ack_offset: 0n,
  controller_ack_record_seq: 0n,
  has_checkpoint: 0,
  checkpoint_set_id: 0n,
  checkpoint_offset: 0n,
  checkpoint_record_seq: 0n,
  tail_offset: 0n,
  tail_record_seq: 0n,
  rows: 24,
  cols: 80,
  current_state_exact: 1,
  restart_recoverable: 1,
  main_exact: 1,
  alt_exact: 1,
  active_buffer: 0,
  caps: 0x3f
};

class FakeAtchMaster {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly path: string) {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      const frames = new FrameReassembler();
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('data', (chunk: Buffer) => {
        for (const frame of frames.push(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        )) {
          if (frame.type !== FrameType.ATTACH) continue;
          socket.write(
            encodeFrame({
              type: FrameType.ATTACH_ACK,
              flags: 0,
              generation: 1,
              sequence: 0n,
              aux: 0n,
              payload: encodeBody(FrameType.ATTACH_ACK, ATTACH_ACK)
            })
          );
        }
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.path, resolve));
  }

  disconnect(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async close(): Promise<void> {
    this.disconnect();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe('daemon OpenCode recovery', () => {
  let home: string;
  let daemon: TerminalDaemon | undefined;
  let now: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-agent-recovery-'));
    mkdirSync(join(home, '_engine'), { recursive: true });
    now = 1_000;
  });

  afterEach(() => {
    daemon?.dispose();
    daemon = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  function start(
    fetch: typeof globalThis.fetch,
    options: { activate?: boolean } = {}
  ): TerminalDaemon {
    daemon = createTerminalDaemon({
      homeRoot: home,
      atchBinPath: '/bin/false',
      atchSocketRoot: home,
      httpServer: new FakeUpgradeServer(),
      now: () => now,
      fetch,
      hookInstallationProbe: (provider) => ({
        provider,
        installed: true,
        trust: 'not-applicable'
      })
    });
    const ensured = daemon.router.sessions.ensure(
      'opencode-a',
      { rows: 24, cols: 80 },
      {
        kind: 'agent',
        provider: 'opencode',
        mode: 'terminal',
        producer: 'opencode-terminal'
      }
    );
    expect(ensured).toMatchObject({ ok: true, generation: 1 });
    expect(
      daemon.agentEvent({
        schemaVersion: AGENT_STATE_SCHEMA_VERSION,
        sessionId: 'opencode-a',
        generation: 1,
        provider: 'opencode',
        mode: 'terminal',
        producer: 'opencode-terminal',
        producerInstanceId: 'plugin-a',
        producerSeq: 1,
        eventId: 'plugin-a:push:1',
        invocationId: 'turn-1',
        occurredAt: 900,
        observedAt: 950,
        facts: [{ kind: 'heartbeat' }]
      }, { kind: 'producer-bootstrap' })
    ).toMatchObject({ kind: 'accepted' });
    const registration = {
        schemaVersion: AGENT_STATE_SCHEMA_VERSION,
        sessionId: 'opencode-a',
        generation: 1,
        provider: 'opencode',
        mode: 'terminal',
        producer: 'opencode-terminal',
        producerInstanceId: 'plugin-a',
        producerSeq: 2,
        endpoint: 'http://127.0.0.1:4096/',
        providerSessionId: PROVIDER_SESSION_ID,
        observedAt: 975
      } as const;
    expect(daemon.agentEndpoint(registration)).toMatchObject({
      kind: 'accepted',
      active: false
    });
    expect(daemon.agentStates().snapshots[0]?.subject).toMatchObject({
      kind: 'agent',
      activity: 'unknown'
    });
    if (options.activate !== false) {
      const { observedAt: _observedAt, ...activation } = registration;
      void daemon.activateAgentEndpoint(activation);
    }
    return daemon;
  }

  it('uses only the registered provider session and emits canonical poll evidence', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () =>
        new Response(
        JSON.stringify({
          stale_other_conversation: { type: 'busy' },
          [PROVIDER_SESSION_ID]: { type: 'idle' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const running = start(fetch);
    await vi.waitFor(() => {
      expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'idle'
      });
    });
    now = 1_100;

    await expect(running.reconcileAgentProviders(['opencode-a'])).resolves.toEqual([
      { sessionId: 'opencode-a', kind: 'reconciled' }
    ]);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(
      'http://127.0.0.1:4096/session/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
      kind: 'agent',
      activity: 'idle',
      evidence: {
        producerInstanceId: 'plugin-a',
        transport: 'poll',
        producerSeq: 2
      }
    });
  });

  it('fences reconciliation and provider-scoped events until exact activation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ [PROVIDER_SESSION_ID]: { type: 'idle' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const running = start(fetch, { activate: false });

    await expect(running.reconcileAgentProviders(['opencode-a'])).resolves.toEqual([
      { sessionId: 'opencode-a', kind: 'skipped', reason: 'endpoint-unregistered' }
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      running.agentEvent(
        {
          schemaVersion: AGENT_STATE_SCHEMA_VERSION,
          sessionId: 'opencode-a',
          generation: 1,
          provider: 'opencode',
          mode: 'terminal',
          producer: 'opencode-terminal',
          producerInstanceId: 'plugin-a',
          producerSeq: 3,
          eventId: 'plugin-a:push:3',
          invocationId: 'turn-3',
          occurredAt: 1_000,
          observedAt: 1_000,
          facts: [{ kind: 'activity', activity: 'working' }]
        },
        { kind: 'provider-session', providerSessionId: PROVIDER_SESSION_ID }
      )
    ).toMatchObject({ kind: 'rejected', reason: 'provider-session-unregistered' });

    await expect(
      running.activateAgentEndpoint({
        schemaVersion: AGENT_STATE_SCHEMA_VERSION,
        sessionId: 'opencode-a',
        generation: 1,
        provider: 'opencode',
        mode: 'terminal',
        producer: 'opencode-terminal',
        producerInstanceId: 'plugin-a',
        producerSeq: 2,
        endpoint: 'http://127.0.0.1:4096/',
        providerSessionId: PROVIDER_SESSION_ID
      })
    ).resolves.toMatchObject({ kind: 'activated' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects a push fact from a different provider session without mutating state', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('poll intentionally unavailable'));
    const running = start(fetch);

    expect(
      running.agentEvent(
        {
          schemaVersion: AGENT_STATE_SCHEMA_VERSION,
          sessionId: 'opencode-a',
          generation: 1,
          provider: 'opencode',
          mode: 'terminal',
          producer: 'opencode-terminal',
          producerInstanceId: 'plugin-a',
          producerSeq: 3,
          eventId: 'plugin-a:push:3',
          invocationId: 'turn-3',
          occurredAt: 1_000,
          observedAt: 1_000,
          facts: [{ kind: 'activity', activity: 'working' }]
        },
        { kind: 'provider-session', providerSessionId: PROVIDER_SESSION_ID }
      )
    ).toMatchObject({ kind: 'accepted' });

    expect(
      running.agentEvent(
        {
          schemaVersion: AGENT_STATE_SCHEMA_VERSION,
          sessionId: 'opencode-a',
          generation: 1,
          provider: 'opencode',
          mode: 'terminal',
          producer: 'opencode-terminal',
          producerInstanceId: 'plugin-a',
          producerSeq: 4,
          eventId: 'plugin-a:push:4',
          invocationId: 'turn-4',
          occurredAt: 1_010,
          observedAt: 1_010,
          facts: [{ kind: 'activity', activity: 'idle' }]
        },
        { kind: 'provider-session', providerSessionId: 'provider-b' }
      )
    ).toEqual({
      kind: 'rejected',
      reason: 'provider-session-mismatch'
    });

    expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
      kind: 'agent',
      activity: 'working'
    });
  });

  it('reconciles immediately after accepting a provider endpoint registration', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ [PROVIDER_SESSION_ID]: { type: 'idle' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const running = start(fetch);

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'idle',
        evidence: {
          producerInstanceId: 'plugin-a',
          transport: 'poll',
          producerSeq: 1
        }
      });
    });
  });

  it('does not aggregate another provider session into the selected Desk session', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ stale_other_conversation: { type: 'busy' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const running = start(fetch);

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'unknown'
      });
    });
  });

  it('keeps unknown when the registered provider endpoint is unreachable', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('connection refused'));
    const running = start(fetch);

    await expect(running.reconcileAgentProviders(['opencode-a'])).resolves.toEqual([
      { sessionId: 'opencode-a', kind: 'skipped', reason: 'poll-failed' }
    ]);
    expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
      kind: 'agent',
      activity: 'unknown'
    });
  });

  it('isolates an unexpected recovery failure to its session', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const running = start(fetch);
    const endpointPath = join(home, '_engine', 'agent-endpoints.json');
    rmSync(endpointPath, { force: true });
    mkdirSync(endpointPath);

    await expect(
      running.reconcileAgentProviders(['opencode-a', 'missing'])
    ).resolves.toEqual([
      { sessionId: 'opencode-a', kind: 'skipped', reason: 'recovery-error' },
      { sessionId: 'missing', kind: 'skipped', reason: 'not-opencode-session' }
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
      kind: 'agent',
      activity: 'unknown'
    });
  });
});

describe('daemon atch title recovery', () => {
  let home: string;
  let daemon: TerminalDaemon | undefined;
  let master: FakeAtchMaster | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-atch-recovery-'));
    mkdirSync(join(home, '_engine'), { recursive: true });
  });

  afterEach(async () => {
    await master?.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    daemon?.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps consumed history silent but publishes downtime and resync title changes', async () => {
    const sessionId = 'opencode-a';
    const sockPath = join(home, `${sessionId}.sock`);
    const subject = {
      kind: 'agent' as const,
      provider: 'opencode' as const,
      mode: 'terminal' as const,
      producer: 'opencode-terminal' as const
    };
    const diagnostics: string[] = [];
    const create = () =>
      createTerminalDaemon({
        homeRoot: home,
        atchBinPath: '/bin/false',
        atchSocketRoot: home,
        httpServer: new FakeUpgradeServer(),
        atchEventPollIntervalMs: 5,
        onAtchEventDiagnostic: ({ diagnostic }) => diagnostics.push(diagnostic.code),
        hookInstallationProbe: (provider) => ({
          provider,
          installed: true,
          trust: 'not-applicable'
        })
      });

    daemon = create();
    const ensured = daemon.router.sessions.ensure(
      sessionId,
      { rows: 24, cols: 80 },
      subject
    );
    expect(ensured).toMatchObject({ ok: true, generation: 1 });
    const sink = prepareAtchEventSink(home, sessionId, 1);
    expect(daemon.reconcileAtchEvents(sessionId, 1)).toBe(true);
    appendFileSync(
      sink,
      `${JSON.stringify({
        ts: 1.25,
        type: 'state',
        state: 'idle',
        title: 'Ready'
      })}\n`
    );
    await vi.waitFor(() => {
      expect(daemon?.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'idle'
      });
    });
    const firstLatestSeq = daemon.events().latestSeq;
    expect(firstLatestSeq).toBeGreaterThan(0);

    appendFileSync(
      sink,
      `${JSON.stringify({
        ts: 2,
        type: 'state',
        state: 'busy',
        title: '\u280b x'
      })}\n`
    );
    await vi.waitFor(() => {
      expect(daemon?.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'working'
      });
    });
    expect(daemon.events().latestSeq).toBe(firstLatestSeq);

    daemon.dispose();
    daemon = undefined;
    appendFileSync(
      sink,
      `${JSON.stringify({
        ts: 3,
        type: 'state',
        state: 'idle',
        title: 'Ready'
      })}\n`
    );
    master = new FakeAtchMaster(sockPath);
    await master.listen();
    daemon = create();
    const restored = await daemon.router.sessions.restoreAndAttach(sessionId, {
      sockPath,
      geometry: { rows: 24, cols: 80 },
      killSpec: { binPath: '/bin/true', args: [] },
      subject
    });
    expect(restored).toMatchObject({ ok: true, generation: 1 });
    expect(daemon.reconcileAtchEvents(sessionId, 1)).toBe(true);

    const snapshot = daemon.agentStates().snapshots[0];
    expect(snapshot).toBeDefined();
    expect(parseSessionStateSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot?.subject).toMatchObject({
      kind: 'agent',
      activity: 'idle',
      evidence: { source: 'terminal-title', observedAt: 3_000 }
    });
    expect(daemon.terminalObservation(sessionId)).toMatchObject({
      generation: 1,
      activity: 'idle',
      activityAt: 3_000,
      title: 'Ready'
    });
    expect(daemon.events().latestSeq).toBe(firstLatestSeq + 1);
    expect(diagnostics).toEqual([]);

    appendFileSync(
      sink,
      `${JSON.stringify({
        ts: 4,
        type: 'state',
        state: 'busy',
        title: '\u280b x'
      })}\n`
    );
    await vi.waitFor(() => {
      expect(daemon?.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'working'
      });
    });
    expect(daemon.events().latestSeq).toBe(firstLatestSeq + 1);

    truncateSync(sink, 0);
    appendFileSync(
      sink,
      `${JSON.stringify({
        ts: 5,
        type: 'state',
        state: 'idle',
        title: 'Ready'
      })}\n`
    );
    await vi.waitFor(() => {
      expect(daemon?.agentStates().snapshots[0]?.subject).toMatchObject({
        kind: 'agent',
        activity: 'idle'
      });
    });
    expect(daemon.events().latestSeq).toBe(firstLatestSeq + 2);
    expect(diagnostics).toEqual([]);
  });
});
