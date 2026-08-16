import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import { type ChannelMember, type ChannelMessage } from '../protocol/format.js';
import { mentionsHuman, resolveTargets } from '../protocol/routing.js';
import { isShellAgent, type LifecycleState, type DeliveryStatus, type ChannelActivityEvent, type SessionResumeInfo, type SubmitState, type DeliveryBlockReason, type QueuedPrompt, type QueuedItemMeta, type BlockedItemMeta, type SessionDiagnostic } from '../protocol/delivery.js';
import { listChannelMembers, readChannelMessage, type IncomingChannelMessage } from '../store/fileStore.js';
import {
  classifyQueueFile,
  dropStuckItem,
  EXT_CONSUMED,
  EXT_DELIVERING,
  EXT_DELIVERED,
  EXT_QUEUED,
  EXT_STUCK_SUBMIT,
  EXT_STUCK_UNOBSERVABLE,
  listStuckItems,
  readQueueItem,
  retryStuckItem,
  sweepDeliveredTtl
} from './durability.js';
import { appendDeliveryEvent, type DeliveryEvent, type DeliveryEventInput } from './events.js';
import { listPausedSessions } from './paused.js';
import { writeFileAtomic } from '../../fsOps.js';
import {
  canonicalAgentView,
  canonicalDeliveryDecision,
  type AgentStateBatch,
  type CanonicalAgentView
} from './strategy.js';
import { readAgentStatePulse } from '../../agentStatePulse.js';

/**
 * Channels engine — per-agent delivery queues with explicit delivery contracts.
 *
 * Every finalised channel message is resolved to its @mention targets; each
 * target gets a notification queued under its session. Every item uses the same
 * release eligibility regardless of kind: an explicit operator pause or a
 * canonical `starting`/`exited` lifecycle holds the queue, while agent activity
 * never does. Item kind controls batching and post-send submit verification,
 * not release eligibility.
 *
 * Queues survive server restarts via _engine/queue/<sessionId>/<seq>.json files.
 */

// MemberDeliveryState / PaneState / SubmitState / DeliveryBlockReason /
// QueuedItemMeta / SessionDiagnostic are DEFINED in protocol/format.ts now —
// one source shared with the web client (channelsClient re-exports the same
// definitions). Imported above for local use and re-exported here so existing
// server-side importers keep resolving against the engine module.
export type {
  LifecycleState,
  DeliveryStatus,
  SubmitState,
  DeliveryBlockReason,
  QueuedItemMeta,
  BlockedItemMeta,
  SessionDiagnostic,
  ChannelActivityEvent,
  SessionResumeInfo,
  QueuedPrompt
};

export interface ChannelsEngineOptions {
  home: string;
  /** push a prompt into a session; resolved implementation is injectable for tests */
  sendText: (sessionId: string, text: string) => Promise<boolean>;
  /** @deprecated State authority replaces process/pane inference. */
  sessionRunning?: (sessionId: string) => boolean;
  /** capture the tail of a session's pane (injectable for tests); null = capture failed */
  capturePane: (sessionId: string) => Promise<string | null>;
  /** bare Enter keypress for the submit-verification retry (injectable for tests) */
  sendEnter: (sessionId: string) => Promise<boolean>;
  /**
   * Notify the desk UI (events drawer) about every finalised channel message
   * (human-authored included); `file` locates it (root.md / thread-…),
   * `pingsHuman` marks agent messages that mention @human explicitly.
   */
  onChannelMessage?: (channel: string, file: string, message: ChannelMessage, pingsHuman: boolean) => void;
  /** ms between the literal body push and the Enter key (TUIs drop same-burst CR) */
  enterDelayMs?: number;
  /** ms to let the terminal settle after a release signal before draining */
  releaseSettleMs?: number;
  /** ms between background pump passes (retries deliveries the signals missed) */
  pumpIntervalMs?: number;
  /**
   * Backstop ms after which a `draining` lock held longer than any bounded
   * spawn sequence could take is presumed wedged and reclaimed — so an
   * unforeseen never-settling await can never strand a session's queue.
   */
  drainWatchdogMs?: number;
  /** ms to wait after Enter before verifying the prompt actually submitted */
  enterVerifyDelayMs?: number;
  /** number of verify cycles before a delivery is classified submit-stuck (default 3) */
  verifyCycles?: number;
  /** number of consecutive queue-head hold cycles before diagnostics flag blocked (default 3) */
  blockedAfterCycles?: number;
  /** @deprecated State authority reads are never derived from pane probes. */
  probeTtlMs?: number;
  /** @deprecated State authority reads use their own bounded gateway timeout. */
  probeTimeoutMs?: number;
  /**
   * Fired on every submit-state transition of a delivery, for the on-disk
   * ack-file durability layer to drive its `.json/.delivering/.delivered/
   * .stuck-*` renames with no pump-poll lag. `context.seq` identifies the exact
   * queue item that transitioned; a digest delivery fires once per coalesced
   * seq. The `'delivering'` transition fires synchronously inside deliverNext
   * (under the draining lock, before the paste); the terminal states fire from
   * the async verify cycle. NOTE: a `sendText` failure leaves the state at
   * `'delivering'` (no further fire) — the consumer reverts that from its own
   * sendText wrapper, correlating on the seq from the `'delivering'` fire.
   */
  onSubmitStateChange?: (sessionId: string, state: SubmitState, context: { seq: number }) => void;
  /** prompts older than this at delivery time get a delayed-delivery note */
  staleAfterMs?: number;
  /** manifest/session read model used by the resume inspector (no shelling from the engine) */
  sessionInfo?: (sessionId: string) => (Omit<SessionResumeInfo, 'hasResume'> & { hasResume?: boolean }) | undefined;
  /** One canonical authority batch per Channels decision. */
  readAgentStates?: () => Promise<AgentStateBatch>;
  /** Clock used for working-lease validation and deterministic tests. */
  now?: () => number;
}

const MAX_ACTIVITY_EVENTS = 300;
const MAX_DELIVERED_MEMORY = 2000;
/** Runaway-conversation backstop: a session's queue never grows past this. */
const MAX_QUEUE_PER_SESSION = 50;

function threadParentIdFromFile(file: string): string | undefined {
  return /^thread-(msg-[A-Za-z0-9-]+)\.md$/.exec(file)?.[1];
}
const DELIVERY_SEND_TIMEOUT_MS = 30_000;
const DELIVERY_CAPTURE_TIMEOUT_MS = 4_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureFingerprint(capture: string): string {
  return createHash('sha256').update(capture.slice(-16_384)).digest('hex');
}

export function buildTurnPrompt(options: {
  channel: string;
  file: string;
  member: string;
  author: string;
  message: ChannelMessage;
  home: string;
  role?: string;
  functions?: string;
  supervisor?: boolean;
  supervisorMaxIdleMinutes?: number;
}): string {
  const threadArg = options.file.startsWith('thread-') ? ` --thread ${options.file.slice('thread-'.length, -3)}` : '';
  const lines = [
    `[#${options.channel}] New message from @${options.author} (${options.message.id}) — you are @${options.member}.`,
    ''
  ];
  if (options.supervisor) {
    const idle = options.supervisorMaxIdleMinutes && options.supervisorMaxIdleMinutes > 0 ? options.supervisorMaxIdleMinutes : 3;
    lines.push(
      `You are the SUPERVISOR of #${options.channel}. You receive every message in the channel (not only mentions).`,
      `Your job: keep an up-to-date summary of the channel — where we started, current state, decisions, patterns, and what each agent is doing.`,
      `Stuck detection: desk tracks each worker's busy state. If an agent WORKED, went IDLE, and then stayed silent past ${idle} minute(s) without posting an update, desk will ping you with the specific @name(s) — nudge those agents directly, not @channel.`,
      ``,
      `EVERY message you receive, do this in order:`,
      `1. Update your running SUMMARY (a few paragraphs — where we started, current state, latest decisions, patterns, who is doing what). Keep it as ONE sentinel message that you EDIT in place, not a new post each time.`,
      `2. If this message needs a supervisor reply (someone is stuck, a decision is missing, the group drifted), reply in the channel by @name.`,
      `3. If nothing needs a supervisor reply, do NOT post — silent updates to the sentinel summary are fine.`,
      ``,
      `Sentinel summary command:`,
      `  first time: desk channels post ${options.channel} --as ${options.member} "**Summary (sentinel):** ..." — remember the returned message id.`,
      `  every time after: desk channels edit ${options.channel} --message <sentinel-id> --as ${options.member} "**Summary (sentinel):** ..." — same id, updated body.`,
      ``,
      `The ${idle}-minute stuck-detection window is controlled from the desk UI (member role modal → Supervisor → Max idle). If it needs adjusting, ask @human to change it there — you do not set it yourself.`
    );
    if (options.role) {
      lines.push(`Additional role: ${options.role}`);
    }
    if (options.functions) {
      lines.push(`Additional functions: ${options.functions}`);
    }
    lines.push('');
  } else if (options.role || options.functions) {
    if (options.role) {
      lines.push(`Your role in this channel: ${options.role}`);
    }
    if (options.functions) {
      lines.push(`Remember your functions: ${options.functions}`);
    }
    lines.push('');
  }
  lines.push(
    `1 new message from @${options.author}.`,
    `notificationId:${options.message.id}`,
    `Read message: desk channels read ${options.channel} --message ${options.message.id}`,
    `Read full conversation: desk channels read ${options.channel}`,
    '',
    `Full conversation: ${join(options.home, options.channel, options.file)}`,
    `To reply, run: desk channels post ${options.channel}${threadArg} --as ${options.member} "<your message>" — mention members with @name (never @${options.member}). ` +
      `Run \`desk channels read ${options.channel} --message ${options.message.id}\` for this message or \`desk channels read ${options.channel}\` for history.`,
    `When you reference a file, write it as a markdown link with its ABSOLUTE path so the operator can open it in the editor with one click: ` +
      `[src/foo.ts](/abs/path/to/src/foo.ts). Bare or relative paths are not clickable.`,
    `Collaboration contract: when you finish the work this message calls for, post your outcome to the channel (what you did, evidence, who acts next). ` +
      `If it requires nothing from you, post one brief line saying so and why — unless this message is itself a pure acknowledgment/status (then do not reply; never acknowledge acknowledgments). ` +
      `Human guidelines posted in the channel override this cadence.`
  );
  return lines.join('\n');
}

