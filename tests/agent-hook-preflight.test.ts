import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HookInstallationProbe,
  HookProbeProvider
} from '../src/core/agentHooks.js';
import {
  createTerminalDaemon,
  type TerminalDaemon
} from '../src/server/runtime/terminalDaemon.js';
import { AGENT_STATE_SCHEMA_VERSION } from '../src/shared/controlPlane/index.js';

type UpgradeListener = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => void;

class FakeUpgradeServer {
  private listeners: UpgradeListener[] = [];

  on(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners.push(listener);
  }

  off(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }
}

describe('daemon agent hook preflight', () => {
  let home: string;
  let daemon: TerminalDaemon | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-hook-preflight-'));
    mkdirSync(join(home, '_engine'), { recursive: true });
  });

  afterEach(() => {
    daemon?.dispose();
    daemon = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  function start(
    hookInstallationProbe: (
      provider: HookProbeProvider
    ) => HookInstallationProbe
  ): TerminalDaemon {
    daemon = createTerminalDaemon({
      homeRoot: home,
      moorBinPath: '/bin/false',
      moorSocketRoot: home,
      httpServer: new FakeUpgradeServer(),
      now: () => 1_000,
      hookInstallationProbe
    });
    return daemon;
  }

  it('degrades a terminal agent when current Desk hook wiring is provably absent', () => {
    const probe = vi.fn(
      (provider: HookProbeProvider): HookInstallationProbe => ({
        provider,
        installed: false,
        trust: 'not-applicable',
        detail: 'desk-owned claude settings do not reference the current shim'
      })
    );
    const running = start(probe);
    const subject = {
      kind: 'agent',
      provider: 'claude',
      mode: 'terminal',
      producer: 'claude-hooks'
    } as const;

    running.router.sessions.ensure('claude-a', { rows: 24, cols: 80 }, subject);
    expect(running.agentStates().snapshots[0]).toMatchObject({
      health: {
        status: 'degraded',
        reason: 'hook-not-installed',
        detail: 'desk-owned claude settings do not reference the current shim'
      },
      subject: {
        kind: 'agent',
        activity: 'unknown',
        evidence: null
      }
    });

    running.router.sessions.ensure('claude-a', { rows: 24, cols: 80 }, subject);
    running.router.sessions.ensure('terminal-a', { rows: 24, cols: 80 });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('claude');
  });

  it('degrades Codex only when trust absence is provable', () => {
    const probe = vi.fn(
      (provider: HookProbeProvider): HookInstallationProbe => ({
        provider,
        installed: true,
        trust: 'absent'
      })
    );
    const running = start(probe);

    running.router.sessions.ensure(
      'codex-a',
      { rows: 24, cols: 80 },
      {
        kind: 'agent',
        provider: 'codex',
        mode: 'terminal',
        producer: 'codex-hooks'
      }
    );

    expect(running.agentStates().snapshots[0]?.health).toMatchObject({
      status: 'degraded',
      reason: 'codex-hook-untrusted'
    });
  });

  it('does not mistake a Codex trust record for proof and lets accepted evidence restore health', () => {
    const running = start((provider) => ({
      provider,
      installed: true,
      trust: 'recorded'
    }));
    running.router.sessions.ensure(
      'codex-a',
      { rows: 24, cols: 80 },
      {
        kind: 'agent',
        provider: 'codex',
        mode: 'terminal',
        producer: 'codex-hooks'
      }
    );
    expect(running.agentStates().snapshots[0]).toMatchObject({
      health: {
        status: 'degraded',
        reason: 'awaiting-reconciliation'
      },
      subject: { activity: 'unknown', evidence: null }
    });

    expect(
      running.agentEvent({
        schemaVersion: AGENT_STATE_SCHEMA_VERSION,
        sessionId: 'codex-a',
        generation: 2,
        provider: 'codex',
        mode: 'terminal',
        producer: 'codex-hooks',
        producerInstanceId: 'hooks-a',
        producerSeq: 1,
        eventId: 'hooks-a:1',
        invocationId: 'hook-1',
        occurredAt: 1_000,
        observedAt: 1_000,
        facts: [{ kind: 'heartbeat' }]
      })
    ).toMatchObject({ kind: 'accepted' });
    expect(running.agentStates().snapshots[0]).toMatchObject({
      health: { status: 'healthy' },
      subject: {
        activity: 'unknown',
        evidence: { factKinds: ['heartbeat'] }
      }
    });
  });

  it('does not apply terminal hook probes to native producers', () => {
    const probe = vi.fn(
      (provider: HookProbeProvider): HookInstallationProbe => ({
        provider,
        installed: false,
        trust: 'absent'
      })
    );
    const running = start(probe);

    running.router.sessions.ensure(
      'codex-native-a',
      { rows: 24, cols: 80 },
      {
        kind: 'agent',
        provider: 'codex',
        mode: 'native',
        producer: 'codex-native'
      }
    );

    expect(probe).not.toHaveBeenCalled();
    expect(running.agentStates().snapshots[0]?.health).toMatchObject({
      status: 'degraded',
      reason: 'awaiting-reconciliation'
    });
  });
});
