import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDigestPrompt,
  buildOnboardingPrompt,
  buildTurnPrompt,
  ChannelsEngine,
  type ChannelsEngineOptions
} from '../src/server/channelsEngine.js';
import {
  claimDelivering,
  confirmDelivered,
  ensureQueueDir,
  listStuckItems,
  markStuck,
  EXT_STUCK_SUBMIT
} from '../src/server/channelsDurability.js';
import { readDeliveryEvents } from '../src/server/channelsEvents.js';
import { pauseSession as persistPausedSession } from '../src/server/channelsPaused.js';
import { DELIVERY_BLOCK_REASONS } from '../src/server/channelsProtocol.js';
import type { ChannelMember, ChannelMessage, DeliveryBlockReason } from '../src/server/channelsProtocol.js';
import {
  appendMessage,
  ChannelsWatcher,
  createChannel,
  deleteMessage,
  editChannelGoal,
  editMessage,
  listChannels,
  MAX_MESSAGE_BYTES,
  readChannelDetail,
  readThread,
  sliceMessages
} from '../src/server/channelsStore.js';
import { canonicalAgentStateBatch } from './helpers/canonicalAgentState.js';

vi.mock('../src/server/agentStatePulse.js', async () => {
  const { canonicalAgentStateBatch } = await import('./helpers/canonicalAgentState.js');
  const sessions = Array.from({ length: 26 }, (_, index) => `tmux-${String.fromCharCode(97 + index)}`);
  return {
    readAgentStatePulse: async () => canonicalAgentStateBatch(sessions)
  };
});

const message = (id: string, author: string, body: string): ChannelMessage => ({
  id,
  author,
  timestamp: '2026-06-11 12:00:00',
  body,
  hasEndTurn: true
});

