import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSupervisorCheckInPrompt,
  buildTurnPrompt,
  ChannelsEngine
} from '../src/server/channels/delivery/engine.js';
import type { ChannelMember, ChannelMessage } from '../src/server/channels/protocol/format.js';
import { readDeliveryEvents } from '../src/server/channels/delivery/events.js';
import { addMember, createChannel, updateMemberSupervisor } from '../src/server/channels/store/fileStore.js';
import {
  AGENT_STATE_SCHEMA_VERSION,
  type AgentActivity,
  type SessionStateSnapshot
} from '../src/shared/controlPlane/index.js';

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

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Reach into the engine's private per-channel activity map. Tests use this to
 *  back-date prompt timestamps so the stuck-detection threshold is exceeded
 *  without waiting minutes. */
type WorkerState = { lastPromptAt: number; lastPostAt: number };
type ChannelEntry = { workers: Map<string, WorkerState>; lastCheckInAt: number };
const activityMap = (engine: ChannelsEngine): Map<string, ChannelEntry> =>
  (engine as unknown as { channelWorkerActivity: Map<string, ChannelEntry> }).channelWorkerActivity;

function agentSnapshot(
  sessionId: string,
  activity: AgentActivity,
  leaseExpiresAt?: number
): SessionStateSnapshot {
  const now = Date.now();
  return {
    schemaVersion: AGENT_STATE_SCHEMA_VERSION,
    revision: 1,
    sessionId,
    generation: 1,
    lifecycle: 'running',
    lifecycleSince: now - 10_000,
    exit: null,
    health: { status: 'healthy', since: now - 10_000 },
    delivery: null,
    policy: { paused: false, since: now - 10_000 },
    subject: {
      kind: 'agent',
      provider: 'claude',
      mode: 'terminal',
      producer: 'claude-hooks',
      activity,
      activitySince: now - 5_000,
      wait: null,
      evidence:
        activity === 'unknown'
          ? null
          : {
              acceptanceId: `${sessionId}-accept`,
              acceptedSeq: 1,
              acceptedAt: now - 5_000,
              producerInstanceId: `${sessionId}-producer`,
              producerSeq: 1,
              eventId: `${sessionId}-event`,
              invocationId: `${sessionId}-invocation`,
              factKinds: ['activity'],
              occurredAt: now - 5_000,
              observedAt: now - 5_000,
              ...(activity === 'working' ? { leaseExpiresAt: leaseExpiresAt ?? now + 60_000 } : {})
            }
    },
    updatedAt: now - 5_000
  };
}

describe('buildTurnPrompt supervisor branch', () => {
  it('injects supervisor duties and the stuck-detection window into the prompt', () => {
    const prompt = buildTurnPrompt({
      channel: 'ops',
      file: 'root.md',
      member: 'supe',
      author: 'human',
      message: message('msg-1-aaaa', 'human', 'ship it'),
      home: '/desk-home',
      supervisor: true,
      supervisorMaxIdleMinutes: 4
    });
    expect(prompt).toContain('SUPERVISOR of #ops');
    expect(prompt).toContain('Stuck detection');
    expect(prompt).toContain('4 minute');
    expect(prompt).toContain('SUMMARY');
    expect(prompt).toContain('ONE sentinel message that you EDIT in place');
    expect(prompt).toContain('desk channels edit ops --message <sentinel-id>');
    expect(prompt).toContain('stuck-detection window is controlled from the desk UI');
  });

  it('falls back to the plain role/functions block when supervisor is false', () => {
    const prompt = buildTurnPrompt({
      channel: 'ops',
      file: 'root.md',
      member: 'agent-a',
      author: 'human',
      message: message('msg-1-aaaa', 'human', 'go'),
      home: '/desk-home',
      role: 'auditor',
      functions: 'check invariants'
    });
    expect(prompt).not.toContain('SUPERVISOR');
    expect(prompt).toContain('Your role in this channel: auditor');
    expect(prompt).toContain('Remember your functions: check invariants');
  });

  it('appends supervisor-additional role and functions when both flags and role coexist', () => {
    const prompt = buildTurnPrompt({
      channel: 'ops',
      file: 'root.md',
      member: 'supe',
      author: 'agent-a',
      message: message('msg-1-aaaa', 'agent-a', 'update'),
      home: '/desk-home',
      supervisor: true,
      supervisorMaxIdleMinutes: 3,
      role: 'lead',
      functions: 'coordinate'
    });
    expect(prompt).toContain('SUPERVISOR');
    expect(prompt).toContain('Additional role: lead');
    expect(prompt).toContain('Additional functions: coordinate');
  });

  it('defaults the stuck-detection window to 3 minutes when omitted', () => {
    const prompt = buildTurnPrompt({
      channel: 'ops',
      file: 'root.md',
      member: 'supe',
      author: 'human',
      message: message('msg-1-aaaa', 'human', 'hi'),
      home: '/desk-home',
      supervisor: true
    });
    expect(prompt).toContain('3 minute');
  });
});

