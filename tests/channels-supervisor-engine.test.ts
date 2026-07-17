import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSupervisorCheckInPrompt,
  buildTurnPrompt,
  ChannelsEngine
} from '../src/server/channelsEngine.js';
import type { ChannelMember, ChannelMessage } from '../src/server/channelsProtocol.js';
import { addMember, createChannel, updateMemberSupervisor } from '../src/server/channelsStore.js';

const message = (id: string, author: string, body: string): ChannelMessage => ({
  id,
  author,
  timestamp: '2026-06-11 12:00:00',
  body,
  hasEndTurn: true
});

const member = (name: string, tmuxSession: string, type = 'claude-code'): ChannelMember => ({
  name,
  type,
  status: 'active',
  joined: '2026-06-11 12:00:00',
  tmuxSession
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

describe('checkSupervisorIdle pump behaviour (per-channel task tracking)', () => {
  let home: string;
  let sent: Array<{ session: string; text: string }>;
  let engine: ChannelsEngine;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'desk-supe-engine-'));
    createChannel(home, 'ops', 'goal');
    addMember(home, 'ops', { name: 'supe', type: 'claude-code', tmuxSession: 'tmux-supe' });
    addMember(home, 'ops', { name: 'agent-a', type: 'claude-code', tmuxSession: 'tmux-a' });
    updateMemberSupervisor(home, 'ops', 'supe', true, 1);
    sent = [];
    engine = new ChannelsEngine({
      home,
      pumpIntervalMs: 25,
      releaseSettleMs: 0,
      enterVerifyDelayMs: 5,
      verifyCycles: 1,
      sendText: async (session, text) => {
        sent.push({ session, text });
        const notificationId = text.match(/notificationId:([A-Za-z0-9_.:-]+)/)?.[1];
        if (notificationId) {
          queueMicrotask(() => engine.handleDeliveryAck(session, notificationId));
        }
        return true;
      },
      sessionRunning: () => true,
      sessionCreatedAt: async () => 1,
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
    { ...member('human', '', 'human'), tmuxSession: undefined }
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
    // Back-date so the threshold is exceeded, but mark the worker busy.
    // pausedByOperator=true tells the engine's reconcileBusy to skip this
    // runtime, so our manual `busy: true` stays put through the pump ticks.
    const entry = activityMap(engine).get('ops')!;
    entry.workers.set('agent-a', { lastPromptAt: Date.now() - 120_000, lastPostAt: 0 });
    entry.lastCheckInAt = 0;
    const membersMap = (engine as unknown as { members: Map<string, { tmuxSession: string; busy: boolean; queue: unknown[]; pausedByOperator: boolean }> }).members;
    membersMap.set('tmux-a', { tmuxSession: 'tmux-a', busy: true, queue: [], pausedByOperator: true });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sent.filter((entry) => entry.text.includes('Supervisor check-in'))).toHaveLength(0);
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
