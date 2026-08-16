// Background work in the engine is dispatched fire-and-forget from timers and
// from other async paths. Node terminates the process on an unhandled
// rejection, so a throwing transport or a full disk in one of those dispatches
// takes the whole server down from a tick nobody is awaiting.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelsEngine } from '../src/server/channels/delivery/engine.js';
import { claimDelivering, confirmDelivered, markStuck } from '../src/server/channels/delivery/durability.js';
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

  it('sends a standalone prompt once when the pane can never be observed', async () => {
    const sent: string[] = [];
    const stateChanges: string[] = [];
    engine = new ChannelsEngine({
      home,
      sendEnter: async () => true,
      sendText: async (_sessionId: string, text: string) => {
        sent.push(text);
        return true;
      },
      // The pane is unreadable for the whole verify window: we cannot tell
      // whether the paste landed, so a retry would duplicate it into the agent.
      capturePane: async () => null,
      releaseSettleMs: 0,
      pumpIntervalMs: 5,
      enterVerifyDelayMs: 1,
      verifyCycles: 1,
      readAgentStates: async () => canonicalAgentStateBatch(['tmux-a'], { lifecycle: 'running' }),
      // Production wires this to the durability layer; without it no .stuck-*
      // file exists and the retry has nothing to revive, which is what made an
      // earlier version of this test pass against the unfixed engine.
      // Wire the SAME durability renames production wires (channelsApi), so a
      // .stuck-unobservable file really exists for a retry to revive. Without
      // this the retry has nothing to find and the test proves nothing.
      onSubmitStateChange: (sessionId, state, detail) => {
        stateChanges.push(`${sessionId}:${state}:${detail.seq}`);
        if (state === 'delivering') claimDelivering(home, sessionId, detail.seq);
        else if (state === 'submitted') confirmDelivered(home, sessionId, detail.seq);
        else if (state === 'submit-stuck-unobservable') markStuck(home, sessionId, detail.seq, 'unobservable');
      }
    });

    engine.enqueuePrompt('tmux-a', 'ops', 'onboarding briefing', 'unobservable-1');
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const diagnostic = await engine.inspectSession('tmux-a');
    expect(stateChanges, 'the delivery must reach the unobservable stuck state').toContain('tmux-a:submit-stuck-unobservable:1');
    expect(sent.length, 'an unverifiable paste must not be repeated blind').toBe(1);
    expect(diagnostic.submitState, 'and it must be surfaced for the operator').toBe('submit-stuck-unobservable');
  });
});