/**
 * Idle-timer check-in prompt for a supervisor: fired by the engine when the
 * channel has been silent longer than the supervisor's max-idle window. Asks
 * the supervisor to ping the channel and find out what's stuck, then refresh
 * their running summary.
 */
export function buildSupervisorCheckInPrompt(options: {
  channel: string;
  member: string;
  /** Agents that were working, went idle, and stayed silent past the max-idle
   *  window without posting anything. Names are prefixed with @ in the prompt. */
  stuckAgents: Array<{ name: string; stoppedForMinutes: number }>;
  role?: string;
  functions?: string;
}): string {
  const stuckLines = options.stuckAgents.map(
    (agent) => `  - @${agent.name} — stopped ${agent.stoppedForMinutes} minute(s) ago without posting an update`
  );
  const stuckHandles = options.stuckAgents.map((agent) => `@${agent.name}`).join(', ');
  const lines = [
    `[#${options.channel}] Supervisor check-in — you are @${options.member}.`,
    '',
    `The following agent(s) in #${options.channel} were working, went idle, and then stayed silent — they need a nudge:`,
    ...stuckLines,
    ``,
    `Do this now:`,
    `1. Ping ${stuckHandles} in #${options.channel} by @name and ask a specific question: "what did you finish, what's blocking you?" Do NOT spam @channel with a generic prompt — target the stuck agent(s).`,
    `2. When their reply lands, EDIT your sentinel summary in place (same message id you have been maintaining) so it reflects the new state — do NOT post a fresh summary each time.`,
    `3. If a stuck agent needs concrete next steps to unblock, propose them in that same reply.`,
    ``,
    `Reply with:    desk channels post ${options.channel} --as ${options.member} "@${options.stuckAgents[0]?.name ?? 'agent'} <your targeted question>"`,
    `Edit sentinel: desk channels edit ${options.channel} --message <sentinel-id> --as ${options.member} "**Summary (sentinel):** ..."`,
    `Read full conversation: desk channels read ${options.channel}`
  ];
  if (options.role) {
    lines.push('', `Additional role: ${options.role}`);
  }
  if (options.functions) {
    lines.push(`Additional functions: ${options.functions}`);
  }
  return lines.join('\n');
}

/**
 * Several messages queued up while the agent was busy: instead of feeding
 * them one per turn (each delivery blocks the agent for a full turn), one
 * short digest tells the agent what arrived and where to read it.
 */
export function buildDigestPrompt(items: QueuedPrompt[], home: string, notificationId?: string): string {
  const byChannel = new Map<string, QueuedPrompt[]>();
  for (const item of items) {
    const list = byChannel.get(item.channel) ?? [];
    list.push(item);
    byChannel.set(item.channel, list);
  }
  const lines: string[] = [];
  for (const [channel, channelItems] of byChannel) {
    const member = channelItems.find((item) => item.member)?.member;
    const byAuthor = new Map<string, QueuedPrompt[]>();
    for (const item of channelItems) {
      const list = byAuthor.get(item.author) ?? [];
      list.push(item);
      byAuthor.set(item.author, list);
    }
    const parts = [...byAuthor.entries()].map(([author, authorItems]) => {
      const threads = [
        ...new Set(
          authorItems
            .map((item) => item.file)
            .filter((file): file is string => Boolean(file?.startsWith('thread-')))
            .map((file) => file.slice('thread-'.length, -3))
        )
      ];
      const threadNote = threads.length > 0 ? ` (thread ${threads.join(', ')})` : '';
      return `${authorItems.length} from @${author}${threadNote}`;
    });
    lines.push(
      `#${channel}: ${parts.join(', ')} — read: desk channels read ${channel}` +
        (member ? ` | reply: desk channels post ${channel} [--thread <id>] --as ${member} "<msg>"` : '')
    );
  }
  return [
    `[desk channels] ${items.length} messages arrived while you were working (queued, not delivered one-by-one to avoid blocking you turn after turn). Read them from the channel now:`,
    '',
    notificationId ? `notificationId:${notificationId}` : undefined,
    notificationId ? '' : undefined,
    ...lines,
    '',
    `Files live under ${home}. Collaboration contract applies to the batch: act on what these messages require of you, post your outcome; if nothing is required, post one brief line saying so. Never reply to pure acknowledgments.`
  ].join('\n');
}

/**
 * One-time briefing pushed to an agent's terminal when it joins a channel —
 * the agent learns the room, the roster, the CLI, and the collaboration
 * contract before the first dispatch ever reaches it.
 */
export function buildOnboardingPrompt(options: {
  channel: string;
  goal: string;
  handle: string;
  members: ChannelMember[];
  messageCount: number;
  home: string;
  role?: string;
  functions?: string;
}): string {
  const roster = options.members
    .filter((member) => member.name !== options.handle)
    .map((member) => `@${member.name} (${member.type === 'human' ? 'human operator' : member.type})`)
    .join(', ');
  const lines = [
    `You have been added to the desk channel #${options.channel} as @${options.handle}. This is a multi-agent collaboration room — you are expected to participate actively, not observe.`,
    '',
    options.goal ? `Channel goal: ${options.goal}` : 'Channel goal: (not set — ask @human if direction is unclear)',
    `Members: ${roster || '(just you and the operator so far)'}`,
  ];
  if (options.role) {
    lines.push(`Your role: ${options.role}`);
  }
  if (options.functions) {
    lines.push(`Your functions in this channel: ${options.functions}`);
  }
  lines.push(
    '',
    'How it works:',
    `- New messages addressed to you arrive in this terminal automatically. If several pile up while you are working, you get ONE summary instead — read the channel yourself to catch up.`,
    `- Read the room first: desk channels read ${options.channel}${options.messageCount > 0 ? ` (${options.messageCount} messages so far)` : ''}`,
    `- Post: desk channels post ${options.channel} --as ${options.handle} "<message>" (always pass --as ${options.handle}; without it your post may be misattributed).`,
    `- Thread replies: desk channels post ${options.channel} --thread <parent-msg-id> --as ${options.handle} "<message>".`,
    `- Mentions: @name/@channel mark urgency and context; channel notifications go to active agents. @human notifies the operator. Never mention yourself.`,
    `- File links: reference files as markdown links with their ABSOLUTE path — [src/foo.ts](/abs/path/to/src/foo.ts) — so the operator can click to open them in the editor. Bare or relative paths are not clickable.`,
    '',
    'Collaboration contract:',
    `- Whenever you finish a turn of real work — whether triggered by a channel message or by your own task — post a brief status to #${options.channel}: what you did, the evidence, and who must act next.`,
    `- Do not go silent. If a message needs nothing from you, say so in one line with the reason. The only exception: never reply to pure acknowledgments or status notes that name no action for you.`,
    `- Coordinate before colliding: announce what you are about to work on if another member might be touching the same thing.`,
    `- If @human posts guidelines in the channel, they override these defaults — re-read them when they appear.`,
    '',
    `Start by reading the channel now and introducing yourself in one short message (who you are, what you are working on, current state).`
  );
  return lines.join('\n');
}