describe('buildSupervisorCheckInPrompt', () => {
  it('names the specific stuck agents and their idle duration', () => {
    const prompt = buildSupervisorCheckInPrompt({
      channel: 'ops',
      member: 'supe',
      stuckAgents: [
        { name: 'agent-a', stoppedForMinutes: 5 },
        { name: 'agent-b', stoppedForMinutes: 8 }
      ]
    });
    expect(prompt).toContain('[#ops]');
    expect(prompt).toContain('you are @supe');
    expect(prompt).toContain('@agent-a — stopped 5 minute(s) ago');
    expect(prompt).toContain('@agent-b — stopped 8 minute(s) ago');
    expect(prompt).toContain('Do NOT spam @channel');
    expect(prompt).toContain('desk channels post ops --as supe "@agent-a');
    expect(prompt).toContain('EDIT your sentinel summary in place');
    expect(prompt).toContain('desk channels edit ops --message <sentinel-id>');
  });

  it('includes additional role and functions when provided', () => {
    const prompt = buildSupervisorCheckInPrompt({
      channel: 'ops',
      member: 'supe',
      stuckAgents: [{ name: 'agent-a', stoppedForMinutes: 3 }],
      role: 'lead',
      functions: 'coordinate work'
    });
    expect(prompt).toContain('Additional role: lead');
    expect(prompt).toContain('Additional functions: coordinate work');
  });
});

