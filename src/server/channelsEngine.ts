import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  mentionsHuman,
  resolveTargets,
  type ChannelMember,
  type ChannelMessage,
  type LifecycleState,
  type LifecycleStatus,
  type ChannelActivityEvent,
  type PaneState,
  type SessionResumeInfo,
  type SubmitState,
  type DeliveryBlockReason,
  type QueuedItemMeta,
  type BlockedItemMeta,
  type SessionDiagnostic
} from './channelsProtocol.js';
import {
  createSessionProbe,
  footerHash,
  tailPaneCapture,
  type SessionProbe,
  type SessionProbeSnapshot
} from './channelsProbe.js';
import { listChannelMembers, readChannelMessage, type IncomingChannelMessage } from './channelsStore.js';
import {
  classifyQueueFile,
  dropStuckItem,
  EXT_CONSUMED,
  EXT_DELIVERING,
  EXT_DELIVERED,
  EXT_QUEUED,
  EXT_STUCK_UNOBSERVABLE,
  listStuckItems,
  readQueueItem,
  retryStuckItem,
  sweepDeliveredTtl
} from './channelsDurability.js';
import { appendDeliveryEvent, type DeliveryEvent } from './channelsEvents.js';
import { listPausedSessions } from './channelsPaused.js';
import { writeFileAtomic } from './fsOps.js';
import { AgentPresenceModel } from './agentPresence.js';
import type { AgentEventV2 } from './agentEvents.js';

/**
 * Channels engine — per-agent delivery queues gated on desk's agent signals.
 *
 * Every finalised channel message is resolved to its @mention targets; each
 * target gets a prompt queued under its tmux session. A queued prompt is
 * pushed into the agent terminal (tmux send-keys: literal body, pause, Enter)
 * only while the agent's input is released:
 *
 *   - delivery marks the agent BUSY (its turn is now in flight);
 *   - a turn-complete / bell signal (the same events that light the desk
 *     notification lamp) releases it and drains the next queued prompt;
 *   - approval-requested does NOT release — the agent is waiting on a human
 *     and injected text would answer the approval dialog.
 *
 * Queues survive server restarts via _engine/queue/<tmux>/<seq>.json files.
 */

export type AgentSignalKind = 'turn-complete' | 'approval-requested' | 'input-requested' | 'bell';

export interface QueuedPrompt {
  seq: number;
  channel: string;
  messageId: string;
  author: string;
  prompt: string;
  queuedAt: string;
  /** 'prompt' = standalone briefing (onboarding) that must deliver verbatim;
      absent/'message' = channel dispatch, eligible for digest coalescing */
  kind?: 'message' | 'prompt';
  /** conversation file the message lives in (root.md / thread-…) — digest pointer */
  file?: string;
  /** the receiving member's channel handle (for --as in digest instructions) */
  member?: string;
}

// MemberDeliveryState / PaneState / SubmitState / DeliveryBlockReason /
// QueuedItemMeta / SessionDiagnostic are DEFINED in channelsProtocol.ts now —
// one source shared with the web client (channelsClient re-exports the same
// definitions). Imported above for local use and re-exported here so existing
// server-side importers keep resolving against the engine module.
export type {
  LifecycleState,
  LifecycleStatus,
  PaneState,
  SubmitState,
  DeliveryBlockReason,
  QueuedItemMeta,
  BlockedItemMeta,
  SessionDiagnostic,
  ChannelActivityEvent,
  SessionResumeInfo
};

export interface ChannelsEngineOptions {
  home: string;
  /** push a prompt into a tmux session; resolved implementation is injectable for tests */
  sendText?: (tmuxSession: string, text: string) => Promise<boolean>;
  sessionRunning?: (tmuxSession: string) => boolean;
  /** capture the tail of a session's pane (injectable for tests); null = capture failed */
  capturePane?: (tmuxSession: string) => Promise<string | null>;
  /** bare Enter keypress for the submit-verification retry (injectable for tests) */
  sendEnter?: (tmuxSession: string) => Promise<boolean>;
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
  /** probe cache TTL ms for non-mutating diagnostic reads; 0 = always fresh */
  probeTtlMs?: number;
  /** max ms for non-mutating diagnostic probes before surfacing unobservable and clearing the cache */
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
  onSubmitStateChange?: (tmuxSession: string, state: SubmitState, context: { seq: number }) => void;
  /** prompts older than this at delivery time get a delayed-delivery note */
  staleAfterMs?: number;
  /** manifest/session read model used by the resume inspector (no shelling from the engine) */
  sessionInfo?: (tmuxSession: string) => (Omit<SessionResumeInfo, 'hasResume'> & { hasResume?: boolean }) | undefined;
  /** never deliver to a tmux session younger than this (TUIs swallow input while booting) */
  bootGraceMs?: number;
  /** epoch-seconds session creation lookup (injectable for tests) */
  sessionCreatedAt?: (tmuxSession: string) => Promise<number | null>;
  /** current process id (injectable for the single-engine guard tests) */
  pid?: number;
  /** liveness probe for the pid in the lock file (injectable for tests) */
  pidAlive?: (pid: number) => boolean;
  /** raw process start-time probe for PID-reuse detection (injectable for tests).
   *  Returns the OS's raw start-time value (Linux: jiffies since boot) or null
   *  when unavailable; equality test against the recorded value is the reuse guard. */
  pidStarttimeReader?: (pid: number) => number | null;
}

const MAX_ACTIVITY_EVENTS = 300;
const MAX_DELIVERED_MEMORY = 2000;
/** Runaway-conversation backstop: a session's queue never grows past this. */
const MAX_QUEUE_PER_SESSION = 50;
/**
 * Backstop cap for the single-engine lockfile: a lock older than this is
 * presumed stale even if its holder pid reports alive — defends against
 * PID reuse on platforms where the start-time reader returns null (non-Linux).
 * On Linux the start-time equality check reclaims immediately, so this cap
 * only ever fires as a portable fallback.
 */
const ENGINE_LOCK_STALE_MS = 30_000;

/**
 * Parses the engine lockfile's two-line format: `${pid}\n${starttimeRaw}\n`.
 * Returns null when the pid line is missing/unparseable. The starttime line
 * is optional (older lockfiles omit it; non-Linux writers omit it too) —
 * null starttime means the caller must fall back to the age-based stale check.
 */
function parsePidFile(content: string): { pid: number; starttime: number | null } | null {
  const lines = content.split('\n');
  const pid = Number(lines[0] ?? '');
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const starttimeRaw = lines[1]?.trim();
  if (starttimeRaw === undefined || starttimeRaw === '') {
    return { pid, starttime: null };
  }
  const starttime = Number(starttimeRaw);
  return { pid, starttime: Number.isFinite(starttime) ? starttime : null };
}

function threadParentIdFromFile(file: string): string | undefined {
  return /^thread-(msg-[A-Za-z0-9-]+)\.md$/.exec(file)?.[1];
}

export function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the RAW process start-time for a pid — the value used to detect PID
 * reuse. On Linux, parses `/proc/<pid>/stat` field 22 (jiffies since boot);
 * returns null on any other platform or when the pid is unreadable/dead.
 *
 * The value is intentionally UNNORMALIZED (raw jiffies, not ms). Equality
 * comparison between a recorded and a current value works in the same units
 * and sidesteps the _SC_CLK_TCK-not-always-100 edge — same process always
 * reads the same raw value; a reused pid reads a different one.
 */
export function defaultPidStarttimeReader(pid: number): number | null {
  if (process.platform !== 'linux') {
    return null;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The comm field (2) is wrapped in parens and CAN contain whitespace when
    // the executable path has spaces. Strip everything up to the last ')'.
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) {
      return null;
    }
    const tail = stat.slice(closeParen + 2).split(/\s+/);
    // After the comm-close-paren, fields are 3..N. Field 22 in 1-indexed
    // stat(2) terms = index 22 - 3 = 19 in our 0-indexed tail array.
    const starttime = Number(tail[19]);
    return Number.isFinite(starttime) ? starttime : null;
  } catch {
    return null;
  }
}

/**
 * Hard ceiling for any tmux child the engine spawns. A spawned `tmux` process
 * that never emits `exit`/`error` — observed under heavy fleet load on WSL —
 * would otherwise leave the awaiting drain/reconcile suspended forever, which
 * permanently wedges that session's queue (the flag it set never clears). Every
 * spawn here MUST settle; this timeout guarantees it.
 */
