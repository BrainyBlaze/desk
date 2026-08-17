// What an agent sees.
//
// Every prompt Desk types into an agent is rendered here: the per-message turn
// prompt, the digest that stands in for a backlog, the onboarding briefing, and
// the supervisor check-in. Pure functions of their arguments — no queue, no
// session, no filesystem.
//
// This is also the one place that knows a channel is a FILE: the turn prompt
// carries an absolute path to the conversation so the operator can click it,
// and both prompts name the `desk channels` commands an agent runs to read the
// room. A different store would need a different renderer, and that seam is
// exactly why this module exists apart from the engine that calls it.

import { join } from 'node:path';
import type { ChannelMember, ChannelMessage } from '../protocol/format.js';
import type { QueuedPrompt } from '../protocol/delivery.js';

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

/**
 * The renderer as a port. The four builders are free functions because they are
 * pure and nothing stops a caller from using one directly; this object is what
 * the engine depends on, so the whole agent-facing surface can be replaced at
 * once rather than function by function.
 */
export interface PromptRenderer {
  turn(options: Parameters<typeof buildTurnPrompt>[0]): string;
  digest(items: QueuedPrompt[], home: string, notificationId?: string): string;
  onboarding(options: Parameters<typeof buildOnboardingPrompt>[0]): string;
  supervisorCheckIn(options: Parameters<typeof buildSupervisorCheckInPrompt>[0]): string;
}

export const defaultPromptRenderer: PromptRenderer = {
  turn: buildTurnPrompt,
  digest: buildDigestPrompt,
  onboarding: buildOnboardingPrompt,
  supervisorCheckIn: buildSupervisorCheckInPrompt
};