const member = (name: string, sessionId: string, type = 'claude-code'): ChannelMember => ({
  name,
  type,
  status: 'active',
  joined: '2026-06-11 12:00:00',
  sessionId
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/** Polls until a condition holds (pump/reconcile are async + interval-driven, so
 *  a fixed sleep flakes under load). */
const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!(await predicate()) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

// Realistic pane samples used for diagnostics. Channel notification delivery is
// intentionally force-injected and no longer gates on these pane states.
const READY_PANE = '❯ ';
const WORKING_PANE = '✶ Waddling… (3m 31s · ↓ 13.0k tokens)';
const APPROVAL_PANE = ['Allow command?', '› Yes', '  No'].join('\n');
const MENU_PANE = ['Select a model', '› gpt-5.5', '  gpt-5'].join('\n');

describe('ChannelsEngine delivery gating', () => {
  let home: string;
  let sent: Array<{ session: string; text: string }>;
  let engine: ChannelsEngine;
  let running: Set<string>;
  let pane: string; // the live pane the shared engine's probe reads (mutable)

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-chan-'));
    sent = [];
    running = new Set(['tmux-a', 'tmux-b']);
    pane = READY_PANE;
    engine = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      // fast verify so a delivery's submitState resolves within the test window
      // (the probe-authoritative double-feed guard holds only while 'delivering')
      enterVerifyDelayMs: 100,
      verifyCycles: 1,
      sendText: async (session, text) => {
        sent.push({ session, text });
        return true;
      },
      sessionRunning: (session) => running.has(session),
      capturePane: async () => pane
    });
  });

  it('observes every declared live delivery block reason through production paths', async () => {
    type ReachabilityOptions = Partial<Omit<ChannelsEngineOptions, 'home'>>;

    const observed = new Set<DeliveryBlockReason>();
    const liveEngines: ChannelsEngine[] = [];
    let releaseDraining: (() => void) | undefined;

    const makeEngine = (reason: DeliveryBlockReason, options: ReachabilityOptions): ChannelsEngine => {
      const engineHome = join(home, `reach-${reason}`);
      mkdirSync(engineHome, { recursive: true });
      const candidate = new ChannelsEngine({
        home: engineHome,
        sendEnter: async () => true,
        sendText: async () => true,
        capturePane: async () => READY_PANE,
        releaseSettleMs: 0,
        pumpIntervalMs: 60_000,
        blockedAfterCycles: 1,
        ...options
      });
      liveEngines.push(candidate);
      return candidate;
    };

    const exercise = async (
      expected: DeliveryBlockReason,
      options: ReachabilityOptions,
      trigger: (candidate: ChannelsEngine) => void | Promise<void> = (candidate) => {
        candidate.enqueuePrompt('tmux-a', 'ops', `exercise ${expected}`, `reach-${expected}`);
      }
    ): Promise<void> => {
      const candidate = makeEngine(expected, options);
      await trigger(candidate);
      await waitFor(async () => (await candidate.inspectSession('tmux-a')).blockedReason === expected);
      const reason = (await candidate.inspectSession('tmux-a')).blockedReason;
      expect(reason).toBe(expected);
      if (reason) {
        observed.add(reason);
      }
    };

    try {
      await exercise('offline', {
        blockedAfterCycles: 0,
        readAgentStates: async () => canonicalAgentStateBatch(['tmux-a'], { lifecycle: 'exited' })
      });

      await exercise('booting', {
        blockedAfterCycles: 0,
        readAgentStates: async () => canonicalAgentStateBatch(['tmux-a'], { lifecycle: 'starting' })
      });

      await exercise('send-failed', {
        blockedAfterCycles: 0,
        sendText: async () => false
      });

      await exercise('submit-stuck-paste', {
        enterVerifyDelayMs: 1,
        verifyCycles: 1
      });

      let submitPane = READY_PANE;
      await exercise('submit-stuck-submit', {
        enterVerifyDelayMs: 1,
        verifyCycles: 1,
        sendText: async () => {
          submitPane = '❯ wedged prompt';
          return true;
        },
        capturePane: async () => submitPane
      });

      let pasteStarted = false;
      await exercise(
        'draining',
        {
          blockedAfterCycles: 0,
          sendText: async () => {
            pasteStarted = true;
            await new Promise<boolean>((resolve) => {
              releaseDraining = () => resolve(true);
            });
            return true;
          }
        },
        async (candidate) => {
          candidate.enqueuePrompt('tmux-a', 'ops', 'exercise draining', 'reach-draining');
          await waitFor(() => pasteStarted);
          await candidate.drainReady();
        }
      );
    } finally {
      releaseDraining?.();
      for (const candidate of liveEngines) {
        candidate.dispose();
      }
    }

    expect(observed).toEqual(new Set(DELIVERY_BLOCK_REASONS));
  });

  afterEach(() => {
    engine.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  const members = [member('alpha', 'tmux-a'), { ...member('human', '', 'human'), sessionId: undefined }];
  const multiMembers = [
    member('alpha', 'tmux-a'),
    member('beta', 'tmux-b'),
    { ...member('human', '', 'human'), sessionId: undefined }
  ];

  it('uses canonical idle even when raw terminal bytes look working', async () => {
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-1-aaaa', 'human', 'hi @alpha') }, members);
    await waitFor(() => sent.length === 1);
    expect(sent[0].session).toBe('tmux-a');
    expect(sent[0].text).toContain('msg-1-aaaa');

    // Raw terminal text is delivery evidence only. It cannot override the
    // canonical idle snapshot supplied by the authority fixture.
    pane = WORKING_PANE;
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-2-bbbb', 'human', '@alpha again') }, members);
    await waitFor(() => sent.length === 2);
    expect(sent[1].text).toContain('msg-2-bbbb');
    expect((await engine.lifecycleStates()).find((state) => state.sessionId === 'tmux-a')).toMatchObject({
      activity: 'idle',
      queueDepth: 0
    });
  });

  it('does not infer an approval wait from raw terminal menu text', async () => {
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-1-aaaa', 'human', '@alpha one') }, members);
    await waitFor(() => sent.length === 1);
    // Without a typed blocked observation, menu-looking bytes are not semantic
    // evidence and cannot create a wait or hold.
    pane = APPROVAL_PANE;
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-2-bbbb', 'human', '@alpha two') }, members);
    await waitFor(() => sent.length === 2);
    expect(sent[1].text).toContain('msg-2-bbbb');
    expect((await engine.lifecycleStates()).find((state) => state.sessionId === 'tmux-a')).toMatchObject({
      activity: 'idle',
      actionable: false
    });
  });

  it('fans out to all agents except the author; author session never self-delivers', async () => {
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-3-cccc', 'alpha', 'hello @channel') }, multiMembers);
    await flush();
    expect(sent.map((entry) => entry.session)).toEqual(['tmux-b']);
  });

  it('delivers explicit agent mentions only to the mentioned agent', async () => {
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-mention-1', 'human', 'hello @beta') }, multiMembers);
    await flush();
    expect(sent.map((entry) => entry.session)).toEqual(['tmux-b']);
    expect(sent[0].text).toContain('notificationId:msg-mention-1');
  });

  it('does not deliver human-only mentions to agents', async () => {
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-human-mention-1', 'human', 'hello @human') }, multiMembers);
    await flush();
    expect(sent).toEqual([]);
  });

  it('delivers a message whose only mentions name nobody in the channel (desk#44)', async () => {
    // The live defect: `@asher` is an external person, no channel member matches,
    // and the message was dropped to zero recipients with no trace anywhere.
    engine.handleMessage(
      {
        channel: 'ops',
        file: 'root.md',
        message: message('msg-unknown-mention-1', 'human', 'proceed with 1-2-3, and ping @asher about the follow-up')
      },
      multiMembers
    );
    await waitFor(() => sent.length === 2);
    expect(sent.map((entry) => entry.session).sort()).toEqual(['tmux-a', 'tmux-b']);
    expect(sent[0].text).toContain('notificationId:msg-unknown-mention-1');
  });

  it('routes an unmentioned thread reply only to the thread parent author', async () => {
    createChannel(home, 'ops', 'ops channel');
    const parent = await appendMessage(home, 'ops', { author: 'alpha', body: 'root question' });
    const threeAgentMembers = [...multiMembers, member('gamma', 'tmux-c')];

    engine.handleMessage(
      {
        channel: 'ops',
        file: `thread-${parent.message.id}.md`,
        message: message('msg-thread-plain', 'beta', 'plain thread reply')
      },
      threeAgentMembers
    );
    await flush();

    expect(sent.map((entry) => entry.session)).toEqual(['tmux-a']);
  });

  it('routes a thread reply with an agent mention to the thread parent author and mentioned agent only', async () => {
    createChannel(home, 'ops', 'ops channel');
    const parent = await appendMessage(home, 'ops', { author: 'alpha', body: 'root question' });
    const threeAgentMembers = [...multiMembers, member('gamma', 'tmux-c')];

    engine.handleMessage(
      {
        channel: 'ops',
        file: `thread-${parent.message.id}.md`,
        message: message('msg-thread-mention', 'beta', 'please check @gamma')
      },
      threeAgentMembers
    );
    await flush();

    expect(sent.map((entry) => entry.session)).toEqual(['tmux-a', 'tmux-c']);
  });

  it('ignores channel mentions in thread replies instead of broadcasting to every agent', async () => {
    createChannel(home, 'ops', 'ops channel');
    const parent = await appendMessage(home, 'ops', { author: 'alpha', body: 'root question' });
    const threeAgentMembers = [...multiMembers, member('gamma', 'tmux-c')];

    engine.handleMessage(
      {
        channel: 'ops',
        file: `thread-${parent.message.id}.md`,
        message: message('msg-thread-channel', 'beta', 'thread ping @channel')
      },
      threeAgentMembers
    );
    await flush();

    expect(sent.map((entry) => entry.session)).toEqual(['tmux-a']);
  });

  it('attempts notification injection even when diagnostics think the session is not running', async () => {
    running.delete('tmux-a');
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-4-dddd', 'human', '@alpha wake up') }, members);
    await waitFor(() => sent.length === 1);
    expect(sent[0].text).toContain('msg-4-dddd');
  });

  it('reclaims a wedged draining lock so a hung capture never strands the queue forever', async () => {
    const recovered: string[] = [];
    let pane: 'wedged' | 'ready' = 'wedged';
    let captureStarted = false;
    const wedged = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 15,
      // tiny watchdog so the test does not wait the production 30s
      drainWatchdogMs: 60,
      sendText: async (_session, text) => {
        recovered.push(text);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => {
        captureStarted = true;
        // The pane stays wedged until the test flips explicit state. Any
        // incidental probe before recovery sees the same state instead of
        // consuming a fragile "first call" mock.
        if (pane === 'wedged') {
          return new Promise<string>(() => {});
        }
        return '❯ ';
      }
    });
    wedged.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-wedge-1', 'human', 'hi @alpha') }, members);
    await waitFor(() => captureStarted, 1000);
    pane = 'ready';
    // The pump retries; once the watchdog window elapses it reclaims the lock
    // and the next ready-state capture delivers.
    await waitFor(() => recovered.length === 1, 3000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toContain('msg-wedge-1');
    wedged.dispose();
  });

  it('persists explicitly paused queued prompts across an engine restart', async () => {
    engine.pauseSession('tmux-a', 'operator hold');
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-6-ffff', 'human', '@alpha held') }, members);
    await flush();
    expect(sent).toHaveLength(0);
    persistPausedSession(home, 'tmux-a', 'operator hold', new Date('2026-06-18T20:00:00.000Z'));

    const sentAfterRestart: Array<{ session: string; text: string }> = [];
    const revived = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      sendText: async (session, text) => {
        sentAfterRestart.push({ session, text });
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
    await flush();
    expect(sentAfterRestart).toHaveLength(0);
    expect((await revived.lifecycleStates()).find((state) => state.sessionId === 'tmux-a')).toMatchObject({
      deliveryStatus: 'paused',
      queueDepth: 1
    });
    revived.resumeSession('tmux-a');
    await waitFor(() => sentAfterRestart.length === 1);
    expect(sentAfterRestart[0].text).toContain('msg-6-ffff');
  });

  describe('ops console', () => {
    const opsEngine = (overrides: Record<string, unknown>): ChannelsEngine =>
      new ChannelsEngine({
      sendEnter: async () => true,
        home,
        releaseSettleMs: 0,
        pumpIntervalMs: 100000, // effectively off — drive delivery explicitly in these tests
        sendText: async (session, text) => {
          sent.push({ session, text });
          return true;
        },
        sessionRunning: (session) => running.has(session),
          capturePane: async () => '❯ ',
        ...overrides
      });

    it('inspectSession reports queued item metadata', async () => {
      const eng = opsEngine({ capturePane: async () => 'working (esc to interrupt)' });
      eng.pauseSession('tmux-a', 'operator hold');
      eng.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-q-1', 'human', '@alpha hello there') }, members);
      await flush();
      const diag = await eng.inspectSession('tmux-a');
      expect(diag.queueDepth).toBe(1);
      expect(diag.items[0]).toMatchObject({ messageId: 'msg-q-1', author: 'human', channel: 'ops' });
      expect(diag.items[0].preview.length).toBeGreaterThan(0);
    });

    it('inspectSession does not turn pane holds into delivery blocks', async () => {
      let pane = 'working (esc to interrupt)';
      const eng = opsEngine({
        blockedAfterCycles: 2,
        pumpIntervalMs: 10,
        capturePane: async () => pane
      });
      eng.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-block-1', 'human', '@alpha held') }, members);
      await waitFor(() => sent.length === 1, 1000);

      const diag = await eng.inspectSession('tmux-a');
      expect(diag).toMatchObject({
        deliveryBlocked: false,
        queueDepth: 0
      });

      pane = '❯ ';
      const cleared = await eng.inspectSession('tmux-a');
      expect(cleared.deliveryBlocked).toBe(false);
      expect(cleared.blockedReason).toBeUndefined();
      expect(cleared.queueDepth).toBe(0);
      eng.dispose();
    });

    it('inspectSession keeps structural menu state diagnostic-only', async () => {
      const cases = [
        {
          pane: ['Do you trust this workspace?', '› Yes', '  No'].join('\n'),
          reason: 'trust-menu'
        },
        {
          pane: ['Select a model', '› gpt-5.5', '  gpt-5'].join('\n'),
          reason: 'selection-menu'
        },
        {
          pane: ['Continue?', '› Yes', '  No'].join('\n'),
          reason: 'unknown-menu'
        }
      ] as const;

      for (const [index, entry] of cases.entries()) {
        const before = sent.length;
        const eng = opsEngine({
          blockedAfterCycles: 1,
          pumpIntervalMs: 10,
          capturePane: async () => entry.pane
        });
        eng.handleMessage(
          { channel: 'ops', file: 'root.md', message: message(`msg-menu-${index}`, 'human', '@alpha held') },
          members
        );
        await waitFor(() => sent.length === before + 1, 1000);

        const diag = await eng.inspectSession('tmux-a');
        expect(diag).toMatchObject({
          deliveryBlocked: false,
          queueDepth: 0
        });
        eng.dispose();
      }
    });

    it('inspectSession treats legacy submit-stuck files as inert history', async () => {
      const dir = join(home, '_engine', 'queue', 'tmux-a');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, '0000000007.stuck-submit'),
        JSON.stringify({
          seq: 7,
          channel: 'ops',
          messageId: 'msg-stuck-1',
          author: 'human',
          prompt: '@alpha stuck prompt',
          queuedAt: '2026-06-18T09:00:00.000Z',
          kind: 'message'
        })
      );
      const eng = opsEngine({ blockedAfterCycles: 2 });
      const diag = await eng.inspectSession('tmux-a');
      expect(diag).toMatchObject({
        activity: 'idle',
        deliveryStatus: 'ready',
        deliveryBlocked: false,
        queueDepth: 0
      });
      expect(diag.blockedItems).toEqual([]);
      eng.dispose();
    });

    it('inspectSession surfaces durable stuck-unobservable items for operator action', async () => {
      const eng = opsEngine({ blockedAfterCycles: 2 });
      const dir = join(home, '_engine', 'queue', 'tmux-a');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, '0000000011.stuck-unobservable'),
        JSON.stringify({
          seq: 11,
          channel: 'ops',
          messageId: 'msg-stuck-unobservable-1',
          author: 'human',
          prompt: '@alpha unobservable prompt',
          queuedAt: '2026-06-18T09:00:00.000Z',
          kind: 'message'
        })
      );
      const diag = await eng.inspectSession('tmux-a');
      expect(diag).toMatchObject({
        activity: 'idle',
        deliveryStatus: 'ready',
        deliveryBlocked: false,
        queueDepth: 0
      });
      expect(diag.blockedItems).toEqual([
        {
          seq: 11,
          kind: 'unobservable',
          channel: 'ops',
          messageId: 'msg-stuck-unobservable-1',
          author: 'human',
          queuedAt: '2026-06-18T09:00:00.000Z',
          preview: '@alpha unobservable prompt'
        }
      ]);
      eng.pauseSession('tmux-a');
      expect((await eng.lifecycleStates()).find((state) => state.sessionId === 'tmux-a')?.blockedItemCount).toBe(1);
      eng.dispose();
    });

    it('regular delivery already bypasses the busy/ready gate', async () => {
      const eng = opsEngine({ capturePane: async () => 'thinking… (esc to interrupt)' });
      eng.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-f-1', 'human', '@alpha urgent') }, members);
      await waitFor(() => sent.length === 1);
      expect(sent[0].text).toContain('msg-f-1');
      expect(sent[0].text).toContain('notificationId:msg-f-1');
      expect(sent[0].text).toContain('desk channels read ops');
      expect(sent[0].text).not.toContain('@alpha urgent');
      expect((await eng.inspectSession('tmux-a')).queueDepth).toBe(0);
    });

    it('dropMessage removes a single queued item, dropQueue clears all', async () => {
      const eng = opsEngine({ capturePane: async () => 'busy (esc to interrupt)' });
      eng.pauseSession('tmux-a', 'operator hold');
      eng.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-d-1', 'human', '@alpha one') }, members);
      eng.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-d-2', 'human', '@alpha two') }, members);
      await flush();
      const items = (await eng.inspectSession('tmux-a')).items;
      expect(items).toHaveLength(2);
      expect(eng.dropMessage('tmux-a', items[0].seq)).toBe(true);
      expect((await eng.inspectSession('tmux-a')).queueDepth).toBe(1);
      expect(eng.dropMessage('tmux-a', 999999)).toBe(false); // unknown seq
      eng.dropQueue('tmux-a');
      expect((await eng.inspectSession('tmux-a')).queueDepth).toBe(0);
    });

    it('pumpAlive is true while running and false after dispose', () => {
      const eng = opsEngine({});
      expect(eng.pumpAlive()).toBe(true);
      eng.dispose();
      expect(eng.pumpAlive()).toBe(false);
    });
  });

  it('records message/delivery/human-mention activity and notifies every message', async () => {
    const notified: Array<{ channel: string; file: string; author: string; pingsHuman: boolean }> = [];
    const noticing = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      sendText: async () => true,
      sessionRunning: () => true,
      capturePane: async () => '❯ ',
      onChannelMessage: (channel, file, msg, pingsHuman) => notified.push({ channel, file, author: msg.author, pingsHuman })
    });
    noticing.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-7-aaaa', 'alpha', '@human and @beta look') },
      multiMembers
    );
    noticing.handleMessage(
      { channel: 'ops', file: 'thread-msg-7-aaaa.md', message: message('msg-7-bbbb', 'beta', 'plain agent reply') },
      multiMembers
    );
    // Human-authored messages notify too (events feed shows ALL traffic);
    // pingsHuman stays false — the operator does not ping themselves.
    noticing.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-7-cccc', 'human', 'from the operator @human') },
      multiMembers
    );
    await flush();
    expect(notified).toEqual([
      { channel: 'ops', file: 'root.md', author: 'alpha', pingsHuman: true },
      { channel: 'ops', file: 'thread-msg-7-aaaa.md', author: 'beta', pingsHuman: false },
      { channel: 'ops', file: 'root.md', author: 'human', pingsHuman: false }
    ]);
    const kinds = noticing.listActivity().map((event) => event.kind);
    expect(kinds).toContain('message');
    expect(kinds).toContain('human-mention');
    expect(kinds).toContain('delivery');
  });

  it('records a queued activity event when a prompt is accepted into the engine queue', async () => {
    const queued = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      sendText: async () => true,
      sessionRunning: () => true,
      capturePane: async () => '✻ Working… (esc to interrupt)'
    });

    queued.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-queued-1', 'human', '@alpha queued') }, members);
    await flush();

    const event = queued.listActivity().find((entry) => entry.kind === 'queued');
    expect(event).toMatchObject({
      kind: 'queued',
      channel: 'ops',
      file: 'root.md',
      messageId: 'msg-queued-1',
      author: 'human',
      target: 'tmux-a'
    });
    expect(event?.preview).toContain('@alpha queued');
    queued.dispose();
  });

  it('writes queued, delivering, and submitted events to the delivery-history ring', async () => {
    let pane = '❯ ';
    const historical = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 100,
      verifyCycles: 3,
      sendText: async () => {
        pane = '✻ Working… (esc to interrupt)';
        return true;
      },
      sendEnter: async () => true,
      sessionRunning: () => true,
      capturePane: async () => pane
    });

    historical.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-history-1', 'human', '@alpha history') },
      members
    );
    await waitFor(() => readDeliveryEvents(home).some((event) => event.kind === 'delivering'));
    await waitFor(() => readDeliveryEvents(home).some((event) => event.kind === 'submitted'));

    const events = readDeliveryEvents(home);
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(['queued', 'delivering', 'submitted']));
    expect(events.find((event) => event.kind === 'queued')).toMatchObject({
      sessionId: 'tmux-a',
      channel: 'ops',
      messageId: 'msg-history-1',
      preview: '@alpha history'
    });
    expect(events.find((event) => event.kind === 'delivering')).toMatchObject({
      sessionId: 'tmux-a',
      channel: 'ops',
      messageId: 'msg-history-1'
    });
    expect(events.find((event) => event.kind === 'submitted')).toMatchObject({
      sessionId: 'tmux-a',
      channel: 'ops',
      messageId: 'msg-history-1'
    });
    historical.dispose();
  });

  it('writes pause/resume/drop events to the delivery-history ring', async () => {
    const historical = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      sendText: async () => true,
      sessionRunning: () => true,
      capturePane: async () => '✻ Working… (esc to interrupt)'
    });

    historical.pauseSession('tmux-a', 'operator review', '2026-06-18T20:00:00.000Z');
    historical.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-history-2', 'human', '@alpha later') },
      members
    );
    await waitFor(() => historical.queuedItems('tmux-a').length === 1);
    const seq = historical.queuedItems('tmux-a')[0]!.seq;
    expect(historical.dropMessage('tmux-a', seq)).toBe(true);
    historical.resumeSession('tmux-a');

    const events = readDeliveryEvents(home);
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['paused', 'resumed', 'queued', 'dropped'])
    );
    expect(events.find((event) => event.kind === 'paused')).toMatchObject({
      sessionId: 'tmux-a',
      reason: 'operator review'
    });
    expect(events.find((event) => event.kind === 'dropped')).toMatchObject({
      sessionId: 'tmux-a',
      channel: 'ops',
      messageId: 'msg-history-2'
    });
    historical.dispose();
  });

  it('manual pause holds delivery without counting blocked cycles, then resume drains', async () => {
    const pushed: string[] = [];
    let pane = READY_PANE;
    const paused = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 10,
      blockedAfterCycles: 1,
      // slow verify so the test can flip the pane to 'working' after the resume
      // delivery but before verify's first probe (-> 'submitted', not false-stuck)
      enterVerifyDelayMs: 150,
      verifyCycles: 1,
      sendText: async (_session, text) => {
        pushed.push(text);
        return true;
      },
      sessionRunning: () => true,
      // Deterministic transition (no timing race): the pane reads WORKING the
      // instant the prompt is pushed (the agent picked it up), so the resume
      // delivery verifies as 'submitted' and the status reads 'working'.
      capturePane: async () => (pushed.length >= 1 ? WORKING_PANE : pane)
    });

    paused.pauseSession('tmux-a', 'operator review');
    paused.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-paused-1', 'human', '@alpha wait') }, members);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const held = await paused.inspectSession('tmux-a');
    expect(pushed).toEqual([]);
    expect(held.deliveryStatus).toBe('paused');
    expect(held.pausedByOperator).toBe(true);
    expect(held.pauseReason).toBe('operator review');
    expect(held.deliveryBlocked).toBe(false);
    expect(held.blockedCycles).toBeUndefined();

    // Resume drains against the canonical idle snapshot. Raw pane bytes do not
    // alter the activity projection.
    paused.resumeSession('tmux-a');
    await waitFor(() => pushed.length === 1, 1000);
    const released = await paused.inspectSession('tmux-a');
    expect(released.activity).toBe('idle');
    expect(released.deliveryStatus).toBe('ready');
    expect(released.pausedByOperator).toBe(false);
    paused.dispose();
  });

  it('restores a persisted manual pause before draining restored queues after restart', async () => {
    const pushed: string[] = [];
    const seed = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 10,
      sendText: async (_session, text) => {
        pushed.push(text);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => '✻ Working… (esc to interrupt)'
    });
    seed.pauseSession('tmux-a', 'restart hold');
    seed.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-paused-restore', 'human', '@alpha after restart') }, members);
    await flush();
    seed.dispose();
    expect(pushed).toEqual([]);

    persistPausedSession(home, 'tmux-a', 'restart hold', new Date('2026-06-18T20:00:00.000Z'));
    const restored = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 10,
      sendText: async (_session, text) => {
        pushed.push(text);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    const state = (await restored.lifecycleStates()).find((entry) => entry.sessionId === 'tmux-a');
    expect(pushed).toEqual([]);
    expect(state).toMatchObject({
      deliveryStatus: 'paused',
      pausedByOperator: true,
      pauseReason: 'restart hold',
      pausedAt: '2026-06-18T20:00:00.000Z',
      queueDepth: 1
    });

    restored.resumeSession('tmux-a');
    await waitFor(() => pushed.length === 1, 1000);
    restored.dispose();
  });

  it('inspectSession surfaces manifest resume metadata for the resume inspector', async () => {
    const inspected = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      sendText: async () => true,
      sessionRunning: () => true,
      capturePane: async () => '❯ ',
      sessionInfo: (sessionId) =>
        sessionId === 'tmux-a'
          ? {
              sessionName: 'alpha',
              agent: 'opencode',
              cwd: '/workspace/projects/desk',
              resume: 'ses_123abc',
              bypassPermissions: true
            }
          : undefined
    });

    const diag = await inspected.inspectSession('tmux-a');
    expect(diag).toMatchObject({
      sessionName: 'alpha',
      agent: 'opencode',
      cwd: '/workspace/projects/desk',
      resume: 'ses_123abc',
      hasResume: true,
      bypassPermissions: true
    });
    inspected.dispose();
  });

  it('force-pushes notification text while the pane shows a running turn', async () => {
    let pane = '✻ Working… (esc to interrupt)';
    const pushed: string[] = [];
    const gated = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 10,
      sendText: async (_session, text) => {
        pushed.push(text);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => pane
    });
    gated.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-9-aaaa', 'human', '@alpha now') }, members);
    await waitFor(() => pushed.length === 1);
    expect(pushed[0]).toContain('notificationId:msg-9-aaaa');
    expect(pushed[0]).not.toContain('@alpha now');
    pane = '❯ ';
    gated.dispose();
  });

  it('does not need a release signal before force-delivering the next notification', async () => {
    const pushed: string[] = [];
    let pane = READY_PANE;
    const recovering = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 25,
      enterVerifyDelayMs: 100,
      verifyCycles: 1,
      sendText: async (_session, text) => {
        pushed.push(text);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => pane
    });
    recovering.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-10-aaaa', 'human', '@alpha one') }, members);
    await waitFor(() => pushed.length === 1, 1000);
    pane = WORKING_PANE; // agent picks up msg-1 and works
    recovering.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-10-bbbb', 'human', '@alpha two') }, members);
    await waitFor(() => pushed.length === 2, 1500);
    expect(pushed[1]).toContain('msg-10-bbbb');
    recovering.dispose();
  });

  it('reports send-failed and clears the delivering claim so the queue can retry', async () => {
    // Regression for the probe-authoritative refactor: deliverNext sets
    // submitState='delivering' BEFORE the paste. A failed paste never reaches
    // verifySubmitted to resolve that claim — and the drain double-feed guard
    // (submitState==='delivering') would then hold the queue FOREVER (the exact
    // stuck-flag class this refactor removes). The failure path must clear it so
    // the pump's retry can deliver.
    const pushed: string[] = [];
    let failNext = true;
    const flaky = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 1000,
      blockedAfterCycles: 0,
      enterVerifyDelayMs: 5,
      verifyCycles: 1,
      sendText: async (_session, text) => {
        if (failNext) {
          failNext = false;
          return false; // first paste fails — session vanished mid-push
        }
        pushed.push(text);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => READY_PANE
    });
    flaky.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-fail-aaaa', 'human', '@alpha retry me') }, members);
    await waitFor(async () => (await flaky.inspectSession('tmux-a')).blockedReason === 'send-failed');
    expect((await flaky.inspectSession('tmux-a')).blockedReason).toBe('send-failed');
    // The first paste fails; the pump must RETRY and the second paste succeeds.
    // It would never retry if submitState stayed 'delivering' (the guard).
    await flaky.drainReady();
    await waitFor(() => pushed.length === 1, 2000);
    expect(pushed[0]).toContain('msg-fail-aaaa');
    flaky.dispose();
  });

  it('re-sends Enter when the prompt is in the box but the agent stays idle (eaten submit)', async () => {
    // Real shape of an eaten submit: the paste lands (the box now shows text, so
    // the footer changes), but the submit Enter was swallowed, so the agent
    // stays idle. The verify cycle must press Enter — NOT re-paste — until it runs.
    let pane = '❯ ';
    let activity: 'idle' | 'working' = 'idle';
    const enters: string[] = [];
    let pastes = 0;
    const verifying = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 5,
      sendText: async () => {
        pastes += 1;
        pane = '❯ stuck test'; // the paste reaches the input box
        return true;
      },
      sendEnter: async (session) => {
        enters.push(session);
        if (enters.length === 2) {
          activity = 'working';
        }
        return true;
      },
      readAgentStates: async () => canonicalAgentStateBatch(['tmux-a'], { activity }),
      sessionRunning: () => true,
      capturePane: async () => pane
    });
    verifying.enqueuePrompt('tmux-a', 'ops', '@alpha stuck test', 'prompt-11-aaaa');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(enters).toEqual(['tmux-a', 'tmux-a']); // box changed -> Enter retried until busy
    expect(pastes).toBe(1); // delivered once; never re-pasted (the box showed text)
    expect((await verifying.inspectSession('tmux-a')).submitState).toBe('submitted');
    verifying.dispose();
  });

  it('successful notification paste transitions directly to submitted', async () => {
    const sent: string[] = [];
    const enters: string[] = [];
    const states: string[] = [];
    const acked = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 100,
      verifyCycles: 3,
      sendText: async (_session, text) => {
        sent.push(text);
        return true;
      },
      sendEnter: async (session) => {
        enters.push(session);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => '❯ ',
      onSubmitStateChange: (_session, state) => states.push(state)
    });
    acked.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-ack-aaaa', 'human', '@alpha ack me') },
      members
    );
    await waitFor(() => sent.length === 1);
    expect(sent[0]).toContain('notificationId:msg-ack-aaaa');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(states).toEqual(['delivering', 'submitted']);
    expect(enters).toEqual([]);
    expect((await acked.inspectSession('tmux-a')).submitState).toBe('submitted');
    acked.dispose();
  });

  it('notification delivery cannot remain stranded in delivering state', async () => {
    const sent: string[] = [];
    const enters: string[] = [];
    const events: Array<{ state: string; seq: number }> = [];
    const retrying = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 100,
      verifyCycles: 1,
      sendText: async (_session, text) => {
        sent.push(text);
        return true;
      },
      sendEnter: async (session) => {
        enters.push(session);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => '❯ ',
      onSubmitStateChange: (_session, state, context) => events.push({ state, seq: context.seq })
    });
    retrying.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-noack-aaaa', 'human', '@alpha no ack') },
      members
    );
    await waitFor(() => sent.length === 1, 1000);
    expect(sent[0]).toContain('notificationId:msg-noack-aaaa');
    retrying.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-noack-bbbb', 'human', '@alpha no ack again') },
      members
    );
    await waitFor(() => sent.length === 2, 1000);
    expect(enters).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(events.map((event) => event.state)).toEqual(['delivering', 'submitted', 'delivering', 'submitted']);
    expect(events.map((event) => event.seq)).toEqual([1, 1, 2, 2]);
    expect(events.map((event) => event.state)).not.toContain('submit-stuck-submit');
    expect(events.map((event) => event.state)).not.toContain('submit-stuck-paste');
    retrying.dispose();
  });

  it('classifies submit-stuck-paste when nothing ever lands in the box (Enter-only recovery, never re-pastes)', async () => {
    // The paste never reaches the input box (pane never changes from the
    // pre-paste capture) and the agent never goes busy. Recovery stays the safe
    // Enter (a no-op on the empty box) — it must NOT auto re-paste (that would
    // double-deliver) — and the stall is classified stuck-paste for the operator.
    const enters: string[] = [];
    let pastes = 0;
    const stuck = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 1,
      verifyCycles: 3,
      sendText: async () => {
        pastes += 1;
        return true; // returns true but the pane never reflects the text
      },
      sendEnter: async (session) => {
        enters.push(session);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => '❯ ' // idle, unchanged, forever
    });
    stuck.enqueuePrompt('tmux-a', 'ops', '@alpha paste stuck', 'prompt-12-aaaa');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(pastes).toBe(1); // delivered once; NEVER re-pasted (no double delivery)
    expect(enters).toEqual(['tmux-a', 'tmux-a', 'tmux-a']); // safe Enter each cycle
    expect(await stuck.inspectSession('tmux-a')).toMatchObject({
      submitState: 'submit-stuck-paste',
      deliveryBlocked: true,
      blockedReason: 'submit-stuck-paste'
    });
    stuck.dispose();
  });

  it('classifies submit-stuck-submit when the box shows text but it never runs', async () => {
    // The paste lands (footer changes) but every submit Enter is eaten and the
    // agent never goes busy: after the cycle it must be classified stuck-submit,
    // and it must never have been re-pasted.
    let pane = '❯ ';
    const enters: string[] = [];
    let pastes = 0;
    const stuck = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 1,
      verifyCycles: 3,
      sendText: async () => {
        pastes += 1;
        pane = '❯ wedged prompt'; // lands in the box, but never submits
        return true;
      },
      sendEnter: async (session) => {
        enters.push(session);
        return true; // Enter eaten every time
      },
      sessionRunning: () => true,
      capturePane: async () => pane
    });
    stuck.enqueuePrompt('tmux-a', 'ops', '@alpha submit stuck', 'prompt-13-aaaa');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(pastes).toBe(1); // delivered once; never re-pasted (the box did change)
    expect(enters).toEqual(['tmux-a', 'tmux-a', 'tmux-a']); // Enter retried each cycle
    expect(await stuck.inspectSession('tmux-a')).toMatchObject({
      submitState: 'submit-stuck-submit',
      deliveryBlocked: true,
      blockedReason: 'submit-stuck-submit'
    });
    stuck.dispose();
  });

  it('never classifies a shell (bash) member onboarding prompt as submit-stuck-submit', async () => {
    // desk#48 — a bash session is not an agent: it never reports "working", has
    // no input box and no structural approval menu, so the agent-shaped verify
    // cycle can never observe positive evidence. Before the fix EVERY prompt to
    // a shell member landed on submit-stuck-submit by construction (the shell
    // echoes the paste, so the pane always changes), which blocks the queue and
    // writes a false .stuck-submit ack-file next to genuine incidents.
    let pane = '$ ';
    const enters: string[] = [];
    const shell = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 1,
      verifyCycles: 3,
      sessionInfo: () => ({ sessionName: 'bash-1', agent: 'bash' }),
      sendText: async () => {
        // a shell echoes whatever is pasted onto its prompt line
        pane = '$ You have been added to the desk channel #qa-room as @bash-1';
        return true;
      },
      sendEnter: async (session) => {
        enters.push(session);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => pane,
      // real ack-file lifecycle (mirrors channelsApi) so the durable outcome is
      // the one the operator actually sees on disk
      onSubmitStateChange: (session, state, ctx) => {
        if (state === 'delivering') {
          claimDelivering(home, session, ctx.seq);
        } else if (state.startsWith('submit-stuck-')) {
          markStuck(home, session, ctx.seq, state.slice('submit-stuck-'.length) as 'paste' | 'submit' | 'unobservable');
        } else {
          confirmDelivered(home, session, ctx.seq);
        }
      }
    });
    shell.enqueuePrompt(
      'tmux-a',
      'qa-room',
      buildOnboardingPrompt({
        channel: 'qa-room',
        goal: 'manual QA',
        handle: 'bash-1',
        members: [member('bash-2', 'tmux-b', 'bash')],
        messageCount: 0,
        home
      }),
      'onboard-qa-room'
    );
    await waitFor(async () => {
      const state = (await shell.inspectSession('tmux-a')).submitState;
      return state !== undefined && state !== 'delivering';
    });
    const diagnostic = await shell.inspectSession('tmux-a');
    expect(diagnostic.submitState).not.toBe('submit-stuck-submit');
    expect(diagnostic.submitState?.startsWith('submit-stuck-')).toBe(false);
    // and not an agent-shaped success verdict either — a shell has no submit
    // to verify, so the outcome names exactly that
    expect(diagnostic.submitState).toBe('submit-not-applicable');
    expect(diagnostic.deliveryStatus).not.toBe('submit-stuck');
    expect(diagnostic.deliveryBlocked).toBe(false);
    expect(diagnostic.blockedReason).toBeUndefined();
    // no false stuck record on disk (the issue's headline symptom)
    expect(listStuckItems(home, 'tmux-a')).toEqual([]);
    // and no agent-shaped Enter pumping into a shell that already ran the line
    expect(enters).toEqual([]);
    shell.dispose();
  });

  it('still verifies submit for an assistant-CLI session (the shell exemption is agent-specific)', async () => {
    // Guard for desk#48's fix: skipping verification is keyed on the session's
    // agent being a shell, NOT on sessionInfo merely being wired — a claude
    // session with an eaten Enter must still be classified submit-stuck-submit.
    let pane = '❯ ';
    const agentSession = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 1,
      verifyCycles: 3,
      sessionInfo: () => ({ sessionName: 'claude-1', agent: 'claude' }),
      sendText: async () => {
        pane = '❯ wedged prompt';
        return true;
      },
      sendEnter: async () => true,
      sessionRunning: () => true,
      capturePane: async () => pane
    });
    agentSession.enqueuePrompt('tmux-a', 'qa-room', '@alpha submit stuck', 'onboard-qa-room');
    await waitFor(async () => (await agentSession.inspectSession('tmux-a')).submitState === 'submit-stuck-submit');
    expect(await agentSession.inspectSession('tmux-a')).toMatchObject({
      submitState: 'submit-stuck-submit',
      deliveryBlocked: true,
      blockedReason: 'submit-stuck-submit'
    });
    agentSession.dispose();
  });

  it('marks submitState submitted as soon as the agent goes busy', async () => {
    let activity: 'idle' | 'working' = 'idle';
    const ok = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 1,
      verifyCycles: 3,
      sendText: async () => {
        activity = 'working';
        return true;
      },
      sendEnter: async () => true,
      readAgentStates: async () => canonicalAgentStateBatch(['tmux-a'], { activity }),
      sessionRunning: () => true,
      capturePane: async () => 'raw terminal bytes'
    });
    ok.enqueuePrompt('tmux-a', 'ops', '@alpha clean submit', 'prompt-14-aaaa');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await ok.inspectSession('tmux-a')).submitState).toBe('submitted');
    ok.dispose();
  });

  it('fires onSubmitStateChange through delivering then submitted with the item seq', async () => {
    let activity: 'idle' | 'working' = 'idle';
    const events: Array<{ session: string; state: string; seq: number }> = [];
    const cb = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 1,
      verifyCycles: 3,
      sendText: async () => {
        activity = 'working';
        return true;
      },
      sendEnter: async () => true,
      readAgentStates: async () => canonicalAgentStateBatch(['tmux-a'], { activity }),
      sessionRunning: () => true,
      capturePane: async () => 'raw terminal bytes',
      onSubmitStateChange: (session, state, ctx) => events.push({ session, state, seq: ctx.seq })
    });
    cb.enqueuePrompt('tmux-a', 'ops', '@alpha cb test', 'prompt-15-aaaa');
    await waitFor(() => events.some((e) => e.state === 'submitted'));
    expect(events.map((e) => e.state)).toEqual(['delivering', 'submitted']);
    expect(events.every((e) => e.session === 'tmux-a')).toBe(true);
    expect(new Set(events.map((e) => e.seq)).size).toBe(1); // same seq across the lifecycle
    cb.dispose();
  });

  it('fires onSubmitStateChange once per coalesced seq for a digest delivery', async () => {
    let activity: 'idle' | 'working' = 'idle';
    const events: Array<{ state: string; seq: number }> = [];
    const cb = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 25,
      verifyCycles: 1,
      sendText: async () => {
        activity = 'working';
        return true;
      },
      sendEnter: async () => true,
      readAgentStates: async () => canonicalAgentStateBatch(['tmux-a'], { activity }),
      sessionRunning: () => true,
      capturePane: async () => 'raw terminal bytes',
      onSubmitStateChange: (_session, state, ctx) => events.push({ state, seq: ctx.seq })
    });
    cb.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-16-aaaa', 'human', '@alpha one') }, members);
    await waitFor(() => events.some((e) => e.state === 'submitted'));
    cb.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-16-bbbb', 'human', '@alpha two') }, members);
    cb.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-16-cccc', 'human', '@alpha three') }, members);
    await flush();
    activity = 'idle';
    await cb.drainReady();
    await waitFor(() => events.filter((e) => e.state === 'delivering').length >= 3);
    const deliveringSeqs = events.filter((e) => e.state === 'delivering').map((e) => e.seq);
    expect(deliveringSeqs.length).toBe(3); // first verbatim delivery + 2 coalesced in the digest
    expect(new Set(deliveringSeqs).size).toBe(3); // three distinct queue items claimed
    cb.dispose();
  });

  it('force-delivers notifications even when the pane capture is unobservable', async () => {
    const sent: string[] = [];
    const eng = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 10,
      sendText: async (_session, text) => {
        sent.push(text);
        return true;
      },
      sendEnter: async () => true,
      sessionRunning: () => true,
      capturePane: async () => null
    });
    eng.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-d9-aaaa', 'human', 'hi @alpha') }, members);
    await waitFor(() => sent.length === 1);
    expect(sent[0]).toContain('msg-d9-aaaa');
    expect(await eng.inspectSession('tmux-a')).toMatchObject({ activity: 'idle', deliveryStatus: 'ready' });
    eng.dispose();
  });

  it('force-delivers notification text while structural approval menus remain diagnostic', async () => {
    const sent: string[] = [];
    const enters: string[] = [];
    const eng = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 10,
      sendText: async (_session, text) => {
        sent.push(text);
        return true;
      },
      sendEnter: async (session) => {
        enters.push(session);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => 'Allow command rm -rf /tmp/x?\n› Yes\n  No'
    });
    eng.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-d1-aaaa', 'human', 'run it @alpha') }, members);
    await waitFor(() => sent.length === 1);
    expect(sent[0]).toContain('notificationId:msg-d1-aaaa');
    expect(enters).toEqual([]);
    expect(await eng.inspectSession('tmux-a')).toMatchObject({ activity: 'idle', actionable: false });
    eng.dispose();
  });

  it('verify: classifies submit-stuck-unobservable when the pane is unobservable for all verify cycles', async () => {
    // Drain + pre-paste see a ready pane (delivery happens); then capture fails
    // for every verify cycle. No positive observation -> retryable unobservable,
    // NOT a false 'submitted' for retryable unobservable panes.
    let pane: string | null = '❯ ';
    const states: string[] = [];
    const eng = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 1,
      verifyCycles: 3,
      sendText: async () => {
        pane = null;
        return true;
      },
      sendEnter: async () => true,
      sessionRunning: () => true,
      capturePane: async () => pane,
      onSubmitStateChange: (_session, state) => states.push(state)
    });
    eng.enqueuePrompt('tmux-a', 'ops', 'hi @alpha', 'prompt-un-aaaa');
    await waitFor(() => states.includes('submit-stuck-unobservable'));
    expect(states).toContain('submit-stuck-unobservable');
    expect(states).not.toContain('submitted'); // never falsely marked delivered
    eng.dispose();
  });

  it('verify: canonical operator wait confirms submission without pressing Enter', async () => {
    let activity: 'idle' | 'blocked' = 'idle';
    const enters: string[] = [];
    const states: string[] = [];
    const eng = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 1,
      verifyCycles: 3,
      sendText: async () => {
        activity = 'blocked';
        return true;
      },
      sendEnter: async (session) => {
        enters.push(session);
        return true;
      },
      readAgentStates: async () =>
        canonicalAgentStateBatch(['tmux-a'], {
          activity,
          waitOwner: 'operator',
          waitKind: 'approval'
        }),
      sessionRunning: () => true,
      capturePane: async () => 'Allow command?\n› Yes\n  No',
      onSubmitStateChange: (_session, state) => states.push(state)
    });
    eng.enqueuePrompt('tmux-a', 'ops', 'go @alpha', 'prompt-menu-aaaa');
    await waitFor(() => states.includes('submitted'));
    expect(states).toContain('submitted');
    expect(enters).toEqual([]);
    expect(await eng.inspectSession('tmux-a')).toMatchObject({
      activity: 'blocked',
      actionable: true,
      waitOwner: 'operator',
      waitKind: 'approval'
    });
    eng.dispose();
  });

  it('channel notifications do not create unobservable stuck replay loops', async () => {
    let pane: string | null = '❯ ';
    let deliveries = 0;
    const sent: string[] = [];
    const eng = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 2,
      verifyCycles: 2,
      pumpIntervalMs: 15,
      sendText: async (_session, text) => {
        sent.push(text);
        deliveries += 1;
        if (deliveries === 1) {
          // First delivery: the pane goes unobservable for the verify window
          // (drives submit-stuck-unobservable + the live re-enqueue), then recovers.
          // State-var (not a call counter) so reconcileBusy's probes can't perturb it.
          pane = null;
          setTimeout(() => {
            pane = '❯ ';
          }, 40);
        }
        return true;
      },
      sendEnter: async () => true,
      sessionRunning: () => true,
      capturePane: async () => pane,
      // wire the real ack-file lifecycle (mirrors channelsApi) so the live re-enqueue
      // operates on a genuine .delivering -> .stuck-unobservable -> .json transition
      onSubmitStateChange: (session, state, ctx) => {
        if (state === 'delivering') claimDelivering(home, session, ctx.seq);
        else if (state === 'submitted') confirmDelivered(home, session, ctx.seq);
        else if (state === 'submit-stuck-submit') markStuck(home, session, ctx.seq, 'submit');
        else if (state === 'submit-stuck-paste') markStuck(home, session, ctx.seq, 'paste');
        else if (state === 'submit-stuck-unobservable') markStuck(home, session, ctx.seq, 'unobservable');
      }
    });
    eng.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-live-aaaa', 'human', 'hi @alpha') }, members);
    await waitFor(() => sent.length === 1, 3000);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sent).toHaveLength(1);
    expect((await eng.inspectSession('tmux-a')).deliveryBlocked).toBe(false);
    expect(listStuckItems(home, 'tmux-a')).toEqual([]);
    eng.dispose();
  });

  it('forceDeliver revives a durable stuck item when the runtime queue is empty', async () => {
    ensureQueueDir(home, 'tmux-a');
    const seq = 7;
    writeFileSync(
      join(home, '_engine', 'queue', 'tmux-a', `${String(seq).padStart(10, '0')}.${EXT_STUCK_SUBMIT}`),
      JSON.stringify({
        seq,
        channel: 'ops',
        messageId: 'msg-stuck-7',
        author: 'human',
        prompt: 'revive me @alpha',
        queuedAt: '2026-06-18T00:00:00.000Z',
        kind: 'message',
        file: 'root.md'
      })
    );
    const sent: string[] = [];
    const eng = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 50,
      sendText: async (_session, text) => {
        sent.push(text);
        return true;
      },
      sendEnter: async () => true,
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
    // The stuck file is NOT in the runtime queue (restore preserves .stuck-submit).
    // forceDeliver must revive it (retryStuckItem -> .json -> enqueue) and deliver.
    const ok = await eng.forceDeliver('tmux-a');
    expect(ok).toBe(true);
    expect(sent.some((t) => t.includes('revive me'))).toBe(true);
    eng.dispose();
  });

  it('inspectSession treats legacy durable stuck files as inert history', async () => {
    ensureQueueDir(home, 'tmux-a');
    const mk = (seq: number, ext: string): void =>
      writeFileSync(
        join(home, '_engine', 'queue', 'tmux-a', `${String(seq).padStart(10, '0')}.${ext}`),
        JSON.stringify({
          seq,
          channel: 'ops',
          messageId: `msg-${seq}`,
          author: 'human',
          prompt: `body ${seq}`,
          queuedAt: '2026-06-18T00:00:00.000Z',
          kind: 'message',
          file: 'root.md'
        })
      );
    mk(2, 'stuck-paste');
    mk(5, 'stuck-submit');
    const eng = new ChannelsEngine({
      sendText: async () => true,
      sendEnter: async () => true,
      home,
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
    const diag = await eng.inspectSession('tmux-a');
    expect(diag.blockedItems).toEqual([]);
    expect(diag.deliveryBlocked).toBe(false);
    expect(listStuckItems(home, 'tmux-a').map((b) => [b.seq, b.kind])).toEqual([
      [2, 'paste'],
      [5, 'submit']
    ]);
    eng.dispose();
  });

  it('restore re-enqueues a .stuck-unobservable item at least once', async () => {
    ensureQueueDir(home, 'tmux-a');
    const seq = 3;
    writeFileSync(
      join(home, '_engine', 'queue', 'tmux-a', `${String(seq).padStart(10, '0')}.stuck-unobservable`),
      JSON.stringify({
        seq,
        channel: 'ops',
        messageId: 'msg-restore-3',
        author: 'human',
        prompt: 'restore me @alpha',
        queuedAt: '2026-06-18T00:00:00.000Z',
        kind: 'message',
        file: 'root.md'
      })
    );
    const sent: string[] = [];
    const eng = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 20,
      sendText: async (_session, text) => {
        sent.push(text);
        return true;
      },
      sendEnter: async () => true,
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
    // restoreQueues (constructor) re-enqueues .stuck-unobservable like .delivering.
    await waitFor(() => sent.some((t) => t.includes('restore me')), 2000);
    expect(sent.some((t) => t.includes('restore me'))).toBe(true);
    eng.dispose();
  });

  it('forceDeliver(seq) revives and delivers a specific durable stuck item, not the head, no digest', async () => {
    ensureQueueDir(home, 'tmux-a');
    const mk = (seq: number, ext: string, prompt: string): void =>
      writeFileSync(
        join(home, '_engine', 'queue', 'tmux-a', `${String(seq).padStart(10, '0')}.${ext}`),
        JSON.stringify({
          seq,
          channel: 'ops',
          messageId: `msg-${seq}`,
          author: 'human',
          prompt,
          queuedAt: '2026-06-18T00:00:00.000Z',
          kind: 'message',
          file: 'root.md'
        })
      );
    mk(2, 'stuck-submit', 'older stuck @alpha');
    mk(8, 'stuck-paste', 'target stuck @alpha');
    const sent: string[] = [];
    const eng = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 1000,
      sendText: async (_session, text) => {
        sent.push(text);
        return true;
      },
      sendEnter: async () => true,
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
    // Force the NON-head stuck item (seq 8; the head stuck is seq 2).
    const ok = await eng.forceDeliver('tmux-a', 8);
    expect(ok).toBe(true);
    expect(sent.some((t) => t.includes('target stuck'))).toBe(true); // seq 8 delivered
    expect(sent.some((t) => t.includes('older stuck'))).toBe(false); // seq 2 NOT delivered (no digest, not head)
    expect(listStuckItems(home, 'tmux-a').some((b) => b.seq === 2)).toBe(true); // seq 2 still stuck on disk
    eng.dispose();
  });

  it('Lifecycle: lifecycleStates ignores legacy durable stuck files for delivery status', async () => {
    ensureQueueDir(home, 'tmux-a');
    writeFileSync(
      join(home, '_engine', 'queue', 'tmux-a', `${String(3).padStart(10, '0')}.stuck-submit`),
      JSON.stringify({ seq: 3, channel: 'ops', messageId: 'm3', author: 'human', prompt: 'p', queuedAt: '2026-06-18T00:00:00.000Z', kind: 'message', file: 'root.md' })
    );
    const eng = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      sendText: async () => true,
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
    const ls = (await eng.lifecycleStates()).find((s) => s.sessionId === 'tmux-a');
    expect(ls?.activity).toBe('idle');
    expect(ls?.deliveryStatus).toBe('ready');
    expect(ls?.deliveryBlocked).toBe(false);
    expect(ls?.blockedItemCount).toBe(0);
    eng.dispose();
  });

  it('Lifecycle guard: unobservable panes do not create delivery blocks for notifications', async () => {
    const eng = new ChannelsEngine({
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 8,
      blockedAfterCycles: 3,
      sendText: async () => true,
      sendEnter: async () => true,
      sessionRunning: () => true,
      capturePane: async () => '' // empty-capture -> drain holds, never ready
    });
    eng.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-grd-aaaa', 'human', 'hi @alpha') }, members);
    await waitFor(async () => (await eng.lifecycleStates()).find((s) => s.sessionId === 'tmux-a')?.queueDepth === 0);
    const early = (await eng.lifecycleStates()).find((s) => s.sessionId === 'tmux-a');
    expect(early?.deliveryBlocked).toBe(false);
    expect(early?.activity).toBe('idle');
    eng.dispose();
  });

  it('dispatch dedupe: re-discovered messages never enqueue or deliver twice', async () => {
    const incoming = { channel: 'ops', file: 'root.md', message: message('msg-12-aaaa', 'human', '@alpha once') };
    engine.handleMessage(incoming, members);
    engine.handleMessage(incoming, members); // watcher rescan / second path
    await flush();
    await engine.drainReady();
    expect(sent).toHaveLength(1);
    expect((await engine.lifecycleStates()).find((state) => state.sessionId === 'tmux-a')?.queueDepth).toBe(0);
  });

  it('single-engine guard: a second engine for the same home goes passive', async () => {
    const lockedHome = mkdtempSync(join(tmpdir(), 'desk-chan-lock-'));
    const owner = new ChannelsEngine({
      sendEnter: async () => true,
      home: lockedHome,
      pid: 100,
      pidAlive: () => true,
      sendText: async () => true,
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
    const intruderSent: string[] = [];
    const intruder = new ChannelsEngine({
      sendEnter: async () => true,
      home: lockedHome,
      pid: 200,
      pidAlive: (pid) => pid === 100, // owner alive
      sendText: async (_s, text) => {
        intruderSent.push(text);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
    expect(owner.passive).toBe(false);
    expect(intruder.passive).toBe(true);
    intruder.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-13-aaaa', 'human', '@alpha hi') }, members);
    await flush();
    expect(intruderSent).toHaveLength(0);

    // Dead owner: the next engine takes over.
    const successor = new ChannelsEngine({
      sendEnter: async () => true,
      home: lockedHome,
      pid: 300,
      pidAlive: () => false,
      sendText: async () => true,
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
    expect(successor.passive).toBe(false);
    owner.dispose();
    intruder.dispose();
    successor.dispose();
    rmSync(lockedHome, { recursive: true, force: true });
  });

  it('single-engine guard: corrupt engine.pid fails closed instead of dispatching as owner', async () => {
    const lockedHome = mkdtempSync(join(tmpdir(), 'desk-chan-lock-corrupt-'));
    mkdirSync(join(lockedHome, '_engine', 'engine.pid'), { recursive: true });
    const pushed: string[] = [];
    const engine = new ChannelsEngine({
      sendEnter: async () => true,
      home: lockedHome,
      pid: 400,
      sendText: async (_session, text) => {
        pushed.push(text);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });

    expect(engine.passive).toBe(true);
    expect(engine.lockError).toMatch(/engine\.pid/i);
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-lock-corrupt', 'human', '@alpha hi') }, members);
    await flush();
    expect(pushed).toHaveLength(0);

    engine.dispose();
    rmSync(lockedHome, { recursive: true, force: true });
  });

  it('annotates prompts that sat in the queue past the staleness window', async () => {
    const pushed: string[] = [];
    const stale = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      staleAfterMs: -1, // everything counts as stale (age 0 included)
      enterVerifyDelayMs: 1,
      sendText: async (_s, text) => {
        pushed.push(text);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
    stale.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-14-aaaa', 'human', '@alpha old news') }, members);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pushed[0]).toMatch(/^\(delayed delivery — this message was posted \d+ minutes ago/);
    stale.dispose();
  });

  it('builds notification-only turn prompts pointing at the conversation file', () => {
    const prompt = buildTurnPrompt({
      channel: 'ops',
      file: 'thread-msg-1-aaaa.md',
      member: 'beta',
      author: 'alpha',
      message: message('msg-8-bbbb', 'alpha', 'inspect the relay'),
      home: '/home/x/.config/desk/channels'
    });
    expect(prompt).toContain('[#ops] New message from @alpha (msg-8-bbbb) — you are @beta.');
    expect(prompt).toContain('notificationId:msg-8-bbbb');
    expect(prompt).toContain('1 new message from @alpha');
    expect(prompt).toContain('Read message: desk channels read ops --message msg-8-bbbb');
    expect(prompt).toContain('Read full conversation: desk channels read ops');
    expect(prompt).not.toContain('inspect the relay');
    expect(prompt).toContain('/home/x/.config/desk/channels/ops/thread-msg-1-aaaa.md');
    expect(prompt).toContain('desk channels post ops --thread msg-1-aaaa');
    expect(prompt).toContain('never @beta');
    // active-collaboration contract with the anti-loop exception
    expect(prompt).toContain('post your outcome to the channel');
    expect(prompt).toContain('never acknowledge acknowledgments');
  });

  it('builds an onboarding briefing with roster, CLI usage and the collaboration contract', () => {
    const prompt = buildOnboardingPrompt({
      channel: 'ops',
      goal: 'keep the ship flying',
      handle: 'beta',
      members: [member('alpha', 'tmux-a'), member('beta', 'tmux-b'), { ...member('human', '', 'human'), sessionId: undefined }],
      messageCount: 7,
      home: '/home/x/.config/desk/channels'
    });
    expect(prompt).toContain('added to the desk channel #ops as @beta');
    expect(prompt).toContain('Channel goal: keep the ship flying');
    expect(prompt).toContain('@alpha (claude-code)');
    expect(prompt).toContain('@human (human operator)');
    expect(prompt).not.toContain('@beta ('); // own handle excluded from the roster line
    expect(prompt).toContain('desk channels post ops --as beta');
    expect(prompt).toContain('(7 messages so far)');
    expect(prompt).toContain('Do not go silent.');
    expect(prompt).toContain('introducing yourself');
  });

  // What still holds the queue is LIFECYCLE, not activity: a session that has
  // not finished starting has no process to accept the text, so the prompt
  // waits and is delivered once it is running. Nothing is dropped, which is the
  // difference between this and the activity gate that was removed.
  it('enqueuePrompt waits while the session is STARTING, then releases once running', async () => {
    let lifecycle: 'starting' | 'running' = 'starting';
    const pushed: string[] = [];
    const onboarding = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 10,
      blockedAfterCycles: 1,
      enterVerifyDelayMs: 1,
      sendText: async (_s, text) => {
        pushed.push(text);
        return true;
      },
      readAgentStates: async () => canonicalAgentStateBatch(['tmux-a'], { lifecycle }),
      sessionRunning: () => true,
      capturePane: async () => 'raw terminal bytes'
    });
    onboarding.enqueuePrompt('tmux-a', 'ops', 'welcome aboard @alpha', 'onboard-ops');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(pushed).toEqual([]);
    expect((await onboarding.inspectSession('tmux-a')).blockedReason).toBe('booting');
    lifecycle = 'running';
    await onboarding.drainReady();
    await waitFor(() => pushed.length === 1);
    expect(pushed).toEqual(['welcome aboard @alpha']);
    onboarding.dispose();
  });

  it('reports offline while an exited session cannot receive queued prompts', async () => {
    const pushed: string[] = [];
    const offline = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 10,
      blockedAfterCycles: 1,
      sendText: async (_session, text) => {
        pushed.push(text);
        return true;
      },
      readAgentStates: async () => canonicalAgentStateBatch(['tmux-a'], { lifecycle: 'exited' }),
      sessionRunning: () => false,
      capturePane: async () => 'raw terminal bytes'
    });
    offline.enqueuePrompt('tmux-a', 'ops', 'wait for restart', 'offline-prompt');
    await waitFor(async () => (await offline.inspectSession('tmux-a')).blockedReason === 'offline');
    expect((await offline.inspectSession('tmux-a')).blockedReason).toBe('offline');
    expect(pushed).toEqual([]);
    offline.dispose();
  });

  it('marks native prompts submitted after broker injection without tmux verification', async () => {
    const pushed: string[] = [];
    const native = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 10,
      sendText: async (_session, text) => {
        pushed.push(text);
        return true;
      },
      sessionInfo: () => ({ uiMode: 'native' }),
      sessionRunning: () => true,
      capturePane: async () => {
        throw new Error('native delivery must not inspect tmux');
      }
    });
    native.enqueuePrompt('tmux-a', 'ops', 'native onboarding', 'native-onboard');
    await waitFor(() => pushed.length === 1);
    await waitFor(async () => (await native.lifecycleStates())[0]?.submitState === 'submitted');
    expect(pushed).toEqual(['native onboarding']);
    native.dispose();
  });

});

describe('channels store', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-chan-store-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('creates channels, appends messages, and reads them back', async () => {
    createChannel(home, 'ops', 'keep the ship flying');
    const appended = await appendMessage(home, 'ops', { author: 'human', body: 'hello crew' });
    expect(appended.file).toBe('root.md');
    const detail = readChannelDetail(home, 'ops');
    expect(detail.goal).toBe('keep the ship flying');
    expect(detail.messages.map((entry) => entry.body)).toEqual(['hello crew']);
    expect(listChannels(home)[0]).toMatchObject({ name: 'ops', messageCount: 1 });
  });

  it('changes the channel content revision for root-message add, edit, and delete', async () => {
    createChannel(home, 'ops', 'goal');

    const initialSummary = listChannels(home)[0];
    const initialDetail = readChannelDetail(home, 'ops');
    expect(initialSummary.contentRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(initialDetail.contentRevision).toBe(initialSummary.contentRevision);

    const first = await appendMessage(home, 'ops', { author: 'human', body: 'first' });
    const afterAppend = listChannels(home)[0].contentRevision;
    expect(afterAppend).not.toBe(initialSummary.contentRevision);
    expect(readChannelDetail(home, 'ops').contentRevision).toBe(afterAppend);

    const rootFile = join(home, 'ops', 'root.md');
    const watcher = new ChannelsWatcher(home, () => undefined);
    watcher.prewarm();
    writeFileSync(rootFile, readFileSync(rootFile, 'utf8').replace('first', 'other'));
    watcher.scanFile('ops', 'root.md');
    const afterExternalEdit = listChannels(home)[0].contentRevision;
    expect(afterExternalEdit).not.toBe(afterAppend);
    expect(readChannelDetail(home, 'ops').contentRevision).toBe(afterExternalEdit);
    watcher.stop();

    await editMessage(home, 'ops', 'root.md', first.message.id, 'edited');
    const afterEdit = listChannels(home)[0].contentRevision;
    expect(afterEdit).not.toBe(afterExternalEdit);
    expect(readChannelDetail(home, 'ops').contentRevision).toBe(afterEdit);

    await deleteMessage(home, 'ops', 'root.md', first.message.id);
    const afterDelete = listChannels(home)[0].contentRevision;
    expect(afterDelete).not.toBe(afterEdit);
    expect(readChannelDetail(home, 'ops').contentRevision).toBe(afterDelete);
    expect(listChannels(home)[0].contentRevision).toBe(afterDelete);
  });

  it('creates thread files and back-links the parent message', async () => {
    createChannel(home, 'ops', 'goal');
    const parent = await appendMessage(home, 'ops', { author: 'human', body: 'root question' });
    await appendMessage(home, 'ops', { author: 'claude', body: 'thread answer', threadParentId: parent.message.id });
    await appendMessage(home, 'ops', { author: 'codex', body: 'second answer', threadParentId: parent.message.id });
    const replies = readThread(home, 'ops', parent.message.id);
    expect(replies.map((entry) => entry.body)).toEqual(['thread answer', 'second answer']);
    const detail = readChannelDetail(home, 'ops');
    expect(detail.messages[0].threadFile).toBe(`thread-${parent.message.id}.md`);
    expect(detail.messages[0].threadReplies).toBe(2);
  });

  it('watcher dispatches only unseen finalised messages (prewarm skips history)', async () => {
    createChannel(home, 'ops', 'goal');
    await appendMessage(home, 'ops', { author: 'human', body: 'historic' });

    const incoming: string[] = [];
    const watcher = new ChannelsWatcher(home, (event) => incoming.push(event.message.id));
    watcher.prewarm();
    watcher.scanFile('ops', 'root.md');
    expect(incoming).toEqual([]); // history is pre-warmed, not re-dispatched

    const fresh = await appendMessage(home, 'ops', { author: 'claude', body: 'new arrival' });
    watcher.scanFile('ops', 'root.md');
    watcher.scanFile('ops', 'root.md');
    expect(incoming).toEqual([fresh.message.id]); // seen-set dedupes the second scan
  });

  it('surfaces chokidar watcher errors instead of dropping them blind', () => {
    createChannel(home, 'ops', 'goal');
    const errors: Error[] = [];
    const watcher = new ChannelsWatcher(home, () => undefined, 30_000, (error) => errors.push(error));
    watcher.start();
    const internal = watcher as unknown as { watcher?: { emit(event: string, error: Error): void } };

    internal.watcher?.emit('error', new Error('watch backend failed'));

    expect(errors.map((error) => error.message)).toEqual(['watch backend failed']);
    watcher.stop();
  });

  it('watcher leaves a message retryable when dispatch throws', async () => {
    createChannel(home, 'ops', 'goal');
    await appendMessage(home, 'ops', { author: 'human', body: 'historic' });

    const incoming: string[] = [];
    const watcher = new ChannelsWatcher(home, (event) => {
      incoming.push(event.message.id);
      if (incoming.length === 1) {
        throw new Error('transient dispatch failure');
      }
    });
    watcher.prewarm();
    const fresh = await appendMessage(home, 'ops', { author: 'claude', body: 'retry me' });

    expect(() => watcher.scanFile('ops', 'root.md')).toThrow('transient dispatch failure');
    expect(watcher.hasSeen('ops', 'root.md', fresh.message.id)).toBe(false);

    watcher.scanFile('ops', 'root.md');
    expect(incoming).toEqual([fresh.message.id, fresh.message.id]);
    expect(watcher.hasSeen('ops', 'root.md', fresh.message.id)).toBe(true);
  });

  it('edits a message body in place, preserving id/author/order and thread links', async () => {
    createChannel(home, 'ops', 'goal');
    const first = await appendMessage(home, 'ops', { author: 'human', body: 'original' });
    const second = await appendMessage(home, 'ops', { author: 'claude', body: 'reply' });
    await appendMessage(home, 'ops', { author: 'codex', body: 'in thread', threadParentId: first.message.id });

    const edited = await editMessage(home, 'ops', 'root.md', first.message.id, 'corrected text');
    expect(edited.body).toBe('corrected text');

    const detail = readChannelDetail(home, 'ops');
    expect(detail.messages.map((entry) => [entry.id, entry.body])).toEqual([
      [first.message.id, 'corrected text'],
      [second.message.id, 'reply']
    ]);
    // Thread link survives the rewrite, and repeated edits stay stable.
    expect(detail.messages[0].threadFile).toBe(`thread-${first.message.id}.md`);
    await editMessage(home, 'ops', 'root.md', first.message.id, 'corrected again');
    const again = readChannelDetail(home, 'ops');
    expect(again.messages).toHaveLength(2);
    expect(again.messages[0].threadFile).toBe(`thread-${first.message.id}.md`);
    expect(again.goal).toBe('goal');
  });

  it('deletes messages; deleting a parent removes its thread file', async () => {
    createChannel(home, 'ops', 'goal');
    const parent = await appendMessage(home, 'ops', { author: 'human', body: 'parent' });
    const other = await appendMessage(home, 'ops', { author: 'claude', body: 'stays' });
    const reply = await appendMessage(home, 'ops', { author: 'codex', body: 'reply', threadParentId: parent.message.id });

    // Deleting a thread reply refreshes the parent's reply count.
    await deleteMessage(home, 'ops', `thread-${parent.message.id}.md`, reply.message.id);
    expect(readThread(home, 'ops', parent.message.id)).toHaveLength(0);
    expect(readChannelDetail(home, 'ops').messages[0].threadReplies).toBe(0);

    await deleteMessage(home, 'ops', 'root.md', parent.message.id);
    const detail = readChannelDetail(home, 'ops');
    expect(detail.messages.map((entry) => entry.id)).toEqual([other.message.id]);
    expect(readThread(home, 'ops', parent.message.id)).toEqual([]);
    await expect(deleteMessage(home, 'ops', 'root.md', parent.message.id)).rejects.toThrow(/not found/);
  });

  it('edits the channel goal in the preamble', async () => {
    createChannel(home, 'ops', 'old goal');
    await appendMessage(home, 'ops', { author: 'human', body: 'hello' });
    editChannelGoal(home, 'ops', 'new goal');
    const detail = readChannelDetail(home, 'ops');
    expect(detail.goal).toBe('new goal');
    expect(detail.messages).toHaveLength(1);
  });

  it('rejects oversized message bodies', async () => {
    createChannel(home, 'ops', 'goal');
    const oversized = 'x'.repeat(MAX_MESSAGE_BYTES + 1);
    await expect(appendMessage(home, 'ops', { author: 'human', body: oversized })).rejects.toThrow(/exceeds/);
    const ok = await appendMessage(home, 'ops', { author: 'human', body: 'fits fine' });
    await expect(editMessage(home, 'ops', 'root.md', ok.message.id, oversized)).rejects.toThrow(/exceeds/);
  });

  it('sweep reconciliation dispatches messages whose fs events were missed', async () => {
    createChannel(home, 'ops', 'goal');
    await appendMessage(home, 'ops', { author: 'human', body: 'historic' });

    const incoming: string[] = [];
    const watcher = new ChannelsWatcher(home, (event) => incoming.push(event.message.id));
    watcher.prewarm();
    watcher.sweepNow(); // primes mtimes; history already seen
    expect(incoming).toEqual([]);

    // Simulate a missed inotify event: the file changes, no watcher callback.
    // (File mtimes use the kernel's coarse clock — step past the current tick
    // so the append lands with a different timestamp than the primed one.)
    await new Promise((resolve) => setTimeout(resolve, 25));
    const fresh = await appendMessage(home, 'ops', { author: 'claude', body: 'event was dropped' });
    watcher.sweepNow();
    expect(incoming).toEqual([fresh.message.id]);
    watcher.sweepNow(); // unchanged mtime → no rescan, no duplicate
    expect(incoming).toEqual([fresh.message.id]);
    watcher.stop();
  });

  it('caps a session queue at 50, dropping the oldest prompts', async () => {
    const capMembers = [member('alpha', 'tmux-a')];
    const blocked = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      sendText: async () => true,
      readAgentStates: async () => canonicalAgentStateBatch(['tmux-a'], { activity: 'working' }),
      sessionRunning: () => false, // nothing ever delivers — queue only grows
      capturePane: async () => '❯ '
    });
    for (let index = 0; index < 60; index += 1) {
      blocked.handleMessage(
        { channel: 'ops', file: 'root.md', message: message(`msg-cap-${String(index).padStart(4, '0')}`, 'human', '@alpha go') },
        capMembers
      );
    }
    await flush();
    const state = (await blocked.lifecycleStates()).find((entry) => entry.sessionId === 'tmux-a');
    expect(state?.queueDepth).toBe(50);
    expect((await blocked.inspectSession('tmux-a')).droppedQueueItems).toBe(10);
    blocked.dispose();
  });

  it('rejects invalid channel names and empty bodies', async () => {
    expect(() => createChannel(home, 'Bad Name', 'x')).toThrow();
    createChannel(home, 'ops', 'goal');
    await expect(appendMessage(home, 'ops', { author: 'human', body: '  ' })).rejects.toThrow(/empty/);
    await expect(appendMessage(home, 'nope', { author: 'human', body: 'x' })).rejects.toThrow(/not found/);
  });
});

describe('engine drain race safety', () => {
  it('does not double-deliver when signals arrive mid-push', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-chan-race-'));
    const sent: string[] = [];
    let resolvePush: (() => void) | null = null;
    const engine = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      sendText: (session, text) =>
        new Promise((resolve) => {
          sent.push(text);
          resolvePush = () => resolve(true);
        }),
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
    const members = [member('alpha', 'tmux-a')];
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-1-aaaa', 'human', '@alpha go') }, members);
    await flush();
    // Concurrent drain nudges while the push is still in flight must not re-enter.
    await engine.drainReady();
    await engine.drainReady();
    await flush();
    expect(sent).toHaveLength(1);
    resolvePush?.();
    await flush();
    expect(sent).toHaveLength(1);
    rmSync(home, { recursive: true, force: true });
  });

  it('does not reclaim a watchdog drain while the physical paste is in flight', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-chan-watchdog-'));
    const sent: string[] = [];
    let resolvePush: (() => void) | null = null;
    const engine = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 5,
      blockedAfterCycles: 1,
      drainWatchdogMs: 10,
      sendText: async (_session, text) => {
        sent.push(text);
        await new Promise<boolean>((resolve) => {
          resolvePush = () => resolve(true);
        });
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
    const members = [member('alpha', 'tmux-a')];
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-watchdog', 'human', '@alpha go') }, members);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    let observedBlockReason: string | undefined;
    await waitFor(async () => {
      observedBlockReason = (await engine.inspectSession('tmux-a')).blockedReason;
      return observedBlockReason !== undefined;
    });
    expect(observedBlockReason).toBe('draining');
    await engine.drainReady();
    await flush();
    expect(sent).toHaveLength(1);
    resolvePush?.();
    await flush();
    expect(sent).toHaveLength(1);
    engine.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  it('does not force-deliver while the physical paste is in flight past the watchdog', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-chan-force-watchdog-'));
    const sent: string[] = [];
    let resolvePush: (() => void) | undefined;
    const engine = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      drainWatchdogMs: 10,
      sendText: async (_session, text) => {
        sent.push(text);
        if (sent.length === 1) {
          await new Promise<void>((resolve) => {
            resolvePush = resolve;
          });
        }
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
    const members = [member('alpha', 'tmux-a')];
    try {
      engine.handleMessage(
        { channel: 'ops', file: 'root.md', message: message('msg-force-watchdog', 'human', '@alpha go') },
        members
      );
      await waitFor(() => sent.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(await engine.forceDeliver('tmux-a')).toBe(false);
      expect(sent).toHaveLength(1);
    } finally {
      resolvePush?.();
      await flush();
      engine.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('invalidates a stale gated drain before force-delivering another queued item', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-chan-force-generation-'));
    const sent: string[] = [];
    let captureCalls = 0;
    let resolveFirstCapture: ((pane: string) => void) | undefined;
    let markFirstCaptureStarted: (() => void) | undefined;
    const firstCaptureStarted = new Promise<void>((resolve) => {
      markFirstCaptureStarted = resolve;
    });
    const engine = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 60_000,
      drainWatchdogMs: 10,
      sendText: async (_session, text) => {
        sent.push(text);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => {
        captureCalls += 1;
        if (captureCalls === 1) {
          markFirstCaptureStarted?.();
          return new Promise<string>((resolve) => {
            resolveFirstCapture = resolve;
          });
        }
        return '❯ ';
      }
    });
    try {
      engine.enqueuePrompt('tmux-a', 'ops', 'first prompt', 'prompt-force-first');
      await firstCaptureStarted;
      engine.enqueuePrompt('tmux-a', 'ops', 'second prompt', 'prompt-force-second');
      const targetSeq = engine.queuedItems('tmux-a').at(-1)?.seq;
      expect(targetSeq).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(await engine.forceDeliver('tmux-a', targetSeq)).toBe(true);
      expect(sent).toEqual(['second prompt']);

      resolveFirstCapture?.('❯ ');
      await flush();
      expect(sent).toEqual(['second prompt']);
    } finally {
      resolveFirstCapture?.('❯ ');
      await flush();
      engine.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps a newer forced paste single-flight when a stale gated drain settles', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-chan-force-stale-finally-'));
    const sent: string[] = [];
    let captureCalls = 0;
    let resolveFirstCapture: ((pane: string) => void) | undefined;
    let markFirstCaptureStarted: (() => void) | undefined;
    let resolveForcedPaste: (() => void) | undefined;
    const firstCaptureStarted = new Promise<void>((resolve) => {
      markFirstCaptureStarted = resolve;
    });
    const engine = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 60_000,
      drainWatchdogMs: 10,
      sendText: async (_session, text) => {
        sent.push(text);
        if (sent.length === 1) {
          await new Promise<void>((resolve) => {
            resolveForcedPaste = resolve;
          });
        }
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => {
        captureCalls += 1;
        if (captureCalls === 1) {
          markFirstCaptureStarted?.();
          return new Promise<string>((resolve) => {
            resolveFirstCapture = resolve;
          });
        }
        return '❯ ';
      }
    });
    try {
      engine.enqueuePrompt('tmux-a', 'ops', 'first prompt', 'prompt-stale-first');
      await firstCaptureStarted;
      engine.enqueuePrompt('tmux-a', 'ops', 'second prompt', 'prompt-stale-second');
      const targetSeq = engine.queuedItems('tmux-a').at(-1)?.seq;
      expect(targetSeq).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const forced = engine.forceDeliver('tmux-a', targetSeq);
      await waitFor(() => sent.length === 1);
      resolveFirstCapture?.('❯ ');
      await flush();

      expect(await engine.forceDeliver('tmux-a')).toBe(false);
      expect(sent).toEqual(['second prompt']);
      resolveForcedPaste?.();
      expect(await forced).toBe(true);
    } finally {
      resolveFirstCapture?.('❯ ');
      resolveForcedPaste?.();
      await flush();
      engine.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not apply a stale prompt-gate decision after the queue head changes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desk-chan-gate-race-'));
    const sent: string[] = [];
    let releaseFirstCapture: ((pane: string) => void) | undefined;
    let markFirstCaptureStarted: (() => void) | undefined;
    const firstCaptureStarted = new Promise<void>((resolve) => {
      markFirstCaptureStarted = resolve;
    });
    let firstCapture = true;
    const engine = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      pumpIntervalMs: 60_000,
      sendText: async (_session, text) => {
        sent.push(text);
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => {
        if (!firstCapture) {
          return '❯ ';
        }
        firstCapture = false;
        markFirstCaptureStarted?.();
        return await new Promise<string>((resolve) => {
          releaseFirstCapture = resolve;
        });
      }
    });

    engine.enqueuePrompt('tmux-a', 'ops', 'stale head', 'stale-head');
    await firstCaptureStarted;
    const staleSeq = engine.queuedItems('tmux-a')[0]!.seq;
    expect(engine.dropMessage('tmux-a', staleSeq)).toBe(true);
    engine.enqueuePrompt('tmux-a', 'ops', 'replacement head', 'replacement-head');
    releaseFirstCapture?.('❯ ');
    await flush();

    expect(sent).toEqual([]);
    await engine.drainReady();
    await waitFor(() => sent.length === 1);
    expect(sent).toEqual(['replacement head']);
    engine.dispose();
    rmSync(home, { recursive: true, force: true });
  });
});

describe('ChannelsEngine digest coalescing', () => {
  let home: string;
  let sent: Array<{ session: string; text: string }>;
  let engine: ChannelsEngine;
  let pane: string; // mutable live pane (probe-authoritative gate)

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-chan-digest-'));
    sent = [];
    pane = READY_PANE;
    engine = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 100,
      verifyCycles: 1,
      sendText: async (session, text) => {
        sent.push({ session, text });
        return true;
      },
      sessionRunning: () => true,
      capturePane: async () => pane
    });
  });

  afterEach(() => {
    engine.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  const members = [member('alpha', 'tmux-a'), { ...member('human', '', 'human'), sessionId: undefined }];

  it('coalesces a multi-message backlog into one digest delivery', async () => {
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-1-aaaa', 'human', '@alpha start') }, members);
    await waitFor(() => sent.length === 1);
    engine.pauseSession('tmux-a', 'accumulate digest backlog');

    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-2-bbbb', 'beta', '@alpha two') }, members);
    engine.handleMessage({ channel: 'ops', file: 'thread-msg-1-aaaa.md', message: message('msg-3-cccc', 'beta', '@alpha three') }, members);
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-4-dddd', 'human', '@alpha four') }, members);
    await flush();
    expect(sent).toHaveLength(1);
    expect((await engine.lifecycleStates()).find((state) => state.sessionId === 'tmux-a')).toMatchObject({ queueDepth: 3 });

    engine.resumeSession('tmux-a');
    await waitFor(() => sent.length === 2); // ONE digest, not three deliveries
    const digest = sent[1].text;
    expect(digest).toContain('3 messages arrived while you were working');
    expect(digest).toContain('desk channels read ops');
    expect(digest).toContain('2 from @beta');
    expect(digest).toContain('thread msg-1-aaaa');
    expect(digest).toContain('1 from @human');
    expect(digest).toContain('--as alpha');
    expect(digest).not.toContain('@alpha two'); // bodies are NOT inlined — agent reads the channel
    expect((await engine.lifecycleStates()).find((state) => state.sessionId === 'tmux-a')).toMatchObject({ queueDepth: 0 });

    // nothing further to deliver on the next release
    await engine.drainReady();
    expect(sent).toHaveLength(2);
  });

  it('a single queued message drains as a notification-only turn prompt', async () => {
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-1-aaaa', 'human', '@alpha start') }, members);
    await waitFor(() => sent.length === 1);
    engine.pauseSession('tmux-a', 'accumulate single item');
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-2-bbbb', 'human', '@alpha only one waiting') }, members);
    await flush();
    expect(sent).toHaveLength(1);
    engine.resumeSession('tmux-a');
    await waitFor(() => sent.length === 2);
    expect(sent[1].text).toContain('notificationId:msg-2-bbbb');
    expect(sent[1].text).toContain('1 new message from @human');
    expect(sent[1].text).toContain('desk channels read ops');
    expect(sent[1].text).not.toContain('@alpha only one waiting'); // bodies are never inlined
    expect(sent[1].text).not.toContain('arrived while you were working');
  });

  it('standalone prompts (onboarding) never coalesce into the digest', async () => {
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-1-aaaa', 'human', '@alpha start') }, members);
    await waitFor(() => sent.length === 1);
    engine.pauseSession('tmux-a', 'accumulate mixed backlog');
    engine.enqueuePrompt('tmux-a', 'ops', 'welcome aboard @alpha — full briefing text', 'onboard-ops');
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-2-bbbb', 'beta', '@alpha two') }, members);
    engine.handleMessage({ channel: 'ops', file: 'root.md', message: message('msg-3-cccc', 'beta', '@alpha three') }, members);
    await flush();
    expect(sent).toHaveLength(1);

    engine.resumeSession('tmux-a');
    await waitFor(() => sent.length === 2);
    expect(sent[1].text).toContain('welcome aboard @alpha'); // briefing verbatim, alone

    // the onboarding prompt is picked up + finished; the remaining msg-2/3 backlog
    // then delivers as one digest on the next ready window.
    pane = WORKING_PANE;
    await new Promise((resolve) => setTimeout(resolve, 130));
    pane = READY_PANE;
    await engine.drainReady();
    await waitFor(() => sent.length === 3);
    expect(sent[2].text).toContain('2 messages arrived while you were working'); // remaining backlog digested
  });

  it('digest groups multiple channels with per-channel read instructions', () => {
    const digest = buildDigestPrompt(
      [
        { seq: 1, channel: 'ops', messageId: 'm1', author: 'beta', prompt: 'p', queuedAt: '2026-06-12T10:00:00Z', kind: 'message', file: 'root.md', member: 'alpha' },
        { seq: 2, channel: 'build', messageId: 'm2', author: 'gamma', prompt: 'p', queuedAt: '2026-06-12T10:00:01Z', kind: 'message', file: 'root.md', member: 'alpha-2' },
        { seq: 3, channel: 'build', messageId: 'm3', author: 'gamma', prompt: 'p', queuedAt: '2026-06-12T10:00:02Z' }
      ],
      '/tmp/chan-home'
    );
    expect(digest).toContain('desk channels read ops');
    expect(digest).toContain('desk channels read build');
    expect(digest).toContain('--as alpha ');
    expect(digest).toContain('--as alpha-2 ');
    expect(digest).toContain('2 from @gamma');
  });
});