export const TMUX_SPAWN_TIMEOUT_MS = 4000;
const DEFAULT_ENGINE_PROBE_TTL_MS = 750;
const DIAGNOSTIC_PROBE_TIMEOUT_GRACE_MS = 250;

export interface SpawnSettledResult {
  ok: boolean;
  /** captured stdout on a clean exit; null on failure/timeout (or capture off) */
  stdout: string | null;
}

/**
 * Spawns a command and ALWAYS resolves: on `close`, on `error`, or — critically —
 * after `timeoutMs`, when the child is SIGKILLed and a failure result returned.
 * The unconditional settle is the contract every engine spawn relies on; a
 * promise that can hang forever is exactly what froze channel delivery.
 *
 * Captured stdout is read on `close`, NOT `exit`: `exit` fires when the process
 * terminates, but buffered stdout may not have been emitted as `data` yet, so
 * reading there truncates the capture — to EMPTY for larger panes under the
 * concurrent capture burst the pump/restore generate. An empty pane reads as
 * "not ready", so drain held those queues forever. `close` fires only once all
 * stdio streams have drained, so the capture is complete.
 */
export function spawnSettled(
  command: string,
  args: string[],
  opts: { capture: boolean; timeoutMs?: number }
): Promise<SpawnSettledResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', opts.capture ? 'pipe' : 'ignore', 'ignore'] });
    let output = '';
    let settled = false;
    const finish = (result: SpawnSettledResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone — the finish below still settles the promise
      }
      finish({ ok: false, stdout: null });
    }, opts.timeoutMs ?? TMUX_SPAWN_TIMEOUT_MS);
    timer.unref?.();
    if (opts.capture) {
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
    }
    child.on('error', () => finish({ ok: false, stdout: null }));
    child.on('close', (code) => finish({ ok: code === 0, stdout: code === 0 ? output : null }));
  });
}

export function defaultSessionRunning(tmuxSession: string): boolean {
  // `timeout` bounds the sync call so a stuck tmux server can't block the event
  // loop; a timed-out probe reports not-running, so the queue safely holds.
  return (
    spawnSync('tmux', ['has-session', '-t', `=${tmuxSession}`], {
      encoding: 'utf8',
      timeout: TMUX_SPAWN_TIMEOUT_MS
    }).status === 0
  );
}

/** Last ~30 pane lines of the session's active pane (null when capture fails). */
export async function defaultCapturePane(tmuxSession: string): Promise<string | null> {
  const result = await spawnSettled('tmux', ['capture-pane', '-p', '-t', `${tmuxSession}:`], { capture: true });
  return result.stdout === null ? null : tailPaneCapture(result.stdout);
}

// The pane predicates now live in channelsProbe.ts (one classifier shared by
// drain, verify, signal-release, and the ops console). Re-exported here so
// existing importers keep resolving them from the engine module.
export { isPaneBusy, isPaneReadyForInput, paneFooterRegion, tailPaneCapture } from './channelsProbe.js';

/** Epoch-seconds tmux session creation time (null when unknown). */
export async function defaultSessionCreatedAt(tmuxSession: string): Promise<number | null> {
  const result = await spawnSettled('tmux', ['display-message', '-p', '-t', `${tmuxSession}:`, '#{session_created}'], {
    capture: true
  });
  if (result.stdout === null) {
    return null;
  }
  const created = Number(result.stdout.trim());
  return Number.isFinite(created) && created > 0 ? created : null;
}

let pasteBufferSeq = 0;

/**
 * Pushes a prompt into an agent's tmux pane and submits it.
 *
 * The body is injected with BRACKETED PASTE (`set-buffer` + `paste-buffer -p`),
 * not `send-keys -l`. Agent TUIs (codex, claude) then receive the whole
 * multi-line block as a single atomic paste — they collapse it to a
 * "[Pasted …]" chip — so embedded newlines stay literal and the separate submit
 * Enter always lands as submit. `send-keys -l` instead fed the text through the
 * pane byte-by-byte: codex re-renders its composer per line and treats a CR that
 * arrives before that line-by-line ingest finishes as a literal newline, so a
 * large prompt's submit Enter (and the verify retries) were swallowed and the
 * message sat unsubmitted in the input box — reproducible with big digests and
 * far worse under load, when the TUI renders the paste slower than the fixed
 * delay budget. Bracketed paste removes the race: a single Enter submits even
 * with no delay. `-p` only emits the paste brackets when the app requested
 * bracketed-paste mode, so it is a safe no-op for anything that did not.
 *
 * The Enter is a separate call after a short settle so the pane has processed
 * the paste before the submit key arrives. `run` is injectable for tests.
 */
export async function sendTextToTmux(
  tmuxSession: string,
  text: string,
  enterDelayMs = 1200,
  run: (args: string[]) => Promise<boolean> = runTmux
): Promise<boolean> {
  // `session:` resolves to the session's active pane. The `=name` exact form
  // is only valid for session targets (has-session) — tmux 3.2a rejects it
  // as a pane target.
  const target = `${tmuxSession}:`;
  // Unique buffer per call: deliveries to different sessions run concurrently,
  // and a shared/default buffer would let one paste clobber another mid-flight.
  pasteBufferSeq += 1;
  const buffer = `deskchan_${tmuxSession.replace(/[^A-Za-z0-9_]/g, '_')}_${pasteBufferSeq}`;
  const staged = await run(['set-buffer', '-b', buffer, '--', text]);
  if (!staged) {
    return false;
  }
  // `-p` wraps the data in bracketed-paste control codes (when the TUI asked for
  // them); `-d` deletes the buffer once pasted.
  const pasted = await run(['paste-buffer', '-d', '-p', '-b', buffer, '-t', target]);
  if (!pasted) {
    await run(['delete-buffer', '-b', buffer]); // best-effort: never leak the buffer
    return false;
  }
  await delay(enterDelayMs);
  return run(['send-keys', '-t', target, 'Enter']);
}

/** Bare Enter keypress (used by the submit-verification retry). */
export function sendEnterToTmux(tmuxSession: string): Promise<boolean> {
  return runTmux(['send-keys', '-t', `${tmuxSession}:`, 'Enter']);
}

function runTmux(args: string[]): Promise<boolean> {
  return spawnSettled('tmux', args, { capture: false }).then((result) => result.ok);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildTurnPrompt(options: {
  channel: string;
  file: string;
  member: string;
  author: string;
  message: ChannelMessage;
  home: string;
}): string {
  const threadArg = options.file.startsWith('thread-') ? ` --thread ${options.file.slice('thread-'.length, -3)}` : '';
  return [
    `[#${options.channel}] New message from @${options.author} (${options.message.id}) — you are @${options.member}.`,
    '',
    `1 new message from @${options.author}.`,
    `notificationId:${options.message.id}`,
    `Read message: desk channels read ${options.channel} --message ${options.message.id}`,
    `Read full conversation: desk channels read ${options.channel}`,
    '',
    `Full conversation: ${join(options.home, options.channel, options.file)}`,
    // --as is load-bearing: agents whose exec environment strips TMUX (codex)
    // cannot be identified from the calling shell, and an unidentified post
    // would be misattributed to the human operator.
    `To reply, run: desk channels post ${options.channel}${threadArg} --as ${options.member} "<your message>" — mention members with @name (never @${options.member}). ` +
      `Run \`desk channels read ${options.channel} --message ${options.message.id}\` for this message or \`desk channels read ${options.channel}\` for history.`,
    `When you reference a file, write it as a markdown link with its ABSOLUTE path so the operator can open it in the editor with one click: ` +
      `[src/foo.ts](/abs/path/to/src/foo.ts). Bare or relative paths are not clickable.`,
    `Collaboration contract: when you finish the work this message calls for, post your outcome to the channel (what you did, evidence, who acts next). ` +
      `If it requires nothing from you, post one brief line saying so and why — unless this message is itself a pure acknowledgment/status (then do not reply; never acknowledge acknowledgments). ` +
      `Human guidelines posted in the channel override this cadence.`
  ].join('\n');
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
}): string {
  const roster = options.members
    .filter((member) => member.name !== options.handle)
    .map((member) => `@${member.name} (${member.type === 'human' ? 'human operator' : member.type})`)
    .join(', ');
  return [
    `You have been added to the desk channel #${options.channel} as @${options.handle}. This is a multi-agent collaboration room — you are expected to participate actively, not observe.`,
    '',
    options.goal ? `Channel goal: ${options.goal}` : 'Channel goal: (not set — ask @human if direction is unclear)',
    `Members: ${roster || '(just you and the operator so far)'}`,
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
  ].join('\n');
}

