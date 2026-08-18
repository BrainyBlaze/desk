// Background work in the engine is dispatched fire-and-forget from timers and
// from other async paths. Node terminates the process on an unhandled
// rejection, so a throwing transport or a full disk in one of those dispatches
// takes the whole server down from a tick nobody is awaiting.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelsEngine } from '../src/server/channels/delivery/engine.js';
import { claimDelivering, confirmDelivered } from '../src/server/channels/delivery/durability.js';
import { canonicalAgentStateBatch } from './helpers/canonicalAgentState.js';

const READY_PANE = 'agent ready\n> ';

describe('background dispatch never crashes the process', () => {
  let home: string;
  let engine: ChannelsEngine | undefined;
  let rejections: unknown[];
  const captureRejection = (reason: unknown): void => {
    rejections.push(reason);
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-bg-errors-'));
    mkdirSync(home, { recursive: true });
    rejections = [];
    process.on('unhandledRejection', captureRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', captureRejection);
    engine?.dispose();
    engine = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  /** Let the microtask queue settle so an unhandled rejection would surface. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  it('survives a transport that throws instead of returning false', async () => {
    engine = new ChannelsEngine({
      home,
      sendEnter: async () => true,
      capturePane: async () => READY_PANE,
      releaseSettleMs: 0,
      pumpIntervalMs: 5,
      blockedAfterCycles: 0,
      readAgentStates: async () => canonicalAgentStateBatch(['tmux-a'], { lifecycle: 'running' }),
      // A transport that rejects — a broken daemon socket, not a clean refusal.
      sendText: async () => {
        throw new Error('transport exploded');
      }
    });

    engine.enqueuePrompt('tmux-a', 'ops', 'hello', 'bg-throw-1');
    await settle();

    expect(rejections, 'a throwing transport must not become an unhandled rejection').toEqual([]);
    // and the engine is still serving, not wedged by its own failure
    expect(engine.pumpAlive()).toBe(true);
    await expect(engine.inspectSession('tmux-a')).resolves.toMatchObject({ sessionId: 'tmux-a' });
  });

  it('survives a state read that throws on every pump tick', async () => {
    engine = new ChannelsEngine({
      home,
      sendEnter: async () => true,
      sendText: async () => true,
      capturePane: async () => READY_PANE,
      releaseSettleMs: 0,
      pumpIntervalMs: 5,
      blockedAfterCycles: 0,
      readAgentStates: async () => {
        throw new Error('daemon unreachable');
      }
    });

    engine.enqueuePrompt('tmux-a', 'ops', 'hello', 'bg-throw-2');
    await settle();

    expect(rejections, 'an unreachable daemon must not become an unhandled rejection').toEqual([]);
    expect(engine.pumpAlive()).toBe(true);
  });

  it('contains an async channel-event failure without dropping normal queueing', async () => {
    engine = new ChannelsEngine({
      home,
      sendEnter: async () => true,
      sendText: async () => true,
      capturePane: async () => READY_PANE,
      readAgentStates: async () => canonicalAgentStateBatch(['tmux-a']),
      onChannelMessage: async () => {
        throw new Error('event projection failed');
      }
    });
    engine.pauseSession('tmux-a', 'hold delivery for inspection');

    await engine.handleMessage(
      {
        channel: 'ops',
        file: 'root.md',
        message: {
          id: 'msg-bg-event-1',
          author: 'human',
          body: '@alpha inspect this',
          createdAt: '2026-08-17T00:00:00.000Z',
          reactions: []
        }
      },
      [{ name: 'alpha', type: 'codex', sessionId: 'tmux-a' }]
    );
    await settle();

    expect(rejections, 'an async event callback must not become an unhandled rejection').toEqual([]);
    expect(engine.queuedItems('tmux-a')).toHaveLength(1);
  });
});

describe('an unverifiable delivery is never blind-repasted', () => {
  let home: string;
  let engine: ChannelsEngine | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-unobservable-'));
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    engine?.dispose();
    engine = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it('submits a standalone prompt once when the pane can never be observed', async () => {
    const sent: string[] = [];
    const stateChanges: string[] = [];
    engine = new ChannelsEngine({
      home,
      sendEnter: async () => true,
      sendText: async (_sessionId: string, text: string) => {
        sent.push(text);
        return true;
      },
      // Pane capture is deliberately unavailable. Delivery acknowledgement now
      // comes from the atomic prompt transport instead of terminal heuristics.
      capturePane: async () => null,
      releaseSettleMs: 0,
      pumpIntervalMs: 5,
      enterVerifyDelayMs: 1,
      verifyCycles: 1,
      readAgentStates: async () => canonicalAgentStateBatch(['tmux-a'], { lifecycle: 'running' }),
      // Wire the same durability transitions as production.
      onSubmitStateChange: (sessionId, state, detail) => {
        stateChanges.push(`${sessionId}:${state}:${detail.seq}`);
        if (state === 'delivering') claimDelivering(home, sessionId, detail.seq);
        else if (state === 'submitted') confirmDelivered(home, sessionId, detail.seq);
      }
    });

    engine.enqueuePrompt('tmux-a', 'ops', 'onboarding briefing', 'unobservable-1');
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const diagnostic = await engine.inspectSession('tmux-a');
    expect(stateChanges).toEqual(['tmux-a:delivering:1', 'tmux-a:submitted:1']);
    expect(sent.length, 'an acknowledged packet must not be repeated blind').toBe(1);
    expect(diagnostic.submitState).toBe('submitted');
  });
});