describe('sliceMessages (lazy-load windowing)', () => {
  const ids = (window: { messages: ChannelMessage[] }): string[] => window.messages.map((m) => m.id);
  const make = (count: number): ChannelMessage[] =>
    Array.from({ length: count }, (_, i) => message(`m${i + 1}`, 'a', `body ${i + 1}`));

  it('returns the newest page when there is no seen pointer', () => {
    const w = sliceMessages(make(100), { limit: 50 });
    expect(w.messages).toHaveLength(50);
    expect(ids(w)[0]).toBe('m51');
    expect(ids(w).at(-1)).toBe('m100');
    expect(w).toMatchObject({ hasOlder: true, hasNewer: false, total: 100, startIndex: 50 });
  });

  it('returns everything (no flags) when the channel is shorter than the page', () => {
    const w = sliceMessages(make(10), { limit: 50 });
    expect(w.messages).toHaveLength(10);
    expect(w).toMatchObject({ hasOlder: false, hasNewer: false, total: 10 });
  });

  it('anchors on the first unread with read context above it (small backlog fits the page)', () => {
    // seen through m95 → 5 unread (m96..m100); contextAbove 5 keeps m91..m95 visible
    const w = sliceMessages(make(100), { since: 'm95', limit: 50, contextAbove: 5 });
    expect(ids(w)[0]).toBe('m91'); // 5 of read context
    expect(ids(w)).toContain('m96'); // first unread present (the anchor)
    expect(ids(w).at(-1)).toBe('m100');
    expect(w).toMatchObject({ hasOlder: true, hasNewer: false });
  });

  it('starts at the first unread and leaves hasNewer when the unread block is deeper than the page', () => {
    // seen through m10 → 90 unread; window starts at m11-context, only `limit` load
    const w = sliceMessages(make(100), { since: 'm10', limit: 50, contextAbove: 5 });
    expect(ids(w)[0]).toBe('m6'); // m11 first unread, minus 5 context
    expect(w.messages).toHaveLength(50);
    expect(w).toMatchObject({ hasOlder: true, hasNewer: true });
    expect(ids(w)).toContain('m11'); // first unread is loaded so the anchor lands
  });

  it('falls back to the newest page when caught up or the pointer is unknown', () => {
    expect(ids(sliceMessages(make(60), { since: 'm60', limit: 50 }))[0]).toBe('m11'); // caught up
    expect(ids(sliceMessages(make(60), { since: 'gone', limit: 50 }))[0]).toBe('m11'); // unknown id
  });

  it('pages older messages before a cursor', () => {
    const w = sliceMessages(make(100), { before: 'm51', limit: 40 });
    expect(ids(w)[0]).toBe('m11');
    expect(ids(w).at(-1)).toBe('m50');
    expect(w).toMatchObject({ hasOlder: true, hasNewer: true, startIndex: 10 });
  });

  it('reports no older page at the very start', () => {
    expect(sliceMessages(make(100), { before: 'm1', limit: 40 })).toMatchObject({
      messages: [],
      hasOlder: false,
      hasNewer: true
    });
  });

  it('pages newer messages after a cursor', () => {
    const w = sliceMessages(make(100), { after: 'm50', limit: 40 });
    expect(ids(w)[0]).toBe('m51');
    expect(ids(w).at(-1)).toBe('m90');
    expect(w).toMatchObject({ hasOlder: true, hasNewer: true, startIndex: 50 });
  });

  it('reports no newer page at the very end', () => {
    expect(sliceMessages(make(100), { after: 'm100', limit: 40 })).toMatchObject({
      messages: [],
      hasOlder: true,
      hasNewer: false
    });
  });
});