describe('checkSupervisorIdle measures silence on the injected clock', () => {
  // The stuck window is a DURATION: the prompt/post stamps and the comparison
  // must come from ONE clock. These tests advance an injected clock instead of
  // back-dating the engine's private state, so nothing here depends on how long
  // the test process actually took.
  const CLOCK_BASE = 1_760_000_000_000;
  let home: string;
  let sent: Array<{ session: string; text: string }>;
  let engine: ChannelsEngine;
  let clock: number;

  const membersFixture = (): ChannelMember[] => [
    member('agent-a', 'tmux-a'),
    { ...member('supe', 'tmux-supe'), supervisor: true, supervisorMaxIdleMinutes: 1 },
    { ...member('human', '', 'human'), sessionId: undefined }
  ];

  /** One deliberate pump tick — the check runs when we say, not when a timer fires. */
  const tick = (): Promise<void> =>
    (engine as unknown as { runPumpTick: () => Promise<void> }).runPumpTick();

  /** Check-ins DELIVERED to the supervisor (async: a drain has to run first). */
  const checkIns = (): Array<{ session: string; text: string }> =>
    sent.filter((entry) => entry.text.includes('Supervisor check-in'));

  /** Check-ins RAISED, whether or not one has been delivered yet. `enqueue`
   *  appends this event synchronously and checkSupervisorIdle runs inside the
   *  tick, so after an awaited tick this is exact in BOTH directions — an empty
   *  result means no check-in fired, not that we did not wait long enough. */
  const raisedCheckIns = (): string[] =>
    readDeliveryEvents(home)
      .filter((event) => event.kind === 'queued' && event.messageId?.startsWith('supervisor-check-in-ops'))
      .map((event) => event.messageId ?? '');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-supe-clock-'));
    createChannel(home, 'ops', 'goal');
    addMember(home, 'ops', { name: 'supe', type: 'claude-code', sessionId: 'tmux-supe' });
    addMember(home, 'ops', { name: 'agent-a', type: 'claude-code', sessionId: 'tmux-a' });
    updateMemberSupervisor(home, 'ops', 'supe', true, 1);
    sent = [];
    clock = CLOCK_BASE;
    engine = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      pumpIntervalMs: 60_000, // background pump parked: every tick below is explicit
      releaseSettleMs: 0,
      enterVerifyDelayMs: 5,
      verifyCycles: 1,
      now: () => clock,
      sendText: async (session, text) => {
        sent.push({ session, text });
        return true;
      },
      readAgentStates: async () => ({
        ok: true,
        revision: 17,
        snapshots: [agentSnapshot('tmux-a', 'idle'), agentSnapshot('tmux-supe', 'idle')]
      }),
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
  });

  afterEach(() => {
    engine.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  it('fires AT the stuck threshold on the injected clock and not one tick before', async () => {
    engine.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-1-aaaa', 'human', '@agent-a do the thing') },
      membersFixture()
    );
    // Let the ordinary turn prompts land first. A check-in enqueued while another
    // item is still queued is COALESCED into a digest — a different delivery
    // shape from the one under test, and nothing to do with the clock.
    await waitFor(() => sent.some((entry) => entry.session === 'tmux-supe') && engine.queuedItems('tmux-supe').length === 0);

    // Silence of 0 ms, then of 59_999 ms: both INSIDE the 1-minute window, so no
    // check-in may be raised. Asserted on the raised-event log, which is written
    // synchronously inside the tick — an absence here is a fact, not a timeout.
    await tick();
    expect(raisedCheckIns()).toEqual([]);
    clock += 59_999;
    await tick();
    expect(raisedCheckIns()).toEqual([]);

    // The boundary itself. One millisecond of injected time separates this tick
    // from the last one, and it is the only thing that changed.
    clock += 1;
    await tick();
    expect(raisedCheckIns()).toHaveLength(1);

    await waitFor(() => checkIns().length > 0);
    expect(checkIns()).toHaveLength(1);
    expect(checkIns()[0].session).toBe('tmux-supe');
    // The reported duration is the injected elapsed time, not a wall-clock delta.
    expect(checkIns()[0].text).toContain('@agent-a — stopped 1 minute(s) ago');
  });

  it('does not read an EARLIER post as a reply to a LATER prompt', async () => {
    // agent-a speaks before the channel hands it work. That post is not a reply
    // to the prompt that follows, so the worker still counts as stuck. This only
    // holds if the post stamp and the prompt stamp share the clock that measures
    // them — mixed sources make the earlier post look like the newer one.
    engine.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-post-1', 'agent-a', 'unrelated status from before') },
      membersFixture()
    );
    clock += 1_000;
    engine.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-2-bbbb', 'human', '@agent-a do the thing') },
      membersFixture()
    );

    // Inside the window the prompt is not yet old enough, whichever stamp the
    // post left behind; past it the worker counts as stuck because the post
    // came BEFORE the prompt on the one clock that measures both.
    clock += 59_999;
    await tick();
    expect(raisedCheckIns()).toEqual([]);

    clock += 1;
    await tick();
    expect(raisedCheckIns()).toHaveLength(1);
  });
});

