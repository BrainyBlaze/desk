import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_STATE_SCHEMA_VERSION } from '../src/shared/controlPlane/index.js';
import {
  createTerminalDaemon,
  type TerminalDaemon
} from '../src/server/runtime/terminalDaemon.js';

type UpgradeListener = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => void;

class FakeUpgradeServer {
  listeners: UpgradeListener[] = [];

  on(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners.push(listener);
  }

  off(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
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

  function start(fetch: typeof globalThis.fetch): TerminalDaemon {
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
      })
    ).toMatchObject({ kind: 'accepted' });
    expect(
      daemon.agentEndpoint({
        schemaVersion: AGENT_STATE_SCHEMA_VERSION,
        sessionId: 'opencode-a',
        generation: 1,
        provider: 'opencode',
        mode: 'terminal',
        producer: 'opencode-terminal',
        producerInstanceId: 'plugin-a',
        producerSeq: 2,
        endpoint: 'http://127.0.0.1:4096/',
        providerSessionId: 'provider-a',
        observedAt: 975
      })
    ).toMatchObject({ kind: 'accepted' });
    expect(daemon.agentStates().snapshots[0]?.subject).toMatchObject({
      kind: 'agent',
      activity: 'unknown'
    });
    return daemon;
  }

  it('uses only the registered provider session and emits canonical poll evidence', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          stale_other_conversation: { type: 'busy' },
          'provider-a': { type: 'idle' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const running = start(fetch);
    now = 1_100;

    await expect(running.reconcileAgentProviders(['opencode-a'])).resolves.toEqual([
      { sessionId: 'opencode-a', kind: 'reconciled' }
    ]);

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4096/session/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
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

  it('does not aggregate another provider session into the selected Desk session', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ stale_other_conversation: { type: 'busy' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const running = start(fetch);

    await expect(running.reconcileAgentProviders(['opencode-a'])).resolves.toEqual([
      { sessionId: 'opencode-a', kind: 'skipped', reason: 'no-facts' }
    ]);
    expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
      kind: 'agent',
      activity: 'unknown'
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
    expect(fetch).not.toHaveBeenCalled();
    expect(running.agentStates().snapshots[0]?.subject).toMatchObject({
      kind: 'agent',
      activity: 'unknown'
    });
  });
});