interface MemberRuntime {
  sessionId: string;
  queue: QueuedPrompt[];
  lastDeliveryAt?: string;
  lastReleaseAt?: string;
  draining: boolean;
  /** true while the physical paste is in flight; never reclaim this drain */
  deliveryInFlight: boolean;
  /**
   * Single-flight generation. Every drain/forceDeliver attempt captures
   * `++drainGeneration`; after each await it re-checks the runtime value and
   * bails if it changed (a newer attempt, or a watchdog reclaim, superseded it).
   * This is the real guard against the watchdog reclaiming a wedged drain and
   * running a SECOND deliverNext in parallel (the double-paste window).
   */
  drainGeneration: number;
  /** epoch ms when `draining` was set true (for the wedge watchdog) */
  drainingSince?: number;
  /** epoch ms of the last delivery */
  lastDeliveryMs?: number;
  /** result of the last delivery's submit verification (drives ack-file renames) */
  submitState?: SubmitState;
  /** seqs covered by the current submitState, for ops diagnostics after queue shift */
  submitStateSeqs?: number[];
  /** consecutive drain holds for the current queue head */
  deliveryBlock?: {
    reason: DeliveryBlockReason;
    headSeq: number;
    firstSeenAt: string;
    lastSeenAt: string;
    cycles: number;
  };
  /** prompts dropped by the queue cap since this runtime was created */
  droppedQueueItems?: number;
  /** intentional operator hold; distinct from draining/stuck and does not count hold cycles */
  pausedByOperator?: {
    reason?: string;
    since: string;
  };
}

interface DeliveryEventContext {
  channel: string;
  messageId: string;
  author?: string;
  preview?: string;
}

export class ChannelsEngine {
  private readonly members = new Map<string, MemberRuntime>();
  private readonly activity: ChannelActivityEvent[] = [];
  /** Per-channel per-worker activity tracking for supervisor stuck-detection.
   *  For each channel and each non-supervisor member we remember when they were
   *  last handed a prompt from THIS channel (lastPromptAt) and when they last
   *  posted to THIS channel (lastPostAt). A worker is "stuck" when
   *  lastPromptAt > lastPostAt AND they've been silent past the threshold —
   *  i.e. this channel gave them work and they haven't reported back. Work
   *  they picked up outside the channel is intentionally invisible here: roles
   *  live per-channel, so supervision does too. `lastCheckInAt` is the spam
   *  guard — one check-in per open work window per channel. */
  private readonly channelWorkerActivity = new Map<
    string,
    {
      workers: Map<string, { lastPromptAt: number; lastPostAt: number }>;
      lastCheckInAt: number;
    }
  >();
  private activitySeq = 0;
  private queueSeq = 0;
  private disposed = false;
  private readonly sendText: (sessionId: string, text: string) => Promise<boolean>;
  private readonly capturePane: (sessionId: string) => Promise<string | null>;
  private readonly sendEnter: (sessionId: string) => Promise<boolean>;
  private readonly releaseSettleMs: number;
  private readonly drainWatchdogMs: number;
  private readonly enterVerifyDelayMs: number;
  private readonly verifyCycles: number;
  private readonly blockedAfterCycles: number;
  private readonly onSubmitStateChange?: (sessionId: string, state: SubmitState, context: { seq: number }) => void;
  private readonly staleAfterMs: number;
  private readonly sessionInfo: (sessionId: string) => (Omit<SessionResumeInfo, 'hasResume'> & { hasResume?: boolean }) | undefined;
  private readonly readAgentStates: () => Promise<AgentStateBatch>;
  private readonly now: () => number;
  private pumpTimer: NodeJS.Timeout | undefined;
  /** delivered (session:messageId) pairs — dispatch dedupe across all paths */
  private readonly delivered = new Set<string>();
  /** queue metadata retained after delivery shift so async submit-state events can be attributed */
  private readonly deliveryEventContext = new Map<string, DeliveryEventContext>();
  constructor(private readonly options: ChannelsEngineOptions) {
    this.sendText = options.sendText;
    this.capturePane = options.capturePane;
    this.sendEnter = options.sendEnter;
    this.releaseSettleMs = options.releaseSettleMs ?? 800;
    this.drainWatchdogMs = options.drainWatchdogMs ?? 30_000;
    this.enterVerifyDelayMs = options.enterVerifyDelayMs ?? 1200;
    this.verifyCycles = options.verifyCycles ?? 3;
    this.blockedAfterCycles = options.blockedAfterCycles ?? 3;
    this.onSubmitStateChange = options.onSubmitStateChange;
    this.staleAfterMs = options.staleAfterMs ?? 10 * 60 * 1000;
    this.sessionInfo = options.sessionInfo ?? (() => undefined);
    this.readAgentStates = options.readAgentStates ?? readAgentStatePulse;
    this.now = options.now ?? Date.now;
    this.restorePausedSessions();
    this.restoreQueues();
    this.startPump(options.pumpIntervalMs ?? 2500);
  }

  /**
   * Dispatch work nobody awaits — timer ticks, drains kicked off from a
   * callback, post-delivery verification. Node terminates the process on an
   * unhandled rejection, so a rejecting transport or a full disk inside one of
   * these would take the whole server down from a tick no caller can catch.
   * Every background dispatch goes through here (R8.4: one guard, not seven).
   * R1: the failure is logged, never dropped blind.
   */
  private background(what: string, run: () => Promise<unknown>): void {
    try {
      void run().catch((error: unknown) => {
        this.reportBackgroundFailure(what, error);
      });
    } catch (error) {
      // A synchronous throw before the promise is even created.
      this.reportBackgroundFailure(what, error);
    }
  }