describe('checkSupervisorIdle pump behaviour (per-channel task tracking)', () => {
  let home: string;
  let sent: Array<{ session: string; text: string }>;
  let engine: ChannelsEngine;
  let workerActivity: AgentActivity;
  let workerLeaseExpiresAt: number | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-supe-engine-'));
    createChannel(home, 'ops', 'goal');
    addMember(home, 'ops', { name: 'supe', type: 'claude-code', sessionId: 'tmux-supe' });
    addMember(home, 'ops', { name: 'agent-a', type: 'claude-code', sessionId: 'tmux-a' });
    updateMemberSupervisor(home, 'ops', 'supe', true, 1);
    sent = [];
    workerActivity = 'idle';
    workerLeaseExpiresAt = undefined;
    engine = new ChannelsEngine({
      sendEnter: async () => true,
      home,
      pumpIntervalMs: 25,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 5,
      verifyCycles: 1,
      sendText: async (session, text) => {
        sent.push({ session, text });
        return true;
      },
      readAgentStates: async () => ({
        ok: true,
        revision: 17,
        snapshots: [
          agentSnapshot('tmux-a', workerActivity, workerLeaseExpiresAt),
          agentSnapshot('tmux-supe', 'idle')
        ]
      }),
      sessionRunning: () => true,
      capturePane: async () => '❯ '
    });
  });

  afterEach(() => {
    engine.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  const membersFixture = (): ChannelMember[] => [
    member('agent-a', 'tmux-a'),
    { ...member('supe', 'tmux-supe'), supervisor: true, supervisorMaxIdleMinutes: 1 },
    { ...member('human', '', 'human'), sessionId: undefined }
  ];

  it('does NOT fire a check-in when this channel never handed the worker a prompt', async () => {
    // handleMessage runs but the message is authored by a human with no mention,
    // so resolveTargets returns all agents and agent-a gets a prompt; then we
    // wipe the recorded activity to simulate "worker never got channel work".
    engine.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-1-aaaa', 'human', 'idle chatter') },
      membersFixture()
    );
    activityMap(engine).delete('ops');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sent.filter((entry) => entry.text.includes('Supervisor check-in'))).toHaveLength(0);
  });

  it('fires ONE check-in when this channel handed the worker a prompt and they went silent past the threshold', async () => {
    engine.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-1-aaaa', 'human', '@agent-a do the thing') },
      membersFixture()
    );
    // Back-date agent-a's lastPromptAt so the 1-min threshold is exceeded.
    const entry = activityMap(engine).get('ops')!;
    entry.workers.set('agent-a', { lastPromptAt: Date.now() - 120_000, lastPostAt: 0 });
    entry.lastCheckInAt = 0;
    await waitFor(() => sent.some((entry) => entry.text.includes('Supervisor check-in')));
    const checkIns = sent.filter((entry) => entry.text.includes('Supervisor check-in'));
    expect(checkIns).toHaveLength(1);
    expect(checkIns[0].session).toBe('tmux-supe');
    expect(checkIns[0].text).toContain('@agent-a — stopped');
    // Guard holds against a second check-in until a new prompt/post lands.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sent.filter((entry) => entry.text.includes('Supervisor check-in'))).toHaveLength(1);
  });

  it("does NOT fire a check-in when the worker already replied to this channel's prompt", async () => {
    engine.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-1-aaaa', 'human', '@agent-a do X') },
      membersFixture()
    );
    // agent-a posts back a reply — lastPostAt is updated to now.
    engine.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-2-bbbb', 'agent-a', 'done, results: ...') },
      membersFixture()
    );
    const state = activityMap(engine).get('ops')?.workers.get('agent-a');
    expect(state?.lastPostAt).toBeGreaterThanOrEqual(state?.lastPromptAt ?? 0);
    // Back-date lastPromptAt only — lastPostAt stays fresh → NOT stuck.
    const entry = activityMap(engine).get('ops')!;
    const prev = entry.workers.get('agent-a')!;
    entry.workers.set('agent-a', { lastPromptAt: Date.now() - 120_000, lastPostAt: prev.lastPostAt });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sent.filter((entry) => entry.text.includes('Supervisor check-in'))).toHaveLength(0);
  });

  it('does NOT fire a check-in while the worker is currently busy on the task', async () => {
    engine.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-1-aaaa', 'human', '@agent-a do it') },
      membersFixture()
    );
    // Back-date so the threshold is exceeded, but supply a fresh canonical
    // working lease for the worker.
    const entry = activityMap(engine).get('ops')!;
    entry.workers.set('agent-a', { lastPromptAt: Date.now() - 120_000, lastPostAt: 0 });
    entry.lastCheckInAt = 0;
    workerActivity = 'working';
    workerLeaseExpiresAt = Date.now() + 60_000;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sent.filter((entry) => entry.text.includes('Supervisor check-in'))).toHaveLength(0);
  });

  it('does fire after a working lease expires because stale working projects as unknown', async () => {
    engine.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-expired-1', 'human', '@agent-a do it') },
      membersFixture()
    );
    const entry = activityMap(engine).get('ops')!;
    entry.workers.set('agent-a', { lastPromptAt: Date.now() - 120_000, lastPostAt: 0 });
    entry.lastCheckInAt = 0;
    workerActivity = 'working';
    workerLeaseExpiresAt = Date.now() - 1;

    await waitFor(() => sent.some((item) => item.text.includes('Supervisor check-in')));
    expect(sent.filter((item) => item.text.includes('Supervisor check-in'))).toHaveLength(1);
  });

  it("a supervisor's OWN message does NOT open a new check-in window", async () => {
    engine.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-1-aaaa', 'human', '@agent-a do X') },
      membersFixture()
    );
    const entry = activityMap(engine).get('ops')!;
    entry.workers.set('agent-a', { lastPromptAt: Date.now() - 120_000, lastPostAt: 0 });
    entry.lastCheckInAt = 0;
    await waitFor(() => sent.some((entry) => entry.text.includes('Supervisor check-in')));
    expect(sent.filter((entry) => entry.text.includes('Supervisor check-in'))).toHaveLength(1);
    const stampAfterFirstCheckIn = entry.lastCheckInAt;
    expect(stampAfterFirstCheckIn).toBeGreaterThan(0);

    // Supervisor posts back — must NOT reset the guard.
    engine.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-supe-1', 'supe', '@agent-a status?') },
      membersFixture()
    );
    expect(entry.lastCheckInAt).toEqual(stampAfterFirstCheckIn);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sent.filter((entry) => entry.text.includes('Supervisor check-in'))).toHaveLength(1);
  });

  it('a new @agent-a prompt opens a fresh check-in window after the guard reset', async () => {
    engine.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-1-aaaa', 'human', '@agent-a do X') },
      membersFixture()
    );
    const entry = activityMap(engine).get('ops')!;
    entry.workers.set('agent-a', { lastPromptAt: Date.now() - 120_000, lastPostAt: 0 });
    entry.lastCheckInAt = 0;
    await waitFor(() => sent.some((entry) => entry.text.includes('Supervisor check-in')));
    expect(sent.filter((entry) => entry.text.includes('Supervisor check-in'))).toHaveLength(1);

    // A fresh prompt from the channel to agent-a → recordWorkerPrompt zeros lastCheckInAt.
    engine.handleMessage(
      { channel: 'ops', file: 'root.md', message: message('msg-2-bbbb', 'human', '@agent-a still stuck?') },
      membersFixture()
    );
    entry.workers.set('agent-a', { lastPromptAt: Date.now() - 120_000, lastPostAt: 0 });
    await waitFor(() => sent.filter((entry) => entry.text.includes('Supervisor check-in')).length >= 2);
    expect(sent.filter((entry) => entry.text.includes('Supervisor check-in')).length).toBeGreaterThanOrEqual(2);
  });
});