/**
 * Bounded escalation for the probe-timeout / unobservable cascade: after this
 * many CONSECUTIVE auto-retries of a delivered-but-unverifiable item (the pane
 * went unobservable during verify, repeatedly), stop auto-retrying and leave the
 * durable .stuck-unobservable for explicit operator action — instead of looping
 * (re-pasting) forever against a hung pane. Reset on any observed delivery success.
 */
const MAX_UNOBSERVABLE_RETRIES = 5;

interface MemberRuntime {
  tmuxSession: string;
  busy: boolean;
  awaitingApproval: boolean;
  queue: QueuedPrompt[];
  lastDeliveryAt?: string;
  lastReleaseAt?: string;
  draining: boolean;
  /**
   * Single-flight generation. Every drain/forceDeliver attempt captures
   * `++drainGeneration`; after each await it re-checks the runtime value and
   * bails if it changed (a newer attempt, or a watchdog reclaim, superseded it).
   * This is the real guard against the watchdog reclaiming a wedged drain and
   * running a SECOND deliverNext in parallel (the double-paste window).
   */
  drainGeneration: number;
  /** consecutive auto-retries of an unobservable delivery (bounded by MAX_UNOBSERVABLE_RETRIES) */
  unobservableRetries: number;
  /** epoch ms when `draining` was set true (for the wedge watchdog) */
  drainingSince?: number;
  /** epoch ms of the last delivery (for the stale-busy override) */
  lastDeliveryMs?: number;
  /** result of the last delivery's submit verification (drives ack-file renames) */
  submitState?: SubmitState;
  /** seqs covered by the current submitState, for ops diagnostics after queue shift */
  submitStateSeqs?: number[];
  /** notification delivery awaiting UserPromptSubmit/delivery-ack confirmation */
  pendingAck?: {
    notificationId: string;
    seqs: number[];
    payload: string;
    enterRetries: number;
    replays: number;
    timer?: NodeJS.Timeout;
  };
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
  /** intentional operator hold; distinct from busy/stuck and does not count hold cycles */
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
  private activitySeq = 0;
  private queueSeq = 0;
  private disposed = false;
  private readonly sendText: (tmuxSession: string, text: string) => Promise<boolean>;
  private readonly sessionRunning: (tmuxSession: string) => boolean;
  private readonly capturePane: (tmuxSession: string) => Promise<string | null>;
  private readonly sendEnter: (tmuxSession: string) => Promise<boolean>;
  private readonly releaseSettleMs: number;
  private readonly drainWatchdogMs: number;
  private readonly enterVerifyDelayMs: number;
  private readonly verifyCycles: number;
  private readonly blockedAfterCycles: number;
  private readonly probeTimeoutMs: number;
  private readonly onSubmitStateChange?: (tmuxSession: string, state: SubmitState, context: { seq: number }) => void;
  private readonly staleAfterMs: number;
  private readonly sessionInfo: (tmuxSession: string) => (Omit<SessionResumeInfo, 'hasResume'> & { hasResume?: boolean }) | undefined;
  private readonly bootGraceMs: number;
  private readonly sessionCreatedAt: (tmuxSession: string) => Promise<number | null>;
  /** single shared pane classifier — drain, verify, signal-release, and the ops console all read it */
  private readonly probe: SessionProbe;
  private pumpTimer: NodeJS.Timeout | undefined;
  /** delivered (session:messageId) pairs — dispatch dedupe across all paths */
  private readonly delivered = new Set<string>();
  /** queue metadata retained after delivery shift so async submit-state events can be attributed */
  private readonly deliveryEventContext = new Map<string, DeliveryEventContext>();
  private readonly presence = new AgentPresenceModel();
  /** true when another live desk process already owns this channels home */
  readonly passive: boolean;
  /** when passive: the pid of the desk process that owns dispatch, used for the operator recovery hint */
  passiveOwnerPid?: number;

  constructor(private readonly options: ChannelsEngineOptions) {
    this.sendText =
      options.sendText ?? ((session, text) => sendTextToTmux(session, text, options.enterDelayMs ?? 1200));
    this.sessionRunning = options.sessionRunning ?? defaultSessionRunning;
    this.capturePane = options.capturePane ?? defaultCapturePane;
    this.sendEnter = options.sendEnter ?? sendEnterToTmux;
    this.releaseSettleMs = options.releaseSettleMs ?? 800;
    this.drainWatchdogMs = options.drainWatchdogMs ?? 30_000;
    this.enterVerifyDelayMs = options.enterVerifyDelayMs ?? 1200;
    this.verifyCycles = options.verifyCycles ?? 3;
    this.blockedAfterCycles = options.blockedAfterCycles ?? 3;
    this.probeTimeoutMs = options.probeTimeoutMs ?? TMUX_SPAWN_TIMEOUT_MS + DIAGNOSTIC_PROBE_TIMEOUT_GRACE_MS;
    this.onSubmitStateChange = options.onSubmitStateChange;
    this.staleAfterMs = options.staleAfterMs ?? 10 * 60 * 1000;
    this.sessionInfo = options.sessionInfo ?? (() => undefined);
    this.bootGraceMs = options.bootGraceMs ?? 15_000;
    this.sessionCreatedAt = options.sessionCreatedAt ?? defaultSessionCreatedAt;
    // One classifier for the whole engine: it owns sessionRunning(offline),
    // bootGrace(booting), capture(unobservable), and pane classification, so
    // drain/verify/signal/reconcile/inspect share a single source of pane truth.
    // Non-mutating diagnostics use a short TTL; delivery, signal release, and
    // submit verification still pass forceFresh because stale ready/menu state
    // is unsafe for mutating decisions.
    this.probe = createSessionProbe({
      sessionRunning: this.sessionRunning,
      sessionCreatedAt: this.sessionCreatedAt,
      capturePane: this.capturePane,
      bootGraceMs: this.bootGraceMs,
      ttlMs: options.probeTtlMs ?? DEFAULT_ENGINE_PROBE_TTL_MS
    });
    this.passive = !this.acquireEngineLock();
    if (!this.passive) {
      this.restorePausedSessions();
      this.restoreQueues();
      this.startPump(options.pumpIntervalMs ?? 2500);
    }
  }