  private reportBackgroundFailure(what: string, error: unknown): void {
    console.warn(
      `[desk-channels] background ${what} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  private startPump(intervalMs: number): void {
    this.pumpTimer = setInterval(() => {
      this.background('pump tick', () => this.runPumpTick());
    }, intervalMs);
    this.pumpTimer.unref?.();
  }

  private async readStateBatch(): Promise<AgentStateBatch> {
    try {
      const batch = await this.readAgentStates();
      if (!batch.ok || batch.revision === null || !Array.isArray(batch.snapshots)) {
        return { ok: false, revision: null, snapshots: [] };
      }
      return batch;
    } catch {
      return { ok: false, revision: null, snapshots: [] };
    }
  }

  private async captureDeliveryFingerprint(sessionId: string): Promise<string | null> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const captured = await Promise.race([
        this.capturePane(sessionId).catch(() => null),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), DELIVERY_CAPTURE_TIMEOUT_MS);
          timeout.unref?.();
        })
      ]);
      return captured === null ? null : captureFingerprint(captured);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async runPumpTick(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const batch = await this.readStateBatch();
    if (this.disposed) {
      return;
    }
    for (const runtime of this.members.values()) {
      if (runtime.queue.length > 0) {
        this.background('queue drain', () => this.drain(runtime, true, batch));
      } else {
        this.resetHold(runtime);
      }
    }
    this.checkSupervisorIdle(batch);
  }

  /** Every pump tick: for each channel with a supervisor member, look for
   *  workers who have an OPEN CHANNEL TASK (this channel handed them a prompt
   *  more recently than they posted back) and have been silent past the
   *  threshold. Only "channel work" is supervised — work an agent picked up
   *  outside this channel is invisible here (roles live per-channel, so
   *  supervision does too). If there is at least one stuck worker, ping the
   *  supervisor with names so it can nudge by @name instead of @channel. */
  private checkSupervisorIdle(batch: AgentStateBatch): void {
    const now = this.now();
    for (const [channel, entry] of this.channelWorkerActivity.entries()) {
      if (entry.workers.size === 0) {
        continue; // no channel prompts and no channel posts recorded yet
      }
      let members: ChannelMember[];
      try {
        members = listChannelMembers(this.options.home, channel);
      } catch (error) {
        // R1: never drop a failure blind. A channel disappearing mid-pump
        // (destroy race) is expected; a broken manifest is not. Log both
        // once per skip so it's visible in the ops console.
        console.warn(
          `[desk-channels] supervisor idle-check skipped #${channel}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        continue;
      }
      const supervisors = members.filter(
        (member) => member.supervisor === true && member.sessionId && member.type !== 'human'
      );
      if (supervisors.length === 0) {
        continue;
      }
      // Threshold = shortest max-idle among the channel's supervisors.
      const thresholdMinutes = Math.min(
        ...supervisors.map((sup) => (sup.supervisorMaxIdleMinutes && sup.supervisorMaxIdleMinutes > 0 ? sup.supervisorMaxIdleMinutes : 3))
      );
      const thresholdMs = thresholdMinutes * 60_000;
      const stuck: Array<{ name: string; stoppedForMinutes: number }> = [];
      for (const member of members) {
        if (member.type === 'human') continue;
        if (member.supervisor === true) continue;
        if (!member.sessionId) continue;
        const workerState = entry.workers.get(member.name);
        if (!workerState) continue;
        // Task in play = last prompt from this channel is newer than the
        // worker's last post to this channel. If they already reported, no task.
        if (workerState.lastPromptAt <= workerState.lastPostAt) continue;
        // Give them time before nudging: measure silence since the last prompt.
        const silentForMs = now - workerState.lastPromptAt;
        if (silentForMs < thresholdMs) continue;
        // A fresh canonical working lease means the worker is still responding.
        // Expired leases project as unknown and therefore cannot suppress checks forever.
        const view = canonicalAgentView(batch, member.sessionId, now);
        if (view.activity === 'working') continue;
        stuck.push({ name: member.name, stoppedForMinutes: Math.round(silentForMs / 60_000) });
      }
      if (stuck.length === 0) {
        continue;
      }
      // Spam guard: one check-in per open work window. Reset when a new prompt
      // lands (recordWorkerPrompt zeros this) or a worker posts (recordWorkerPost).
      if (entry.lastCheckInAt > 0) {
        continue;
      }
      let anyFired = false;
      for (const supervisor of supervisors) {
        const prompt = buildSupervisorCheckInPrompt({
          channel,
          member: supervisor.name,
          stuckAgents: stuck,
          role: supervisor.role,
          functions: supervisor.functions
        });
        this.enqueue(supervisor.sessionId!, {
          channel,
          messageId: `supervisor-check-in-${channel}-${now}`,
          author: 'system',
          prompt,
          target: supervisor.name,
          preview: `stuck: ${stuck.map((s) => s.name).join(', ')}`,
          kind: 'prompt',
          file: `_supervisor/${channel}.md`,
          member: supervisor.name
        });
        anyFired = true;
      }
      if (anyFired) {
        entry.lastCheckInAt = now;
      }
    }
  }

  private queueDir(sessionId?: string): string {
    const base = join(this.options.home, '_engine', 'queue');
    return sessionId ? join(base, sessionId) : base;
  }

  private runtime(sessionId: string): MemberRuntime {
    let entry = this.members.get(sessionId);
    if (!entry) {
      entry = { sessionId, queue: [], draining: false, deliveryInFlight: false, drainGeneration: 0 };
      this.members.set(sessionId, entry);
    }
    return entry;
  }

  private resetHold(runtime: MemberRuntime): void {
    runtime.deliveryBlock = undefined;
  }

  private recordHold(runtime: MemberRuntime, reason: DeliveryBlockReason, countCycle: boolean): void {
    const head = runtime.queue[0];
    if (!head) {
      this.resetHold(runtime);
      return;
    }
    const now = new Date().toISOString();
    const current = runtime.deliveryBlock;
    if (current && current.headSeq === head.seq && current.reason === reason) {
      if (countCycle) {
        current.cycles += 1;
      }
      current.lastSeenAt = now;
      return;
    }
    runtime.deliveryBlock = {
      reason,
      headSeq: head.seq,
      firstSeenAt: now,
      lastSeenAt: now,
      cycles: countCycle ? 1 : 0
    };
  }

  private runtimeBlock(runtime: MemberRuntime | undefined): Pick<
    SessionDiagnostic,
    'deliveryBlocked' | 'blockedReason' | 'blockedSince' | 'blockedCycles' | 'blockedHeadSeq'
  > {
    if (!runtime) {
      return { deliveryBlocked: false };
    }
    if (runtime.submitState === 'submit-stuck-paste' || runtime.submitState === 'submit-stuck-submit') {
      return {
        deliveryBlocked: true,
        blockedReason: runtime.submitState,
        blockedSince: runtime.lastDeliveryAt,
        blockedCycles: this.blockedAfterCycles,
        blockedHeadSeq: runtime.submitStateSeqs?.[0]
      };
    }
    const block = runtime.deliveryBlock;
    if (!block || block.cycles < this.blockedAfterCycles) {
      return { deliveryBlocked: false };
    }
    return {
      deliveryBlocked: true,
      blockedReason: block.reason,
      blockedSince: block.firstSeenAt,
      blockedCycles: block.cycles,
      blockedHeadSeq: block.headSeq
    };
  }

  /**
   * Reload persisted queues after a server restart (agents assumed idle).
   *
   * Per-item lifecycle extensions under _engine/queue/<sessionId>/:
   *   .json       — queued, re-enqueue (existing behavior).
   *   .delivering — paste was in-flight when the previous process died; treat
   *                 as queued (at-least-once re-send). The prompt body embeds
   *                 the message-id so the receiving agent can dedupe.
   *   .delivered  — submit was confirmed before restart; skip (do NOT re-enqueue),
   *                 TTL-sweep stale entries so the dir does not grow unbounded.
   *   .stuck-paste / .stuck-submit — delivery classified as stuck; preserve on
   *                 disk for the ops console to surface, do NOT auto-replay.
   *                 Operator force-delivers or drops via the console.
   */
  private restoreQueues(): void {
    const base = this.queueDir();
    if (!existsSync(base)) {
      return;
    }
    for (const sessionDir of readdirSync(base, { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) {
        continue;
      }
      const sessionDirPath = join(base, sessionDir.name);
      const runtime = this.runtime(sessionDir.name);
      /** Sources whose item is in the queue but not yet in a durable snapshot. */
      const consumedPaths: string[] = [];
      // Sweep stale .delivered files first so the dir doesn't carry dead weight
      // into the new process. Cheap: stat per .delivered file only.
      sweepDeliveredTtl(this.options.home, sessionDir.name);
      for (const file of readdirSync(sessionDirPath).sort()) {
        const isConsumed = file.endsWith('.consumed');
        const ext = classifyQueueFile(file);
        if (ext === null) {
          continue; // engine.pid, .write.lock, README, anything non-queue — ignore
        }
        const filePath = join(sessionDirPath, file);
        if (ext === EXT_QUEUED || ext === EXT_DELIVERING || ext === EXT_STUCK_UNOBSERVABLE || ext === EXT_CONSUMED) {
          const consumedFile = isConsumed ? file : `${file}.consumed`;
          const consumedPath = isConsumed ? filePath : join(sessionDirPath, consumedFile);
          if (!isConsumed) {
            try {
              renameSync(filePath, consumedPath);
            } catch {
              // If the source cannot be atomically claimed, leave it for the
              // next restore instead of creating file+queue duplicates.
              continue;
            }
          }
          // Re-enqueue (at-least-once for .delivering and .stuck-unobservable —
          // submission was unconfirmed, and the message-id in the prompt body
          // lets the agent dedupe a replay). Renumber so the new runtime's
          // queueSeq stays monotonic across the restart.
          const parsed = readQueueItem(sessionDirPath, consumedFile);
          if (parsed) {
            const dedupeKey = `${sessionDir.name}:${parsed.messageId}`;
            if (!this.delivered.has(dedupeKey) && !runtime.queue.some((queued) => queued.messageId === parsed.messageId)) {
              parsed.seq = ++this.queueSeq;
              runtime.queue.push(parsed);
              this.delivered.add(dedupeKey);
            }
          }
          // Defer removing the source: persistQueue (below) rewrites the
          // snapshot as .json with the new seq, and deleting first would leave
          // a crash window in which the item exists in neither file. The
          // .delivering extension is consumed once the snapshot is durable —
          // the next drain fires a fresh 'delivering' callback which re-claims
          // under the new seq. A .consumed file surviving a crash is re-read
          // by the next restore, so the deferral cannot lose it either.
          consumedPaths.push(consumedPath);
        } else if (ext === EXT_DELIVERED) {
          // Already-confirmed delivery. Leave on disk for the dedupe window;
          // the TTL sweep above will reclaim it once it ages out.
          continue;
        } else {
          // .stuck-paste / .stuck-submit — preserve for ops-console surfacing.
          // The tripwire (separate slice) reads these via listStuckItems().
          continue;
        }
      }
      this.persistQueue(runtime);
      // The snapshot is durable now, so the sources it superseded can go.
      for (const consumedPath of consumedPaths) {
        try {
          rmSync(consumedPath, { force: true });
        } catch {
          // raced — best-effort; a survivor is re-read by the next restore
        }
      }
      if (runtime.queue.length > 0) {
        this.background('queue drain', () => this.drain(runtime, false));
      }
    }
  }

  /** Restore intentional operator holds before any queued prompt can drain. */
  private restorePausedSessions(): void {
    for (const paused of listPausedSessions(this.options.home)) {
      const runtime = this.runtime(paused.sessionId);
      runtime.pausedByOperator = { since: paused.pausedAt, reason: paused.reason };
      this.resetHold(runtime);
    }
  }

  /**
   * Snapshots the in-memory queue to disk. Surgical: writes/refreshes .json
   * for every current item and removes orphaned .json files (items no longer
   * queued), WITHOUT touching the per-item durable extensions
   * (.delivering / .delivered / .stuck-*). Those are owned by the
   * onSubmitStateChange rename map, not by the queue snapshot, and wiping
   * them here would lose in-flight and finalized state.
   */
  private persistQueue(runtime: MemberRuntime): void {
    const dir = this.queueDir(runtime.sessionId);
    mkdirSync(dir, { recursive: true });
    const liveSeqs = new Set(runtime.queue.map((item) => item.seq));
    for (const item of runtime.queue) {
      writeFileAtomic(join(dir, `${String(item.seq).padStart(10, '0')}.json`), JSON.stringify(item));
    }
    // Remove orphaned .json files (items shifted out of the queue). Durable
    // extensions are preserved — they represent lifecycle states the runtime
    // is no longer tracking in queue but the operator may need to see.
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const file of entries) {
      const ext = classifyQueueFile(file);
      if (ext !== EXT_QUEUED) {
        continue; // durable or non-queue — leave alone
      }
      const stem = file.slice(0, -`.${EXT_QUEUED}`.length);
      const seq = Number(stem);
      if (Number.isInteger(seq) && !liveSeqs.has(seq)) {
        try {
          unlinkSync(join(dir, file));
        } catch {
          // raced unlink — best-effort
        }
      }
    }
  }

  private pushActivity(event: Omit<ChannelActivityEvent, 'seq' | 'at'>): ChannelActivityEvent {
    const entry: ChannelActivityEvent = { ...event, seq: ++this.activitySeq, at: new Date().toISOString() };
    this.activity.push(entry);
    if (this.activity.length > MAX_ACTIVITY_EVENTS) {
      this.activity.splice(0, this.activity.length - MAX_ACTIVITY_EVENTS);
    }
    return entry;
  }

  private pushDeliveryEvent(event: DeliveryEventInput): void {
    try {
      appendDeliveryEvent(this.options.home, event);
    } catch {
      // Delivery history is diagnostic; a broken event ring must never break delivery.
    }
  }

  private deliveryEventKey(sessionId: string, seq: number): string {
    return `${sessionId}:${seq}`;
  }

  private queuedEventContext(item: QueuedPrompt, preview?: string): DeliveryEventContext {
    return {
      channel: item.channel,
      messageId: item.messageId,
      author: item.author,
      preview: preview ?? item.prompt.split('\n').find((line) => line.trim() !== '')?.slice(0, 140) ?? ''
    };
  }

  private pushQueuedDeliveryEvent(sessionId: string, item: QueuedPrompt, preview?: string): void {
    this.pushDeliveryEvent({
      kind: 'queued',
      sessionId,
      ...this.queuedEventContext(item, preview)
    });
  }

  private pushDroppedDeliveryEvent(sessionId: string, item: QueuedPrompt): void {
    this.pushDeliveryEvent({
      kind: 'dropped',
      sessionId,
      ...this.queuedEventContext(item)
    });
  }

  /**
   * Permanently stops this engine: no further dispatch or delivery. Called
   * when the dev server restarts — the replacement module instance builds a
   * fresh engine, and a leaked old one must never double-deliver prompts.
   */
  dispose(): void {
    this.disposed = true;
    this.members.clear();
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = undefined;
    }
  }

  /** Entry point for every finalised message (server appends + watcher finds). */
  handleMessage(incoming: IncomingChannelMessage, membersOverride?: ChannelMember[]): void {
    if (this.disposed) {
      return;
    }
    const { channel, file, message } = incoming;
    const preview = message.body.replace(/\s+/g, ' ').slice(0, 140);
    this.pushActivity({ kind: 'message', channel, file, messageId: message.id, author: message.author, preview });

    const members = membersOverride ?? listChannelMembers(this.options.home, channel);
    // The author just posted to this channel — record it so stuck-detection
    // knows they reported back on any in-flight prompt from this channel.
    const authorMember = members.find((member) => member.name === message.author);
    const authorIsSupervisor = authorMember?.supervisor === true;
    if (authorMember && !authorIsSupervisor && authorMember.type !== 'human') {
      this.recordWorkerPost(channel, authorMember.name);
    }

    const pingsHuman = message.author !== 'human' && mentionsHuman(message.body);
    if (pingsHuman) {
      this.pushActivity({ kind: 'human-mention', channel, file, messageId: message.id, author: message.author, preview });
    }
    this.options.onChannelMessage?.(channel, file, message, pingsHuman);

    const threadParentId = threadParentIdFromFile(file);
    const threadAuthor = threadParentId ? this.threadParentAuthor(channel, threadParentId) : undefined;
    const authorSession = members.find((member) => member.name === message.author)?.sessionId;
    for (const target of resolveTargets(message.author, message.body, members, { isThread: Boolean(threadParentId), threadAuthor })) {
      if (!target.sessionId || target.sessionId === authorSession) {
        continue;
      }
      // Record that THIS channel handed target a prompt (only for non-supervisor
      // workers, and only when the AUTHOR is not a supervisor). Supervisor
      // messages don't count as "assigned work" — the supervisor decides on
      // its own when to re-nudge, so we don't want its own check-in question
      // to open a fresh check-in window for the same worker forever.
      if (target.supervisor !== true && target.type !== 'human' && !authorIsSupervisor) {
        this.recordWorkerPrompt(channel, target.name);
      }
      const prompt = buildTurnPrompt({
        channel,
        file,
        member: target.name,
        author: message.author,
        message,
        home: this.options.home,
        role: target.role,
        functions: target.functions,
        supervisor: target.supervisor,
        supervisorMaxIdleMinutes: target.supervisorMaxIdleMinutes
      });
      this.enqueue(target.sessionId, {
        channel,
        messageId: message.id,
        author: message.author,
        prompt,
        target: target.name,
        preview,
        kind: 'message',
        file,
        member: target.name
      });
    }
  }

  private ensureChannelActivity(channel: string): {
    workers: Map<string, { lastPromptAt: number; lastPostAt: number }>;
    lastCheckInAt: number;
  } {
    let entry = this.channelWorkerActivity.get(channel);
    if (!entry) {
      entry = { workers: new Map(), lastCheckInAt: 0 };
      this.channelWorkerActivity.set(channel, entry);
    }
    return entry;
  }

  private recordWorkerPrompt(channel: string, member: string): void {
    const entry = this.ensureChannelActivity(channel);
    const now = this.now();
    const prior = entry.workers.get(member) ?? { lastPromptAt: 0, lastPostAt: 0 };
    entry.workers.set(member, { lastPromptAt: now, lastPostAt: prior.lastPostAt });
    // A new task landed → the previous check-in window closes; the next window
    // can fire fresh once the new prompt goes unanswered for `threshold` minutes.
    entry.lastCheckInAt = 0;
  }

  private recordWorkerPost(channel: string, member: string): void {
    const entry = this.ensureChannelActivity(channel);
    const now = this.now();
    const prior = entry.workers.get(member) ?? { lastPromptAt: 0, lastPostAt: 0 };
    entry.workers.set(member, { lastPromptAt: prior.lastPromptAt, lastPostAt: now });
    // Someone reported back → the check-in guard resets so the next open work
    // window can fire its own check-in later if the worker stops again.
    entry.lastCheckInAt = 0;
  }

  private threadParentAuthor(channel: string, parentId: string): string | undefined {
    try {
      return readChannelMessage(this.options.home, channel, parentId).author;
    } catch {
      return undefined;
    }
  }

  private enqueue(
    sessionId: string,
    item: {
      channel: string;
      messageId: string;
      author: string;
      prompt: string;
      target: string;
      preview: string;
      kind?: 'message' | 'prompt';
      file?: string;
      member?: string;
    }
  ): void {
    // Dispatch dedupe: a message reaches a session at most once, no matter
    // how many paths re-discover it (API + watcher, rescans, re-dispatch).
    const dedupeKey = `${sessionId}:${item.messageId}`;
    const runtime = this.runtime(sessionId);
    if (this.delivered.has(dedupeKey) || runtime.queue.some((queued) => queued.messageId === item.messageId)) {
      return;
    }
    this.delivered.add(dedupeKey);
    if (this.delivered.size > MAX_DELIVERED_MEMORY) {
      for (const key of this.delivered) {
        this.delivered.delete(key);
        if (this.delivered.size <= MAX_DELIVERED_MEMORY / 2) {
          break;
        }
      }
    }
    const queuedAt = new Date().toISOString();
    const queued: QueuedPrompt = {
      seq: ++this.queueSeq,
      channel: item.channel,
      messageId: item.messageId,
      author: item.author,
      prompt: item.prompt,
      queuedAt,
      kind: item.kind ?? 'message',
      file: item.file,
      member: item.member
    };
    runtime.queue.push(queued);
    this.pushActivity({
      kind: 'queued',
      channel: queued.channel,
      file: queued.file ?? 'root.md',
      messageId: queued.messageId,
      author: queued.author,
      target: sessionId,
      preview: item.preview
    });
    this.pushQueuedDeliveryEvent(sessionId, queued, item.preview);
    // Backstop against runaway loops: drop the OLDEST prompts — the newest
    // carry the current conversation state, stale ones only mislead.
    let dropped = 0;
    while (runtime.queue.length > MAX_QUEUE_PER_SESSION) {
      const removed = runtime.queue.shift();
      if (removed) {
        this.pushDroppedDeliveryEvent(sessionId, removed);
        dropped += 1;
      }
    }
    if (dropped > 0) {
      runtime.droppedQueueItems = (runtime.droppedQueueItems ?? 0) + dropped;
      this.resetHold(runtime);
    }
    this.persistQueue(runtime);
    this.background('queue drain', () => this.drain(runtime, false));
  }

  private async drain(
    runtime: MemberRuntime,
    countHoldCycle = false,
    suppliedBatch?: AgentStateBatch
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (runtime.queue.length === 0) {
      this.resetHold(runtime);
      return;
    }
    if (runtime.pausedByOperator) {
      return;
    }
    if (runtime.draining) {
      // A drain holds this lock for at most a bounded sequence of timed spawns.
      // Held past the watchdog means the awaiting call is wedged — reclaim it so
      // the queue is never stranded. Falling through bumps drainGeneration below,
      // which makes the wedged coroutine bail at its next await instead of
      // double-delivering (single-flight).
      if (runtime.deliveryInFlight || this.now() - (runtime.drainingSince ?? 0) < this.drainWatchdogMs) {
        this.recordHold(runtime, 'draining', countHoldCycle);
        return;
      }
      runtime.draining = false; // reclaim the wedged lock
    }
    // Single-flight token: this coroutine owns the current generation. A
    // concurrent (e.g. watchdog-reclaimed) drain bumps the generation; we
    // re-check it after every await below and bail BEFORE any paste or queue
    // mutation, so a prompt is never double-delivered. This block runs to the
    // first await without yielding, so the assignment is atomic.
    const generation = ++runtime.drainGeneration;
    runtime.draining = true;
    runtime.drainingSince = this.now();
    try {
      const next = runtime.queue[0];
      if (!next) {
        this.resetHold(runtime);
        return;
      }
      const headSeq = next.seq;
      const batch = suppliedBatch ?? await this.readStateBatch();
      const decision = canonicalDeliveryDecision(batch, runtime.sessionId, this.now());
      if (process.env.DESK_CHANNELS_DEBUG) {
        try {
          // Not /tmp: a fixed name in a world-writable directory is a symlink
          // another local user can plant before Desk starts, which would make
          // this append write through to whatever they aimed it at. The trace
          // also names sessions. The engine's own state directory is already
          // private to the operator, so keep the trace beside the queues.
          const debugDir = join(this.options.home, '_engine');
          mkdirSync(debugDir, { recursive: true, mode: 0o700 });
          appendFileSync(
            join(debugDir, 'debug.log'),
            `${new Date().toISOString()} drain ${runtime.sessionId} kind=${next.kind ?? 'message'} deliver=${decision.deliver} queued=${runtime.queue.length}\n`
          );
        } catch {
          // tracing must never break delivery
        }
      }
      if (runtime.drainGeneration !== generation) {
        return;
      }
      const currentHead = runtime.queue[0];
      if (this.disposed || !currentHead || currentHead.seq !== headSeq) {
        if (!currentHead) {
          this.resetHold(runtime);
        }
        return;
      }
      if (!decision.deliver) {
        this.recordHold(runtime, decision.reason, countHoldCycle);
        return;
      }
      if (runtime.deliveryBlock) {
        runtime.lastReleaseAt = new Date().toISOString();
        this.pushDeliveryEvent({ kind: 'released', sessionId: runtime.sessionId });
      }
      this.resetHold(runtime);
      await this.deliverNext(runtime, countHoldCycle, undefined, generation);
    } finally {
      if (runtime.drainGeneration === generation) {
        runtime.draining = false;
      }
    }
  }

  /**
   * Delivers the head item — or a digest of the queued channel messages — to the
   * agent, removes it from the queue, persists, records activity, and kicks off
   * submit verification. The caller MUST hold the draining lock and have already
   * decided the agent is eligible (drain's gates, or a forced operator override
   * from the ops console). Returns whether the push reached the session's terminal.
   */
  private async deliverNext(
    runtime: MemberRuntime,
    countHoldCycle = false,
    forceSeq?: number,
    generation = runtime.drainGeneration
  ): Promise<boolean> {
    // forceSeq targets a specific queue item (operator force-deliver by seq);
    // otherwise the head. A forced single-seq delivery never coalesces — the
    // operator is retrying THAT item, not flushing the whole backlog.
    const next = forceSeq !== undefined ? runtime.queue.find((item) => item.seq === forceSeq) : runtime.queue[0];
    if (!next) {
      return false;
    }
    // Coalescing: two or more channel messages waiting means the agent was
    // busy while they piled up — feeding them one per turn would block it
    // for N more turns. One digest delivers the whole backlog; the agent
    // reads the channel itself. Standalone prompts (onboarding) never
    // coalesce: their content is not in the channel. A 'prompt' at the
    // head delivers verbatim; queued messages digest on the next drain.
    const digestItems =
      forceSeq === undefined && next.kind !== 'prompt' ? runtime.queue.filter((item) => item.kind !== 'prompt') : [];
    const digest = digestItems.length >= 2;
    // The seq(s) this delivery covers — one for a verbatim prompt, the whole
    // coalesced set for a digest — so submit-state transitions report the exact
    // queue item(s) for the durability layer's per-file renames.
    const deliveredSeqs = digest ? digestItems.map((item) => item.seq) : [next.seq];
    const notificationId = digest ? `digest-${deliveredSeqs.join('-')}-${next.messageId}` : next.messageId;
    const info = this.sessionInfo(runtime.sessionId);
    const native = info?.uiMode === 'native';
    // A shell member is not an agent. It never reports `working`, has no input
    // box an Enter could be eaten by and no structural approval menu, so the
    // verify cycle can never find the positive evidence it looks for — while
    // the shell DOES echo the paste, so the pane always changes. Running it
    // therefore produced `submit-stuck-submit` for every prompt to a shell by
    // construction: a false failure that blocked the queue and buried real
    // incidents (desk#48). There is no submit to verify here, so we do not
    // pretend either way; the outcome is recorded as submit-not-applicable.
    const shell = isShellAgent(info?.agent);
    const needsTerminalVerify = next.kind === 'prompt' && !native && !shell;
    // Prompts held a long time (busy agent, dead session, restarts) carry
    // a staleness note so the agent weighs them against newer context.
    const ageMs = this.now() - Date.parse(next.queuedAt);
    const payload = digest
      ? buildDigestPrompt(digestItems, this.options.home, notificationId)
      : Number.isFinite(ageMs) && ageMs > this.staleAfterMs
        ? `(delayed delivery — this message was posted ${Math.round(ageMs / 60000)} minutes ago; read the channel for the current state before acting)\n${next.prompt}`
        : next.prompt;
    // Standalone terminal prompts retain delivery-only verification. Raw capture
    // bytes classify paste/submit failure; they never contribute agent activity.
    const preFingerprint = needsTerminalVerify
      ? await this.captureDeliveryFingerprint(runtime.sessionId)
      : null;
    const current = forceSeq === undefined
      ? runtime.queue[0]
      : runtime.queue.find((item) => item.seq === forceSeq);
    if (
      this.disposed ||
      runtime.drainGeneration !== generation ||
      !current ||
      current.seq !== next.seq
    ) {
      return false;
    }
    // Claim only after every pre-paste await and identity check. The durability
    // slice still renames <seq>.json -> .delivering before the physical send,
    // while a stale drain cannot claim or paste an obsolete queue head.
    this.setSubmitState(runtime, 'delivering', deliveredSeqs);
    runtime.lastDeliveryMs = this.now();
    runtime.deliveryInFlight = true;
    let delivered: boolean;
    let deliveryTimedOut = false;
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        delivered = await Promise.race([
          this.sendText(runtime.sessionId, payload),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => {
              deliveryTimedOut = true;
              resolve(false);
            }, DELIVERY_SEND_TIMEOUT_MS);
          })
        ]);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
    } finally {
      runtime.deliveryInFlight = false;
    }
    if (!delivered) {
      // The paste failed, so this delivery never reaches verifySubmitted to
      // resolve the 'delivering' claim made above. Clear it here, or the drain
      // double-feed guard (submitState==='delivering') would hold the queue
      // forever — the very stuck-flag class this refactor removes. The item is
      // still queued (not shifted) and the .delivering ack-file is reclaimed
      // idempotently on the next delivery attempt.
      runtime.submitState = undefined;
      runtime.submitStateSeqs = undefined;
      if (deliveryTimedOut) {
        // The transport may still settle after the timeout. Do not retry: a
        // late paste plus a retry would duplicate the prompt.
        runtime.queue = runtime.queue.filter((item) => item.seq !== next.seq);
        this.persistQueue(runtime);
      }
      this.recordHold(runtime, 'send-failed', countHoldCycle);
      // Allow a future re-dispatch of this id if the queue entry is ever lost.
      return false; // session vanished mid-push — the pump retries
    }
    if (digest) {
      const digestSeqs = new Set(digestItems.map((item) => item.seq));
      runtime.queue = runtime.queue.filter((item) => !digestSeqs.has(item.seq));
    } else {
      // Remove the delivered item by seq (it may not be at index 0 under forceSeq).
      runtime.queue = runtime.queue.filter((item) => item.seq !== next.seq);
    }
    runtime.lastDeliveryAt = new Date().toISOString();
    this.resetHold(runtime);
    this.persistQueue(runtime);
    this.pushActivity({
      kind: 'delivery',
      channel: next.channel,
      file: next.file ?? 'root.md',
      messageId: digest ? `digest-${digestItems.length}-${next.messageId}` : next.messageId,
      author: digest ? 'desk' : next.author,
      target: runtime.sessionId,
      preview: payload.split('\n')[0]?.slice(0, 140) ?? ''
    });
    if (needsTerminalVerify) {
      // Fire-and-forget: verification sleeps between checks and must not
      // hold the drain lock.
      this.background('submit verification', () => this.verifySubmitted(runtime, preFingerprint, deliveredSeqs));
    } else {
      this.setSubmitState(runtime, shell ? 'submit-not-applicable' : 'submitted', deliveredSeqs);
    }
    return true;
  }

  /**
   * Record a delivery's submit-state on the runtime and notify the durability
   * consumer for each affected queue item. A single delivery covers one seq;
   * a coalesced digest covers several, so the callback fires once per seq while
   * the runtime carries the latest state for the ops console.
   */
  private setSubmitState(runtime: MemberRuntime, state: SubmitState, seqs: number[]): void {
    runtime.submitState = state;
    runtime.submitStateSeqs = [...seqs];
    for (const seq of seqs) {
      const key = this.deliveryEventKey(runtime.sessionId, seq);
      if (state === 'delivering') {
        const item = runtime.queue.find((queued) => queued.seq === seq);
        if (item) {
          this.deliveryEventContext.set(key, this.queuedEventContext(item));
        }
      }
      const context = this.deliveryEventContext.get(key);
      this.pushDeliveryEvent({
        kind: state,
        sessionId: runtime.sessionId,
        channel: context?.channel,
        messageId: context?.messageId,
        preview: context?.preview
      });
      if (state !== 'delivering') {
        this.deliveryEventContext.delete(key);
      }
    }
    if (this.onSubmitStateChange) {
      for (const seq of seqs) {
        this.onSubmitStateChange(runtime.sessionId, state, { seq });
      }
    }
  }

  /**
   * Revert each given .stuck-* ack-file back to .json (retryStuckItem) and push
   * the item onto the runtime queue so the drain re-delivers it. This is an
   * OPERATOR action now (force-deliver over a durable stuck item): delivery is
   * no longer gated on observability, so an automatic re-enqueue would paste
   * again with no evidence the first paste missed.
   */
  private reenqueueStuck(runtime: MemberRuntime, seqs: number[]): boolean {
    const dir = this.queueDir(runtime.sessionId);
    let revived = false;
    for (const seq of seqs) {
      if (!retryStuckItem(this.options.home, runtime.sessionId, seq)) {
        continue; // no stuck file (already dropped / never marked) — skip
      }
      const item = readQueueItem(dir, `${String(seq).padStart(10, '0')}.${EXT_QUEUED}`);
      if (item && !runtime.queue.some((queued) => queued.seq === item.seq)) {
        runtime.queue.push(item);
        this.pushQueuedDeliveryEvent(runtime.sessionId, item);
        revived = true;
      }
    }
    if (revived) {
      this.persistQueue(runtime);
    }
    return revived;
  }

  private async verifySubmitted(
    runtime: MemberRuntime,
    preFingerprint: string | null,
    seqs: number[]
  ): Promise<void> {
    let everObservable = false;
    let captureChanged = false;
    for (let attempt = 0; attempt < this.verifyCycles; attempt += 1) {
      await delay(this.enterVerifyDelayMs);
      if (this.disposed) {
        return;
      }
      const batch = await this.readStateBatch();
      const view = canonicalAgentView(batch, runtime.sessionId, this.now());
      if (view.activity === 'working' || view.activity === 'blocked') {
        this.setSubmitState(runtime, 'submitted', seqs);
        return;
      }
      const fingerprint = await this.captureDeliveryFingerprint(runtime.sessionId);
      if (fingerprint !== null) {
        everObservable = true;
        if (preFingerprint !== null && fingerprint !== preFingerprint) {
          captureChanged = true;
        }
      }
      if (view.activity === 'idle') {
        await this.sendEnter(runtime.sessionId);
      }
    }
    if (this.disposed) {
      return;
    }
    if (everObservable && preFingerprint !== null) {
      this.setSubmitState(runtime, captureChanged ? 'submit-stuck-submit' : 'submit-stuck-paste', seqs);
    } else {
      // We never read the pane during the whole verify window, so we have NO
      // evidence either way: the paste may have landed and been invisible, or
      // never landed at all. Re-pasting on that is a coin flip that duplicates
      // the prompt into the agent's context when it lands on the wrong side.
      //
      // This used to be safe because the drain held an unobservable session,
      // so a re-enqueued item waited until the pane could be read again. That
      // hold is gone — activity and observability no longer gate delivery —
      // so a re-enqueue here delivers immediately and blind, up to the retry
      // cap. Leave the durable .stuck-unobservable for the operator instead:
      // force-deliver is a deliberate act with a human deciding the risk.
      this.setSubmitState(runtime, 'submit-stuck-unobservable', seqs);
    }
  }

  /**
   * Queues a non-message prompt. It releases on the same canonical decision as
   * any other item — the kind buys no wait — and differs only afterwards, in
   * whether the submit is verified against the terminal.
   */
  enqueuePrompt(sessionId: string, channel: string, prompt: string, idHint: string): void {
    if (this.disposed) {
      return;
    }
    this.enqueue(sessionId, {
      channel,
      messageId: `${idHint}-${this.now().toString(36)}`,
      author: 'desk',
      prompt,
      target: sessionId,
      preview: prompt.split('\n')[0]?.slice(0, 140) ?? '',
      kind: 'prompt'
    });
  }

  /** Operator pause: intentional hold, never counted as blocked/stuck. */
  pauseSession(sessionId: string, reason?: string, pausedAt = new Date().toISOString()): void {
    const runtime = this.runtime(sessionId);
    const cleanReason = reason?.replace(/\s+/g, ' ').trim();
    runtime.pausedByOperator = { since: pausedAt, reason: cleanReason || undefined };
    this.resetHold(runtime);
    this.pushDeliveryEvent({ kind: 'paused', sessionId, reason: cleanReason || undefined });
  }

  /** Clears an operator pause and resumes normal gated draining. */
  resumeSession(sessionId: string): void {
    const runtime = this.members.get(sessionId);
    if (!runtime) {
      return;
    }
    runtime.pausedByOperator = undefined;
    this.resetHold(runtime);
    this.pushDeliveryEvent({ kind: 'resumed', sessionId });
    this.background('queue drain', () => this.drain(runtime, false));
  }

  dropQueue(sessionId: string): void {
    // Drop durable stuck items too — dropQueue clears the whole backlog,
    // including .stuck-* surfaced for the operator (works even with no runtime).
    for (const stuck of listStuckItems(this.options.home, sessionId)) {
      if (dropStuckItem(this.options.home, sessionId, stuck.seq)) {
        this.pushDroppedDeliveryEvent(sessionId, stuck.item);
      }
    }
    const runtime = this.members.get(sessionId);
    if (runtime) {
      for (const item of runtime.queue) {
        this.pushDroppedDeliveryEvent(sessionId, item);
      }
      runtime.queue = [];
      this.resetHold(runtime);
      this.persistQueue(runtime);
    }
  }

  /** Ops console: remove a single queued item by seq. Returns whether it existed. */
  dropMessage(sessionId: string, seq: number): boolean {
    const runtime = this.members.get(sessionId);
    if (runtime) {
      const before = runtime.queue.length;
      const headSeq = runtime.queue[0]?.seq;
      const dropped = runtime.queue.find((item) => item.seq === seq);
      runtime.queue = runtime.queue.filter((item) => item.seq !== seq);
      if (runtime.queue.length !== before) {
        if (dropped) {
          this.pushDroppedDeliveryEvent(sessionId, dropped);
        }
        if (seq === headSeq) {
          this.resetHold(runtime);
        }
        this.persistQueue(runtime);
        return true;
      }
    }
    // Not in the runtime queue — maybe a durable stuck item on disk.
    const stuck = listStuckItems(this.options.home, sessionId).find((item) => item.seq === seq);
    const dropped = dropStuckItem(this.options.home, sessionId, seq);
    if (dropped && stuck) {
      this.pushDroppedDeliveryEvent(sessionId, stuck.item);
    }
    return dropped;
  }

  /**
   * Ops console: deliver the head item NOW, bypassing the busy/ready/boot gates.
   * Operator override — can land inside a working agent's turn — so it is only
   * reachable from the console behind a confirm. Returns whether the push landed.
   */
  async forceDeliver(sessionId: string, seq?: number): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    const runtime = this.members.get(sessionId);
    const batch = await this.readStateBatch();
    if (!runtime || canonicalAgentView(batch, sessionId, this.now()).lifecycle !== 'running') {
      return false;
    }
    if (seq !== undefined) {
      // Target a specific item: if it is not in the runtime queue it is a durable
      // stuck file — revive it (.stuck-* to .json to enqueue) so deliverNext can
      // deliver that exact seq.
      if (!runtime.queue.some((item) => item.seq === seq) && !this.reenqueueStuck(runtime, [seq])) {
        return false; // neither queued nor a stuck file for this seq
      }
    } else if (runtime.queue.length === 0) {
      // No seq + nothing queued — revive the head durable stuck item.
      const stuck = listStuckItems(this.options.home, sessionId)[0];
      if (!stuck || !this.reenqueueStuck(runtime, [stuck.seq])) {
        return false;
      }
    }
    // Respect a physical paste regardless of watchdog age. The watchdog may
    // reclaim a pre-paste await, but it must never launch a second paste while
    // the first sendText call is still unresolved.
    if (
      runtime.deliveryInFlight ||
      (runtime.draining && this.now() - (runtime.drainingSince ?? 0) < this.drainWatchdogMs)
    ) {
      return false;
    }
    const generation = ++runtime.drainGeneration;
    runtime.draining = true;
    runtime.drainingSince = this.now();
    try {
      this.resetHold(runtime);
      return await this.deliverNext(runtime, false, seq, generation);
    } finally {
      if (runtime.drainGeneration === generation) {
        runtime.draining = false;
      }
    }
  }

  /** Ops console: queued prompts for a session, body-trimmed to a preview. */
  queuedItems(sessionId: string): QueuedItemMeta[] {
    const runtime = this.members.get(sessionId);
    if (!runtime) {
      return [];
    }
    return runtime.queue.map((item) => ({
      seq: item.seq,
      channel: item.channel,
      messageId: item.messageId,
      author: item.author,
      queuedAt: item.queuedAt,
      kind: item.kind ?? 'message',
      preview: item.prompt.split('\n').find((line) => line.trim() !== '')?.slice(0, 140) ?? ''
    }));
  }

  /** Ops console: durable unobservable stuck files are actionable; legacy submit/paste stuck files stay historical. */
  private blockedItems(sessionId: string): BlockedItemMeta[] {
    return listStuckItems(this.options.home, sessionId)
      .filter((stuck) => stuck.kind === 'unobservable')
      .map((stuck) => ({
        seq: stuck.seq,
        kind: stuck.kind,
        channel: stuck.item.channel,
        messageId: stuck.item.messageId,
        author: stuck.item.author,
        queuedAt: stuck.item.queuedAt,
        preview: stuck.item.prompt.split('\n').find((line) => line.trim() !== '')?.slice(0, 140) ?? ''
      }));
  }

  private canonicalFields(view: CanonicalAgentView): Pick<
    LifecycleState,
    'authorityRevision' | 'lifecycle' | 'activity' | 'waitOwner' | 'waitKind' | 'waitDetail' | 'actionable'
  > {
    return {
      authorityRevision: view.authorityRevision,
      lifecycle: view.lifecycle,
      activity: view.activity,
      waitOwner: view.wait?.owner,
      waitKind: view.wait?.kind,
      waitDetail: view.wait?.detail,
      actionable: view.actionable
    };
  }

  private deriveDeliveryStatus(
    runtime: MemberRuntime | undefined,
    block: Pick<SessionDiagnostic, 'deliveryBlocked'>,
    stuckOnDisk: readonly BlockedItemMeta[]
  ): DeliveryStatus {
    if (!runtime) {
      // No runtime, but durable stuck items on disk: the status answers "is
      // there work and why is it not moving", so it is `submit-stuck`, not a
      // label about registration that would hide the work an operator must
      // unblock. Only a session with neither runtime nor durable items is
      // truly unregistered.
      return stuckOnDisk.length > 0 ? 'submit-stuck' : 'unregistered';
    }
    if (runtime.pausedByOperator) {
      return 'paused';
    }
    if (runtime.submitState === 'submit-stuck-paste' || runtime.submitState === 'submit-stuck-submit') {
      return 'submit-stuck';
    }
    if (block.deliveryBlocked) {
      return 'blocked';
    }
    if (runtime.deliveryInFlight || runtime.submitState === 'delivering') {
      return 'delivering';
    }
    return runtime.queue.length > 0 ? 'queued' : 'ready';
  }

  private inspectSessionFromBatch(sessionId: string, batch: AgentStateBatch): SessionDiagnostic {
    const runtime = this.members.get(sessionId);
    const block = this.runtimeBlock(runtime);
    const stuckItems = this.blockedItems(sessionId);
    const pause = runtime?.pausedByOperator;
    const view = canonicalAgentView(batch, sessionId, this.now());
    return {
      sessionId,
      ...this.canonicalFields(view),
      queueDepth: runtime?.queue.length ?? 0,
      deliveryStatus: this.deriveDeliveryStatus(runtime, block, stuckItems),
      pausedByOperator: Boolean(pause),
      pauseReason: pause?.reason,
      pausedAt: pause?.since,
      draining: runtime?.draining ?? false,
      lastDeliveryAt: runtime?.lastDeliveryAt,
      lastReleaseAt: runtime?.lastReleaseAt,
      submitState: runtime?.submitState,
      ...block,
      droppedQueueItems: runtime?.droppedQueueItems ?? 0,
      blockedItems: stuckItems,
      items: this.queuedItems(sessionId),
      ...this.resumeInfo(sessionId)
    };
  }

  /** Ops console: full per-session diagnostic from one canonical authority read. */
  async inspectSession(sessionId: string): Promise<SessionDiagnostic> {
    return this.inspectSessionFromBatch(sessionId, await this.readStateBatch());
  }

  /** Ops console: every row shares one authority batch revision. */
  async inspectAll(): Promise<SessionDiagnostic[]> {
    const batch = await this.readStateBatch();
    return [...this.members.keys()].map((sessionId) => this.inspectSessionFromBatch(sessionId, batch));
  }

  /** Nudge every canonically idle queued session through the normal gate. */
  async drainReady(): Promise<string[]> {
    const batch = await this.readStateBatch();
    const nudged: string[] = [];
    for (const runtime of this.members.values()) {
      if (runtime.queue.length === 0) {
        continue;
      }
      if (canonicalDeliveryDecision(batch, runtime.sessionId, this.now()).deliver) {
        this.resetHold(runtime);
        this.background('queue drain', () => this.drain(runtime, false, batch));
        nudged.push(runtime.sessionId);
      }
    }
    return nudged;
  }

  /** True while the background delivery pump is scheduled (false once disposed). */
  pumpAlive(): boolean {
    return !this.disposed && this.pumpTimer !== undefined;
  }

  private effectiveBlock(
    runtime: MemberRuntime | undefined
  ): Pick<SessionDiagnostic, 'deliveryBlocked' | 'blockedReason' | 'blockedSince' | 'blockedCycles' | 'blockedHeadSeq'> {
    return this.runtimeBlock(runtime);
  }

  /** Hot footer projection; every row comes from one authority batch revision. */
  async lifecycleStates(): Promise<LifecycleState[]> {
    const batch = await this.readStateBatch();
    return [...this.members.values()].map((runtime) => {
      const block = this.effectiveBlock(runtime);
      const stuckItems = this.blockedItems(runtime.sessionId);
      const view = canonicalAgentView(batch, runtime.sessionId, this.now());
      return {
        sessionId: runtime.sessionId,
        ...this.canonicalFields(view),
        queueDepth: runtime.queue.length,
        deliveryStatus: this.deriveDeliveryStatus(runtime, block, stuckItems),
        lastDeliveryAt: runtime.lastDeliveryAt,
        lastReleaseAt: runtime.lastReleaseAt,
        submitState: runtime.submitState,
        pausedByOperator: Boolean(runtime.pausedByOperator),
        pauseReason: runtime.pausedByOperator?.reason,
        pausedAt: runtime.pausedByOperator?.since,
        deliveryBlocked: block.deliveryBlocked,
        blockedReason: block.blockedReason,
        blockedItemCount: stuckItems.length,
        droppedQueueItems: runtime.droppedQueueItems ?? 0
      };
    });
  }

  listActivity(sinceSeq = 0): ChannelActivityEvent[] {
    return this.activity.filter((event) => event.seq > sinceSeq);
  }

  latestActivitySeq(): number {
    return this.activitySeq;
  }

  private resumeInfo(sessionId: string): Partial<SessionResumeInfo> {
    const info = this.sessionInfo(sessionId);
    if (!info) {
      return {};
    }
    return { ...info, hasResume: info.hasResume ?? Boolean(info.resume) };
  }
}
