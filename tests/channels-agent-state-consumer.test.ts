import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelsEngine } from '../src/server/channels/delivery/engine.js';
import type { AgentStateBatch } from '../src/server/channels/delivery/strategy.js';
import type { ChannelMember, ChannelMessage } from '../src/server/channels/protocol/format.js';
import {
  AGENT_STATE_SCHEMA_VERSION,
  type AgentActivity,
  type SessionStateSnapshot,
  type WaitOwner
} from '../src/shared/controlPlane/index.js';

const NOW = 1_800_000_000_000;
const homes: string[] = [];

function snapshot(
  activity: AgentActivity,
  options: { waitOwner?: WaitOwner; waitKind?: string; leaseExpiresAt?: number } = {}
): SessionStateSnapshot {
  const blocked = activity === 'blocked';
  return {
    schemaVersion: AGENT_STATE_SCHEMA_VERSION,
    revision: 9,
    sessionId: 'session-a',
    generation: 1,
    lifecycle: 'running',
    lifecycleSince: NOW - 10_000,
    exit: null,
    health: { status: 'healthy', since: NOW - 10_000 },
    delivery: null,
    policy: { paused: false, since: NOW - 10_000 },
    subject: {
      kind: 'agent',
      provider: 'codex',
      mode: 'terminal',
      producer: 'codex-hooks',
      activity,
      activitySince: NOW - 5_000,
      wait: blocked
        ? {
            kind: options.waitKind ?? 'approval',
            owner: options.waitOwner ?? 'operator',
            since: NOW - 5_000
          }
        : null,
      evidence:
        activity === 'unknown'
          ? null
          : {
              acceptanceId: 'accept-1',
              acceptedSeq: 1,
              acceptedAt: NOW - 5_000,
              producerInstanceId: 'producer-1',
              producerSeq: 1,
              eventId: 'event-1',
              invocationId: 'invocation-1',
              factKinds: ['activity'],
              occurredAt: NOW - 5_000,
              observedAt: NOW - 5_000,
              ...(activity === 'working'
                ? { leaseExpiresAt: options.leaseExpiresAt ?? NOW + 30_000 }
                : {})
            }
    },
    updatedAt: NOW - 5_000
  };
}

function batch(activity: AgentActivity, revision = 73): AgentStateBatch {
  return { ok: true, revision, snapshots: [snapshot(activity)] };
}

function member(): ChannelMember {
  return {
    name: 'alpha',
    type: 'codex-cli',
    status: 'active',
    joined: '2026-07-27 00:00:00',
    sessionId: 'session-a'
  };
}

function message(id: string): ChannelMessage {
  return {
    id,
    author: 'human',
    timestamp: '2026-07-27 00:00:00',
    body: '@alpha inspect this',
    hasEndTurn: true
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let index = 0; index < 80; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met');
}

function createEngine(options: {
  readAgentStates: () => Promise<AgentStateBatch>;
  sendText?: (sessionId: string, text: string) => Promise<boolean>;
  capturePane?: () => Promise<string | null>;
}): ChannelsEngine {
  const home = mkdtempSync(join(tmpdir(), 'desk-channel-state-'));
  homes.push(home);
  return new ChannelsEngine({
    home,
    readAgentStates: options.readAgentStates,
    now: () => NOW,
    pumpIntervalMs: 60_000,
    enterVerifyDelayMs: 1,
    verifyCycles: 1,
    sendText: options.sendText ?? (async () => true),
    sendEnter: async () => true,
    capturePane: options.capturePane ?? (async () => 'raw terminal bytes'),
    sessionRunning: () => true,
  });
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('ChannelsEngine canonical state consumption', () => {
  it('reads one authority batch for a dispatch and one for the whole footer projection', async () => {
    const readAgentStates = vi.fn(async () => batch('idle', 73));
    const sent: string[] = [];
    const engine = createEngine({
      readAgentStates,
      sendText: async (_sessionId, text) => {
        sent.push(text);
        return true;
      }
    });

    engine.handleMessage({ channel: 'desk', file: 'root.md', message: message('msg-state-1') }, [member()]);
    await waitFor(() => sent.length === 1);
    expect(readAgentStates).toHaveBeenCalledTimes(1);

    const footer = await engine.lifecycleStates();
    expect(readAgentStates).toHaveBeenCalledTimes(2);
    expect(footer).toEqual([
      expect.objectContaining({
        sessionId: 'session-a',
        authorityRevision: 73,
        activity: 'idle',
        queueDepth: 0
      })
    ]);
    engine.dispose();
  });

  // Canonical state still drives what the operator SEES — the reported activity
  // is `blocked` — but it no longer drives whether the message goes. Reporting
  // and gating were one wire; they are now two.
  it('DELIVERS while canonical activity is blocked, and still reports it', async () => {
    const sent: string[] = [];
    const engine = createEngine({
      readAgentStates: async () => batch('blocked'),
      sendText: async (_sessionId, text) => {
        sent.push(text);
        return true;
      },
      capturePane: async () => '❯ '
    });

    engine.handleMessage({ channel: 'desk', file: 'root.md', message: message('msg-state-2') }, [member()]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sent).toHaveLength(1);
    expect(await engine.lifecycleStates()).toEqual([
      expect.objectContaining({ activity: 'blocked' })
    ]);
    engine.dispose();
  });

  // The complement, and the regression this pair exists to catch: a mid-turn
  // agent RECEIVES. Every provider Desk drives buffers typed input, so holding
  // here only made a busy agent look unreachable.
  it('DELIVERS to a mid-turn agent instead of queueing behind the lamp', async () => {
    const sent: string[] = [];
    const engine = createEngine({
      readAgentStates: async () => batch('working'),
      sendText: async (_sessionId, text) => {
        sent.push(text);
        return true;
      },
      capturePane: async () => '❯ '
    });

    engine.handleMessage({ channel: 'desk', file: 'root.md', message: message('msg-state-2') }, [member()]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sent).toHaveLength(1);
    engine.dispose();
  });

  it('keeps pause as delivery state while canonical activity remains working', async () => {
    const engine = createEngine({ readAgentStates: async () => batch('working') });
    engine.pauseSession('session-a', 'operator hold');

    expect(await engine.lifecycleStates()).toEqual([
      expect.objectContaining({
        activity: 'working',
        actionable: false,
        deliveryStatus: 'paused',
        pauseReason: 'operator hold'
      })
    ]);
    engine.dispose();
  });

  it('projects operator waits as actionable and provider waits as non-actionable', async () => {
    let current = {
      ok: true,
      revision: 80,
      snapshots: [snapshot('blocked', { waitOwner: 'operator', waitKind: 'approval' })]
    } satisfies AgentStateBatch;
    const engine = createEngine({ readAgentStates: async () => current });
    engine.pauseSession('session-a', 'create runtime');

    expect(await engine.lifecycleStates()).toEqual([
      expect.objectContaining({ activity: 'blocked', waitOwner: 'operator', actionable: true })
    ]);

    current = {
      ok: true,
      revision: 81,
      snapshots: [snapshot('blocked', { waitOwner: 'provider', waitKind: 'rate-limit' })]
    };
    expect(await engine.lifecycleStates()).toEqual([
      expect.objectContaining({ activity: 'blocked', waitOwner: 'provider', actionable: false })
    ]);
    engine.dispose();
  });
});