  /**
   * Single-engine guard: two desk processes serving the same channels home
   * would each dispatch every message — guaranteed double prompts. The first
   * live process owns `_engine/engine.pid`; later ones run passive (reads
   * fine, no dispatch/delivery) until the owner dies.
   *
   * Acquire is atomic via O_EXCL (`openSync` with flag `'wx'`); the lockfile
   * records `${pid}\n${starttimeRaw}\n` so a later process can detect PID
   * reuse — when the OS recycles a dead holder's pid for an unrelated alive
   * process, the recorded starttime no longer matches the current holder's
   * starttime, so the lock is correctly treated as stale and reclaimed.
   * Without this guard, the original code's `pidAlive(holder) === true`
   * check would silently lock the real owner out forever. As a non-Linux
   * backstop (where starttime is unreadable), a lockfile older than
   * ENGINE_LOCK_STALE_MS is also treated as stale.
   */
  private acquireEngineLock(): boolean {
    const pid = this.options.pid ?? process.pid;
    const alive = this.options.pidAlive ?? defaultPidAlive;
    const readStarttime = this.options.pidStarttimeReader ?? defaultPidStarttimeReader;
    const lockPath = join(this.options.home, '_engine', 'engine.pid');
    try {
      mkdirSync(join(this.options.home, '_engine'), { recursive: true });
      // Atomic acquire: O_EXCL means this call is the only one that can
      // create the file across all processes. A concurrent contender that
      // hits EEXIST falls through to the holder inspection below.
      let fd: number | undefined;
      try {
        fd = openSync(lockPath, 'wx');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          throw err;
        }
      }
      if (fd !== undefined) {
        const starttime = readStarttime(pid);
        const payload = starttime === null ? `${pid}\n` : `${pid}\n${starttime}\n`;
        try {
          writeSync(fd, payload);
        } finally {
          closeSync(fd);
        }
        return true;
      }
      // Lock exists — decide whether it is stale (steal) or valid (go passive).
      const parsed = parsePidFile(readFileSync(lockPath, 'utf8'));
      if (parsed === null) {
        // Unparseable — treat as stale and reclaim.
        try {
          unlinkSync(lockPath);
        } catch {
          // race — another process reclaimed it; we'll go passive below
        }
        return this.acquireEngineLock();
      }
      const { pid: holderPid, starttime: recordedStarttime } = parsed;
      if (holderPid === pid) {
        // We are already the recorded owner — re-acquire (vite HMR restart path).
        return true;
      }
      const holderIsDead = !alive(holderPid);
      if (holderIsDead) {
        try {
          unlinkSync(lockPath);
        } catch {
          // race
        }
        return this.acquireEngineLock();
      }
      // PID-reuse detection: holder is alive, but if its current start-time
      // differs from the recorded one, the OS gave a dead holder's pid to an
      // unrelated process. Reclaim.
      if (recordedStarttime !== null) {
        const currentStarttime = readStarttime(holderPid);
        if (currentStarttime !== null && currentStarttime !== recordedStarttime) {
          try {
            unlinkSync(lockPath);
          } catch {
            // race
          }
          return this.acquireEngineLock();
        }
      } else if (Date.now() - statSync(lockPath).mtimeMs > ENGINE_LOCK_STALE_MS) {
        // Non-Linux backstop: no starttime on record (or non-Linux reader) and
        // the lockfile is older than the cap. Treat as stale and reclaim.
        try {
          unlinkSync(lockPath);
        } catch {
          // race
        }
        return this.acquireEngineLock();
      }
      // Holder is alive AND starttimes match (or cannot be checked) AND lock is
      // fresh — a real other desk process owns this engine. Go passive.
      this.passiveOwnerPid = holderPid;
      return false;
    } catch {
      // Unwritable home: act as owner rather than silently going mute.
      return true;
    }
  }

  // Note: the lock is deliberately NOT released on dispose. In-process vite
  // restarts share the pid (the replacement engine re-acquires before the old
  // one disposes), so removal would open a window for a second process to
  // steal ownership. The holder pid dying is the release.

  /**
   * Background pump: turn-release signals are best-effort (tmux latches the
   * bell flag, so an agent that rings twice without a user touch produces no
   * second edge). The pump re-attempts every queued delivery; drain() itself
   * decides readiness from the live pane.
   */
  private startPump(intervalMs: number): void {
    this.pumpTimer = setInterval(() => {
      for (const runtime of this.members.values()) {
        if (runtime.queue.length > 0) {
          void this.drain(runtime, true);
        } else {
          this.resetHold(runtime);
          // No queued work: keep the status flag honest against the live pane so
          // an agent working on its own task shows "working…", and a missed
          // release signal can't strand the flag the other way.
          void this.reconcileBusy(runtime);
        }
      }
    }, intervalMs);
    this.pumpTimer.unref?.();
  }

  /**
   * Refreshes the diagnostic flags (busy + awaitingApproval) against the live
   * pane for an idle session (no queued work to drain) so the status indicator
   * stays honest. PROBE-DERIVED: the flags MIRROR the probe — they never gate
   * (drain gates on its own fresh probe). Uses the cheap cached diagnostic probe
   * (idle accuracy is non-critical). Replaces the old signal-stale busyOverrideMs
   * reconcile: no flag is ever clung to past the live pane.
   */
  private async reconcileBusy(runtime: MemberRuntime): Promise<void> {
    if (this.disposed || runtime.pausedByOperator) {
      return;
    }
    const snap = await this.diagnosticProbe(runtime.tmuxSession);
    if (snap.paneState === 'unobservable') {
      return; // can't observe — leave the last-known flags (fail-safe)
    }
    runtime.busy = snap.working;
    runtime.awaitingApproval =
      snap.paneState === 'blocked' && (snap.blockedReason === 'approval' || snap.blockedReason === 'input-requested');
  }

  /** Map a probe snapshot to the protocol PaneState vocabulary (working->busy, blocked->not-ready). */
  private paneStateFromSnapshot(snap: SessionProbeSnapshot): PaneState {
    switch (snap.paneState) {
      case 'working':
        return 'busy';
      case 'blocked':
        return 'not-ready';
      case 'ready':
        return 'ready';
      case 'booting':
        return 'booting';
      case 'empty-capture':
        return 'empty-capture';
      case 'offline':
        return 'offline';
      case 'unobservable':
        return 'unobservable';
      default:
        return 'not-ready';
    }
  }

  private unobservableProbeSnapshot(tmuxSession: string): SessionProbeSnapshot {
    return {
      tmuxSession,
      source: 'inspect',
      observedAt: new Date().toISOString(),
      paneState: 'unobservable',
      ready: false,
      working: false,
      blockedReason: 'capture-failed',
      footerRegion: '',
      footerHash: footerHash(''),
      tailPreview: ''
    };
  }

  private async diagnosticProbe(tmuxSession: string): Promise<SessionProbeSnapshot> {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const probe = this.probe.probe(tmuxSession, { source: 'inspect' });
    const timeout = new Promise<SessionProbeSnapshot>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.probe.clear(tmuxSession);
        resolve(this.unobservableProbeSnapshot(tmuxSession));
      }, this.probeTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([probe, timeout]);
    } finally {
      if (timedOut) {
        void probe
          .finally(() => {
            this.probe.clear(tmuxSession);
          })
          .catch(() => {});
      }
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Map a non-ready probe snapshot to the held-queue DeliveryBlockReason.
   * Recognized menu families are carried precisely; unrecognized-shape still
   * collapses to not-ready because it is not positive menu evidence.
   */
  private blockReasonFromSnapshot(snap: SessionProbeSnapshot): DeliveryBlockReason {
    switch (snap.paneState) {
      case 'working':
        return 'busy';
      case 'offline':
        return 'offline';
      case 'booting':
        return 'booting';
      case 'empty-capture':
        return 'empty-capture';
      case 'unobservable':
        return 'capture-failed';
      case 'blocked':
        if (snap.blockedReason === 'approval') {
          return 'approval';
        }
        if (snap.blockedReason === 'input-requested') {
          return 'input-requested';
        }
        if (
          snap.blockedReason === 'trust-menu' ||
          snap.blockedReason === 'selection-menu' ||
          snap.blockedReason === 'unknown-menu'
        ) {
          return snap.blockedReason;
        }
        return 'not-ready';
      default:
        return 'not-ready';
    }
  }

  private queueDir(tmuxSession?: string): string {
    const base = join(this.options.home, '_engine', 'queue');
    return tmuxSession ? join(base, tmuxSession) : base;
  }

  private runtime(tmuxSession: string): MemberRuntime {
    let entry = this.members.get(tmuxSession);
    if (!entry) {
      entry = { tmuxSession, busy: false, awaitingApproval: false, queue: [], draining: false, drainGeneration: 0, unobservableRetries: 0 };
      this.members.set(tmuxSession, entry);
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

  private clearPendingAck(runtime: MemberRuntime): void {
    if (runtime.pendingAck?.timer) {
      clearTimeout(runtime.pendingAck.timer);
    }
    runtime.pendingAck = undefined;
  }

  private startPendingAck(
    runtime: MemberRuntime,
    notificationId: string,
    seqs: number[],
    payload: string,
    schedule = true
  ): void {
    this.clearPendingAck(runtime);
    runtime.pendingAck = {
      notificationId,
      seqs: [...seqs],
      payload,
      enterRetries: 0,
      replays: 0
    };
    if (schedule) {
      this.scheduleAckCheck(runtime);
    }
  }

  private scheduleAckCheck(runtime: MemberRuntime): void {
    const pending = runtime.pendingAck;
    if (!pending || this.disposed) {
      return;
    }
    pending.timer = setTimeout(() => {
      void this.handleAckTimeout(runtime, pending.notificationId);
    }, this.enterVerifyDelayMs);
    pending.timer.unref?.();
  }

  private async handleAckTimeout(runtime: MemberRuntime, notificationId: string): Promise<void> {
    const pending = runtime.pendingAck;
    if (!pending || pending.notificationId !== notificationId || this.disposed) {
      return;
    }
    pending.timer = undefined;
    if (pending.enterRetries < this.verifyCycles) {
      pending.enterRetries += 1;
      await this.sendEnter(runtime.tmuxSession);
      if (runtime.pendingAck?.notificationId === notificationId) {
        this.scheduleAckCheck(runtime);
      }
      return;
    }
    if (pending.replays < 1) {
      pending.replays += 1;
      pending.enterRetries = 0;
      const delivered = await this.sendText(runtime.tmuxSession, pending.payload);
      if (!delivered) {
        runtime.busy = false;
        this.clearPendingAck(runtime);
        runtime.submitState = undefined;
        runtime.submitStateSeqs = undefined;
        this.recordHold(runtime, 'send-failed', false);
        return;
      }
      if (runtime.pendingAck?.notificationId === notificationId) {
        this.scheduleAckCheck(runtime);
      }
      return;
    }
    runtime.busy = false;
    this.presence.recordAckFailure(runtime.tmuxSession, notificationId);
    this.setSubmitState(runtime, 'delivery-ack-timeout', pending.seqs);
    this.clearPendingAck(runtime);
    runtime.submitState = undefined;
    runtime.submitStateSeqs = undefined;
  }

  handleDeliveryAck(tmuxSession: string, notificationId: string): boolean {
    const runtime = this.members.get(tmuxSession);
    if (!runtime?.pendingAck || runtime.pendingAck.notificationId !== notificationId) {
      return false;
    }
    const seqs = [...runtime.pendingAck.seqs];
    this.clearPendingAck(runtime);
    runtime.unobservableRetries = 0;
    this.setSubmitState(runtime, 'submitted', seqs);
    return true;
  }

  /**
   * Reload persisted queues after a server restart (agents assumed idle).
   *
   * Per-item lifecycle extensions under _engine/queue/<tmux>/:
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
          // Remove the source file; persistQueue (below) rewrites the queue
          // snapshot as .json with the new seq. The .delivering extension is
          // thus consumed — the next drain fires a fresh 'delivering' callback
          // which re-claims under the new seq.
          try {
            rmSync(consumedPath, { force: true });
          } catch {
            // raced — best-effort
          }
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
      if (runtime.queue.length > 0) {
        void this.drain(runtime, false);
      }
    }
  }

  /** Restore intentional operator holds before any queued prompt can drain. */
  private restorePausedSessions(): void {
    for (const paused of listPausedSessions(this.options.home)) {
      const runtime = this.runtime(paused.tmuxSession);
      runtime.pausedByOperator = { since: paused.pausedAt, reason: paused.reason };
      runtime.busy = false;
      runtime.awaitingApproval = false;
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
    const dir = this.queueDir(runtime.tmuxSession);
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

  private pushDeliveryEvent(event: Omit<DeliveryEvent, 'seq' | 'at'>): void {
    try {
      appendDeliveryEvent(this.options.home, event);
    } catch {
      // Delivery history is diagnostic; a broken event ring must never break delivery.
    }
  }

  private deliveryEventKey(tmuxSession: string, seq: number): string {
    return `${tmuxSession}:${seq}`;
  }

  private queuedEventContext(item: QueuedPrompt, preview?: string): DeliveryEventContext {
    return {
      channel: item.channel,
      messageId: item.messageId,
      author: item.author,
      preview: preview ?? item.prompt.split('\n').find((line) => line.trim() !== '')?.slice(0, 140) ?? ''
    };
  }

  private pushQueuedDeliveryEvent(tmuxSession: string, item: QueuedPrompt, preview?: string): void {
    this.pushDeliveryEvent({
      kind: 'queued',
      tmuxSession,
      ...this.queuedEventContext(item, preview)
    });
  }

  private pushDroppedDeliveryEvent(tmuxSession: string, item: QueuedPrompt): void {
    this.pushDeliveryEvent({
      kind: 'dropped',
      tmuxSession,
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
    for (const runtime of this.members.values()) {
      this.clearPendingAck(runtime);
    }
    this.members.clear();
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = undefined;
    }
  }

  /** Entry point for every finalised message (server appends + watcher finds). */
  handleMessage(incoming: IncomingChannelMessage, membersOverride?: ChannelMember[]): void {
    if (this.disposed || this.passive) {
      return;
    }
    const { channel, file, message } = incoming;
    const preview = message.body.replace(/\s+/g, ' ').slice(0, 140);
    this.pushActivity({ kind: 'message', channel, file, messageId: message.id, author: message.author, preview });

    const members = membersOverride ?? listChannelMembers(this.options.home, channel);
    const pingsHuman = message.author !== 'human' && mentionsHuman(message.body);
    if (pingsHuman) {
      this.pushActivity({ kind: 'human-mention', channel, file, messageId: message.id, author: message.author, preview });
    }
    this.options.onChannelMessage?.(channel, file, message, pingsHuman);

    const threadParentId = threadParentIdFromFile(file);
    const threadAuthor = threadParentId ? this.threadParentAuthor(channel, threadParentId) : undefined;
    const authorSession = members.find((member) => member.name === message.author)?.tmuxSession;
    for (const target of resolveTargets(message.author, message.body, members, { isThread: Boolean(threadParentId), threadAuthor })) {
      if (!target.tmuxSession || target.tmuxSession === authorSession) {
        continue;
      }
      const prompt = buildTurnPrompt({
        channel,
        file,
        member: target.name,
        author: message.author,
        message,
        home: this.options.home
      });
      this.enqueue(target.tmuxSession, {
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

  private threadParentAuthor(channel: string, parentId: string): string | undefined {
    try {
      return readChannelMessage(this.options.home, channel, parentId).author;
    } catch {
      return undefined;
    }
  }

  private enqueue(
    tmuxSession: string,
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
    const dedupeKey = `${tmuxSession}:${item.messageId}`;
    const runtime = this.runtime(tmuxSession);
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
      target: tmuxSession,
      preview: item.preview
    });
    this.pushQueuedDeliveryEvent(tmuxSession, queued, item.preview);
    // Backstop against runaway loops: drop the OLDEST prompts — the newest
    // carry the current conversation state, stale ones only mislead.
    let dropped = 0;
    while (runtime.queue.length > MAX_QUEUE_PER_SESSION) {
      const removed = runtime.queue.shift();
      if (removed) {
        this.pushDroppedDeliveryEvent(tmuxSession, removed);
        dropped += 1;
      }
    }
    if (dropped > 0) {
      runtime.droppedQueueItems = (runtime.droppedQueueItems ?? 0) + dropped;
      this.resetHold(runtime);
    }
    this.persistQueue(runtime);
    void this.drain(runtime, false);
  }

  /**
   * Agent signal hook (wired to desk's attention events). turn-complete and
   * bell mean the agent is back at its input prompt — release and drain.
   */
  handleAgentSignal(tmuxSession: string, kind: AgentSignalKind): void {
    const runtime = this.members.get(tmuxSession);
    if (!runtime) {
      return;
    }
    // Signals are best-effort and can be MISSED, so a signal NEVER directly sets
    // or clears a gate flag (the old signal-authoritative model is what stranded
    // ready queues behind a stale awaitingApproval). Every kind simply TRIGGERS an
    // immediate re-probe; the live snapshot then drives the diagnostic flags and a
    // drain if the pane is ready. (approval/input still logged for the timeline.)
    if (kind === 'approval-requested' || kind === 'input-requested') {
      this.pushDeliveryEvent({ kind, tmuxSession });
    }
    void this.probeAndReconcile(runtime);
  }

  handleAgentEvent(event: AgentEventV2): void {
    const snapshot = this.presence.apply(event);
    const runtime = this.runtime(event.session);
    if ((event.kind === 'prompt-submitted' || event.kind === 'delivery-ack') && event.notificationId) {
      this.handleDeliveryAck(event.session, event.notificationId);
    }
    switch (snapshot.color) {
      case 'green':
        runtime.busy = true;
        runtime.awaitingApproval = snapshot.status === 'blocked';
        if (event.kind === 'approval-requested' || event.kind === 'input-requested') {
          this.pushDeliveryEvent({ kind: event.kind, tmuxSession: event.session });
        }
        return;
      case 'red':
        runtime.busy = false;
        runtime.awaitingApproval = false;
        if (runtime.queue.length > 0) {
          this.recordHold(runtime, 'offline', false);
        }
        return;
      case 'yellow':
        runtime.busy = false;
        runtime.awaitingApproval = false;
        runtime.lastReleaseAt = new Date().toISOString();
        if (runtime.queue.length > 0) {
          void this.drain(runtime, false);
        }
        return;
    }
  }

  /**
   * Probe-and-reconcile: read the live pane, re-derive the diagnostic flags from
   * it, and drain if it is ready. The single path a signal (or the idle pump)
   * uses to keep the flags honest — the probe is the AUTHORITY, the flags only
   * mirror it. Replaces the old signal-gated release: a stray bell can no longer
   * clear a real menu (the probe sees the menu as blocked), and a missed release
   * can no longer strand a ready queue (the probe sees ready and drains).
   */
  private async probeAndReconcile(runtime: MemberRuntime): Promise<void> {
    if (this.disposed || runtime.pausedByOperator) {
      return;
    }
    const snap = await this.probe.probe(runtime.tmuxSession, { source: 'signal', forceFresh: true });
    if (this.disposed || runtime.pausedByOperator) {
      return;
    }
    if (snap.paneState === 'ready') {
      const wasHeld = runtime.busy || runtime.awaitingApproval;
      runtime.busy = false;
      runtime.awaitingApproval = false;
      if (wasHeld) {
        runtime.lastReleaseAt = new Date().toISOString();
        this.pushDeliveryEvent({ kind: 'released', tmuxSession: runtime.tmuxSession });
        this.resetHold(runtime);
      }
      if (runtime.queue.length > 0) {
        setTimeout(() => {
          void this.drain(runtime, false);
        }, this.releaseSettleMs);
      }
      return;
    }
    // Not ready — mirror the live pane into the diagnostic flags (never gates).
    runtime.busy = snap.working;
    runtime.awaitingApproval =
      snap.paneState === 'blocked' && (snap.blockedReason === 'approval' || snap.blockedReason === 'input-requested');
  }

  private async drain(runtime: MemberRuntime, countHoldCycle = false): Promise<void> {
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
      if (Date.now() - (runtime.drainingSince ?? 0) < this.drainWatchdogMs) {
        this.recordHold(runtime, 'busy', countHoldCycle);
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
    runtime.drainingSince = Date.now();
    try {
      // Operator-required behavior: channel notifications are notification-only
      // and idempotent, so regular delivery uses the same path as force delivery
      // and never gates on live pane status, presence color, approval menus, or
      // probe classifier output. If tmux accepts the paste, the notification was
      // injected; ACK hooks are best-effort evidence, not delivery authority.
      if (process.env.DESK_CHANNELS_DEBUG) {
        try {
          appendFileSync(
            '/tmp/chan-engine-debug.log',
            `${new Date().toISOString()} drain ${runtime.tmuxSession} force queued=${runtime.queue.length}\n`
          );
        } catch {
          // tracing must never break delivery
        }
      }
      if (runtime.drainGeneration !== generation) {
        return;
      }
      if (this.disposed || runtime.queue.length === 0) {
        if (runtime.queue.length === 0) {
          this.resetHold(runtime);
        }
        return;
      }
      runtime.busy = false;
      runtime.awaitingApproval = false;
      this.resetHold(runtime);
      await this.deliverNext(runtime, countHoldCycle);
    } finally {
      runtime.draining = false;
    }
  }

  /**
   * Delivers the head item — or a digest of the queued channel messages — to the
   * agent, removes it from the queue, persists, records activity, and kicks off
   * submit verification. The caller MUST hold the draining lock and have already
   * decided the agent is eligible (drain's gates, or a forced operator override
   * from the ops console). Returns whether the push reached tmux.
   */
  private async deliverNext(runtime: MemberRuntime, countHoldCycle = false, forceSeq?: number): Promise<boolean> {
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
    const needsLegacyVerify = next.kind === 'prompt';
    runtime.busy = true; // claim before the async push so signals interleave safely
    // Claim the item(s): the durability slice renames <seq>.json → .delivering on
    // this synchronous transition, before the paste.
    this.setSubmitState(runtime, 'delivering', deliveredSeqs);
    runtime.lastDeliveryMs = Date.now();
    // Prompts held a long time (busy agent, dead session, restarts) carry
    // a staleness note so the agent weighs them against newer context.
    const ageMs = Date.now() - Date.parse(next.queuedAt);
    const payload = digest
      ? buildDigestPrompt(digestItems, this.options.home, notificationId)
      : Number.isFinite(ageMs) && ageMs > this.staleAfterMs
        ? `(delayed delivery — this message was posted ${Math.round(ageMs / 60000)} minutes ago; read the channel for the current state before acting)\n${next.prompt}`
        : next.prompt;
    // Standalone prompts (onboarding/operator nudges) are not idempotent
    // notification items, so keep the legacy pane verifier for them until that
    // path gets its own explicit ACK contract. Channel notifications are force
    // delivered: if tmux accepts the paste, the queue advances immediately.
    const preSnap = needsLegacyVerify ? await this.probe.probe(runtime.tmuxSession, { source: 'verify', forceFresh: true }) : undefined;
    const delivered = await this.sendText(runtime.tmuxSession, payload);
    if (!delivered) {
      runtime.busy = false;
      this.clearPendingAck(runtime);
      // The paste failed, so this delivery never reaches verifySubmitted to
      // resolve the 'delivering' claim made above. Clear it here, or the drain
      // double-feed guard (submitState==='delivering') would hold the queue
      // forever — the very stuck-flag class this refactor removes. The item is
      // still queued (not shifted) and the .delivering ack-file is reclaimed
      // idempotently on the next delivery attempt.
      runtime.submitState = undefined;
      runtime.submitStateSeqs = undefined;
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
      target: runtime.tmuxSession,
      preview: payload.split('\n')[0]?.slice(0, 140) ?? ''
    });
    if (needsLegacyVerify && preSnap) {
      // Fire-and-forget: verification sleeps between checks and must not
      // hold the drain lock (a release signal may arrive meanwhile).
      void this.verifySubmitted(runtime, payload, preSnap.footerHash, deliveredSeqs);
    } else {
      this.setSubmitState(runtime, 'submitted', deliveredSeqs);
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
      const key = this.deliveryEventKey(runtime.tmuxSession, seq);
      if (state === 'delivering') {
        const item = runtime.queue.find((queued) => queued.seq === seq);
        if (item) {
          this.deliveryEventContext.set(key, this.queuedEventContext(item));
        }
      }
      const context = this.deliveryEventContext.get(key);
      this.pushDeliveryEvent({
        kind: state,
        tmuxSession: runtime.tmuxSession,
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
        this.onSubmitStateChange(runtime.tmuxSession, state, { seq });
      }
    }
  }

  /**
   * Revert each given .stuck-* ack-file back to .json (retryStuckItem) and push
   * the item onto the runtime queue so the gated drain re-delivers it. Used by
   * the live unobservable auto-retry (verifySubmitted) and operator force-deliver
   * over a durable stuck item. Safe under the observability-aware drain: a still-unobservable pane
   * holds and never blind-delivers, so the re-enqueue cannot loop into a paste.
   */
  private reenqueueStuck(runtime: MemberRuntime, seqs: number[]): boolean {
    const dir = this.queueDir(runtime.tmuxSession);
    let revived = false;
    for (const seq of seqs) {
      if (!retryStuckItem(this.options.home, runtime.tmuxSession, seq)) {
        continue; // no stuck file (already dropped / never marked) — skip
      }
      const item = readQueueItem(dir, `${String(seq).padStart(10, '0')}.${EXT_QUEUED}`);
      if (item && !runtime.queue.some((queued) => queued.seq === item.seq)) {
        runtime.queue.push(item);
        this.pushQueuedDeliveryEvent(runtime.tmuxSession, item);
        revived = true;
      }
    }
    if (revived) {
      this.persistQueue(runtime);
    }
    return revived;
  }

  /**
   * Confirm a delivery actually ran, and when it does not, classify WHY so the
   * stall is surfaced instead of leaving a prompt silently wedged in the box.
   *
   * The honest success signal is behavioural: a submitted prompt makes the
   * agent busy within seconds (text-matching the box is unreliable — codex
   * overdraws spaces, tall prompts scroll their first line away). So each cycle
   * first checks `isPaneBusy` in the footer region; if the agent is busy,
   * the prompt reached execution and is `submitted`.
   *
   * Recovery is ALWAYS the same safe action: press Enter. A stray Enter on an
   * idle/empty box is a no-op, but it submits a prompt whose Enter was eaten —
   * the dominant failure. We deliberately do NOT auto re-paste: a "pane
   * unchanged" footer is ambiguous (a paste that never landed looks identical
   * to one that landed, submitted, and completed back to an idle box), so a
   * re-paste there would risk a double delivery. Auto-replay of a stuck paste
   * is left to the operator (force-deliver), matching the durability slice's
   * rule that `.stuck-*` files are never auto-replayed.
   *
   * The pre-paste snapshot is used only to CLASSIFY a stall, not to choose the
   * action — compared in the footer region, where all three agent TUIs render
   * their input box. After `verifyCycles` pass without the agent going busy:
   *  - footer never changed → `submit-stuck-paste` (the paste likely never
   *    reached the box).
   *  - footer changed       → `submit-stuck-submit` (the prompt is in the box
   *    but its submit never ran).
   * `submitState` carries the result to the ops console and to the durability
   * slice's `.delivering/.delivered/.stuck-*` ack-file renames.
   */
  private async verifySubmitted(
    runtime: MemberRuntime,
    _prompt: string,
    preFooterHash: string,
    seqs: number[]
  ): Promise<void> {
    const recognizedMenu = (reason: SessionProbeSnapshot['blockedReason']): boolean =>
      reason === 'approval' ||
      reason === 'input-requested' ||
      reason === 'trust-menu' ||
      reason === 'selection-menu' ||
      reason === 'unknown-menu';
    let everReady = false;
    let footerChanged = false;
    for (let attempt = 0; attempt < this.verifyCycles; attempt += 1) {
      await delay(this.enterVerifyDelayMs);
      if (this.disposed) {
        return;
      }
      const snap = await this.probe.probe(runtime.tmuxSession, { source: 'verify', forceFresh: true });
      if (snap.working) {
        runtime.unobservableRetries = 0; // a confirmed delivery resets the auto-retry budget
        this.setSubmitState(runtime, 'submitted', seqs); // behavioural proof the prompt ran
        return;
      }
      if (snap.paneState === 'blocked' && recognizedMenu(snap.blockedReason)) {
        // A recognized approval/input/menu after a ready-gated delivery is
        // positive evidence the paste was accepted and the agent advanced into
        // an interactive blocker: it submitted. Mark submitted (no replay) and
        // hard-hold so the next item is not fed into the open menu. NO Enter.
        runtime.awaitingApproval = true;
        runtime.unobservableRetries = 0; // a confirmed (menu-advanced) delivery resets the budget
        this.setSubmitState(runtime, 'submitted', seqs);
        return;
      }
      if (snap.paneState === 'ready') {
        everReady = true;
        if (snap.footerHash !== preFooterHash) {
          footerChanged = true; // the box reflected the paste at some point
        }
        await this.sendEnter(runtime.tmuxSession); // safe no-op; submits an eaten Enter
        continue;
      }
      // unrecognized-shape / unobservable / empty-capture / booting / offline:
      // no positive evidence, and an Enter would be unsafe — inconclusive cycle.
    }
    if (this.disposed) {
      return;
    }
    if (everReady) {
      // Saw an idle ready composer but never working/menu: footer changed means
      // the text sits in the box, Enter eaten (stuck-submit); never changed means
      // the paste never landed (stuck-paste).
      this.setSubmitState(runtime, footerChanged ? 'submit-stuck-submit' : 'submit-stuck-paste', seqs);
    } else {
      // Never observed a usable pane (only unobservable/unrecognized/boot/offline):
      // submission unconfirmed. Mark stuck-unobservable, then LIVE-retry: the
      // 'submit-stuck-unobservable' callback renames the ack-file(s) to
      // .stuck-unobservable, and reenqueueStuck reverts them to .json and
      // re-enqueues so the pump re-delivers once the pane is observable again.
      // Safe under the observability-aware drain (a still-unobservable pane holds, never
      // blind-delivers); message-id dedupe covers a prompt that had actually
      // submitted. Restart-time restore is the at-least-once backstop.
      this.setSubmitState(runtime, 'submit-stuck-unobservable', seqs);
      runtime.busy = false;
      if (runtime.unobservableRetries >= MAX_UNOBSERVABLE_RETRIES) {
        // Bounded escalation: stop the auto-retry loop on a persistently-
        // unobservable pane. Leave the item DURABLE as .stuck-unobservable —
        // surfaced in the ops console blockedItems for operator force-deliver /
        // drop — instead of an invisible infinite re-deliver.
        return;
      }
      runtime.unobservableRetries += 1;
      this.reenqueueStuck(runtime, seqs);
    }
  }

  /**
   * Queues a non-message prompt (onboarding briefing, operator nudge) for a
   * session through the same gated delivery path as channel dispatches.
   */
  enqueuePrompt(tmuxSession: string, channel: string, prompt: string, idHint: string): void {
    if (this.disposed || this.passive) {
      return;
    }
    this.enqueue(tmuxSession, {
      channel,
      messageId: `${idHint}-${Date.now().toString(36)}`,
      author: 'desk',
      prompt,
      target: tmuxSession,
      preview: prompt.split('\n')[0]?.slice(0, 140) ?? '',
      kind: 'prompt'
    });
  }

  /** A member whose session was just (re)started is at a fresh prompt. */
  markIdle(tmuxSession: string): void {
    const runtime = this.members.get(tmuxSession);
    if (runtime) {
      runtime.busy = false;
      runtime.awaitingApproval = false;
      this.resetHold(runtime);
      void this.drain(runtime, false);
    }
  }

  /** Operator pause: intentional hold, never counted as blocked/stuck. */
  pauseSession(tmuxSession: string, reason?: string, pausedAt = new Date().toISOString()): void {
    const runtime = this.runtime(tmuxSession);
    const cleanReason = reason?.replace(/\s+/g, ' ').trim();
    runtime.pausedByOperator = { since: pausedAt, reason: cleanReason || undefined };
    runtime.busy = false;
    runtime.awaitingApproval = false;
    this.resetHold(runtime);
    this.pushDeliveryEvent({ kind: 'paused', tmuxSession, reason: cleanReason || undefined });
  }

  /** Clears an operator pause and resumes normal gated draining. */
  resumeSession(tmuxSession: string): void {
    const runtime = this.members.get(tmuxSession);
    if (!runtime) {
      return;
    }
    runtime.pausedByOperator = undefined;
    runtime.busy = false;
    runtime.awaitingApproval = false;
    this.resetHold(runtime);
    this.pushDeliveryEvent({ kind: 'resumed', tmuxSession });
    void this.drain(runtime, false);
  }

  dropQueue(tmuxSession: string): void {
    // Drop durable stuck items too — dropQueue clears the whole backlog,
    // including .stuck-* surfaced for the operator (works even with no runtime).
    for (const stuck of listStuckItems(this.options.home, tmuxSession)) {
      if (dropStuckItem(this.options.home, tmuxSession, stuck.seq)) {
        this.pushDroppedDeliveryEvent(tmuxSession, stuck.item);
      }
    }
    const runtime = this.members.get(tmuxSession);
    if (runtime) {
      for (const item of runtime.queue) {
        this.pushDroppedDeliveryEvent(tmuxSession, item);
      }
      runtime.queue = [];
      this.resetHold(runtime);
      this.persistQueue(runtime);
    }
  }

  /** Ops console: remove a single queued item by seq. Returns whether it existed. */
  dropMessage(tmuxSession: string, seq: number): boolean {
    const runtime = this.members.get(tmuxSession);
    if (runtime) {
      const before = runtime.queue.length;
      const headSeq = runtime.queue[0]?.seq;
      const dropped = runtime.queue.find((item) => item.seq === seq);
      runtime.queue = runtime.queue.filter((item) => item.seq !== seq);
      if (runtime.queue.length !== before) {
        if (dropped) {
          this.pushDroppedDeliveryEvent(tmuxSession, dropped);
        }
        if (seq === headSeq) {
          this.resetHold(runtime);
        }
        this.persistQueue(runtime);
        return true;
      }
    }
    // Not in the runtime queue — maybe a durable stuck item on disk.
    const stuck = listStuckItems(this.options.home, tmuxSession).find((item) => item.seq === seq);
    const dropped = dropStuckItem(this.options.home, tmuxSession, seq);
    if (dropped && stuck) {
      this.pushDroppedDeliveryEvent(tmuxSession, stuck.item);
    }
    return dropped;
  }

  /**
   * Ops console: deliver the head item NOW, bypassing the busy/ready/boot gates.
   * Operator override — can land inside a working agent's turn — so it is only
   * reachable from the console behind a confirm. Returns whether the push landed.
   */
  async forceDeliver(tmuxSession: string, seq?: number): Promise<boolean> {
    if (this.disposed || this.passive) {
      return false;
    }
    const runtime = this.members.get(tmuxSession);
    if (!runtime || !this.sessionRunning(tmuxSession)) {
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
      const stuck = listStuckItems(this.options.home, tmuxSession)[0];
      if (!stuck || !this.reenqueueStuck(runtime, [stuck.seq])) {
        return false;
      }
    }
    // Respect a genuinely in-flight drain (within the watchdog window) so a
    // forced push can't race the gated one into a double delivery.
    if (runtime.draining && Date.now() - (runtime.drainingSince ?? 0) < this.drainWatchdogMs) {
      return false;
    }
    runtime.draining = true;
    runtime.drainingSince = Date.now();
    try {
      this.resetHold(runtime);
      return await this.deliverNext(runtime, false, seq);
    } finally {
      runtime.draining = false;
    }
  }

  /** Ops console: queued prompts for a session, body-trimmed to a preview. */
  queuedItems(tmuxSession: string): QueuedItemMeta[] {
    const runtime = this.members.get(tmuxSession);
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

  /** Ops console: legacy .stuck-* files are historical only and never block notification delivery. */
  private blockedItems(tmuxSession: string): BlockedItemMeta[] {
    void tmuxSession;
    return [];
  }

  /** Live deliverability of a session's pane (drives the ops-console badge). */
  private async classifyPane(tmuxSession: string, options: { forceFresh?: boolean } = {}): Promise<PaneState> {
    const snap = options.forceFresh
      ? await this.probe.probe(tmuxSession, { source: 'inspect', forceFresh: true })
      : await this.diagnosticProbe(tmuxSession);
    return this.paneStateFromSnapshot(snap);
  }

  /** Ops console: full per-session diagnostic, including a live pane probe. */
  async inspectSession(tmuxSession: string): Promise<SessionDiagnostic> {
    const runtime = this.members.get(tmuxSession);
    const paneState = await this.classifyPane(tmuxSession);
    if (runtime && runtime.queue.length > 0 && paneState === 'ready') {
      this.resetHold(runtime);
    }
    const block = this.runtimeBlock(runtime);
    const stuckItems = this.blockedItems(tmuxSession);
    const status = runtime ? this.deriveStatus(runtime, block) : 'idle';
    const pause = runtime?.pausedByOperator;
    return {
      tmuxSession,
      paneState,
      status,
      busy: runtime?.busy ?? false,
      awaitingApproval: runtime?.awaitingApproval ?? false,
      pausedByOperator: Boolean(pause),
      pauseReason: pause?.reason,
      pausedAt: pause?.since,
      draining: runtime?.draining ?? false,
      queued: runtime?.queue.length ?? 0,
      lastDeliveryAt: runtime?.lastDeliveryAt,
      lastReleaseAt: runtime?.lastReleaseAt,
      submitState: runtime?.submitState,
      ...block,
      droppedQueueItems: runtime?.droppedQueueItems ?? 0,
      blockedItems: stuckItems,
      items: this.queuedItems(tmuxSession),
      ...this.resumeInfo(tmuxSession)
    };
  }

  /** Ops console: diagnostics for every tracked session (probes run concurrently). */
  async inspectAll(): Promise<SessionDiagnostic[]> {
    return Promise.all([...this.members.keys()].map((tmuxSession) => this.inspectSession(tmuxSession)));
  }

  /**
   * Ops console: nudge every session whose live pane is `ready` through the
   * NORMAL gated drain (not a force) — a safe one-click for a backlog that the
   * release signals missed. Returns the sessions nudged.
   */
  async drainReady(): Promise<string[]> {
    const nudged: string[] = [];
    for (const runtime of this.members.values()) {
      if (runtime.queue.length === 0) {
        continue;
      }
      if ((await this.classifyPane(runtime.tmuxSession, { forceFresh: true })) === 'ready') {
        runtime.busy = false;
        runtime.awaitingApproval = false;
        this.resetHold(runtime);
        void this.drain(runtime, false);
        nudged.push(runtime.tmuxSession);
      }
    }
    return nudged;
  }

  /** True while the background delivery pump is scheduled (false once disposed). */
  pumpAlive(): boolean {
    return !this.disposed && this.pumpTimer !== undefined;
  }

  /**
   * Effective delivery block for a session — the SAME composition inspectSession
   * uses (the threshold-gated runtime tripwire), MINUS the live pane probe. One
   * source of effective-block truth shared by the cached /state read-model and
   * the live-probe /engine diagnostic. Legacy durable .stuck-* files are not a
   * delivery authority.
   */
  private effectiveBlock(
    tmuxSession: string,
    runtime: MemberRuntime | undefined
  ): Pick<SessionDiagnostic, 'deliveryBlocked' | 'blockedReason' | 'blockedSince' | 'blockedCycles' | 'blockedHeadSeq'> {
    void tmuxSession;
    return this.runtimeBlock(runtime);
  }

  /**
   * Derive the single main-UI status from CACHED state only (no probe). Per the
   * Lifecycle guard: 'blocked' comes from the EFFECTIVE (threshold/durable-gated)
   * block, never raw runtime.deliveryBlock, so intentional short holds are not
   * surfaced and the tripwire threshold is preserved; submit-stuck stays distinct
   * from generic blocked.
   */
  private deriveStatus(
    runtime: MemberRuntime,
    block: Pick<SessionDiagnostic, 'deliveryBlocked' | 'blockedReason'>
  ): LifecycleStatus {
    if (runtime.pausedByOperator) {
      return 'paused';
    }
    const reason = block.deliveryBlocked ? block.blockedReason : undefined;
    if (reason === 'submit-stuck-paste' || reason === 'submit-stuck-submit') {
      return 'submit-stuck';
    }
    if (runtime.awaitingApproval || reason === 'approval' || reason === 'input-requested') {
      return 'awaiting-approval';
    }
    if (block.deliveryBlocked) {
      return 'blocked';
    }
    if (runtime.busy) {
      return 'working';
    }
    return 'idle';
  }

  /**
   * Cached per-session delivery lifecycle for the hot /state poll — supersedes
   * deliveryStates(). Reads only MemberRuntime + the effective block + a cheap
   * stuck-file count; NO live pane probe (that stays on /engine inspectAll).
   */
  lifecycleStates(): LifecycleState[] {
    return [...this.members.values()].map((runtime) => {
      const block = this.effectiveBlock(runtime.tmuxSession, runtime);
      const stuckItems = this.blockedItems(runtime.tmuxSession);
      return {
        tmuxSession: runtime.tmuxSession,
        busy: runtime.busy,
        awaitingApproval: runtime.awaitingApproval,
        queued: runtime.queue.length,
        lastDeliveryAt: runtime.lastDeliveryAt,
        lastReleaseAt: runtime.lastReleaseAt,
        status: this.deriveStatus(runtime, block),
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

  private resumeInfo(tmuxSession: string): Partial<SessionResumeInfo> {
    const info = this.sessionInfo(tmuxSession);
    if (!info) {
      return {};
    }
    return { ...info, hasResume: info.hasResume ?? Boolean(info.resume) };
  }
}
