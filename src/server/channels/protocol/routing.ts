// Channels routing vocabulary.
//
// Who a message is for. Pure functions over a message body and the channel
// roster: no filesystem, no queue, no session. The delivery engine calls
// resolveTargets and then decides what to do with the answer; this module
// never learns what that was.

import type { ChannelMember } from './format.js';

/** Extracts unique @mention handles from a message body (lowercased as-is). */
export function extractMentions(body: string): string[] {
  // Strip fenced/inline code; mentions inside code samples are not mentions.
  const withoutCode = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const found = new Set<string>();
  const pattern = /(^|[^A-Za-z0-9_`])@([A-Za-z][A-Za-z0-9_-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutCode)) !== null) {
    found.add(match[2]);
  }
  return [...found];
}

export interface ResolveTargetOptions {
  /** Thread replies notify the parent-message author plus explicit agent mentions only. */
  isThread?: boolean;
  /** Author of the root message that owns the thread. */
  threadAuthor?: string;
}

/**
 * Resolves which members must be notified for a message, per protocol.
 *
 * Root messages:
 *  - no mentions -> every agent except the author
 *  - @channel broadcasts to every agent except the author
 *  - named agent mentions restrict delivery to those agents
 *  - mentions that name only humans of this channel deliver to no agents
 *  - mentions that name NOBODY in this channel are prose about outsiders, not
 *    an addressing decision: the message broadcasts as if unmentioned (desk#44)
 *
 * Thread replies:
 *  - no mentions -> the parent-message author only
 *  - named agent mentions -> parent-message author plus mentioned agents
 *  - @channel is ignored; it never broadcasts in threads
 *  - human/unknown-only mentions still notify the parent-message author
 *
 * Humans are excluded — UI notification handles @human separately.
 */
export function resolveTargets(author: string, body: string, members: ChannelMember[], options: ResolveTargetOptions = {}): ChannelMember[] {
  const agents = members.filter((member) => member.type !== 'human' && member.name !== author);
  const supervisors = agents.filter((member) => member.supervisor === true);
  const mentions = new Set(extractMentions(body).map((mention) => mention.toLowerCase()));
  const agentNames = new Set(members.filter((member) => member.type !== 'human').map((member) => member.name.toLowerCase()));
  const memberNames = new Set(members.map((member) => member.name.toLowerCase()));

  const mergeSupervisors = (result: ChannelMember[]): ChannelMember[] => {
    if (supervisors.length === 0) {
      return result;
    }
    const seen = new Set(result.map((member) => member.name.toLowerCase()));
    const merged = [...result];
    for (const supervisor of supervisors) {
      if (!seen.has(supervisor.name.toLowerCase())) {
        merged.push(supervisor);
      }
    }
    return merged;
  };

  if (options.isThread) {
    const targetNames = new Set<string>();
    if (options.threadAuthor) {
      targetNames.add(options.threadAuthor.toLowerCase());
    }
    for (const mention of mentions) {
      if (mention !== 'channel' && agentNames.has(mention)) {
        targetNames.add(mention);
      }
    }
    return mergeSupervisors(agents.filter((member) => targetNames.has(member.name.toLowerCase())));
  }
  if (mentions.has('channel')) {
    return agents;
  }
  const mentionsKnownAgent = [...mentions].some((mention) => agentNames.has(mention));
  if (mentionsKnownAgent) {
    return mergeSupervisors(agents.filter((member) => mentions.has(member.name.toLowerCase())));
  }
  if (mentions.size > 0 && [...mentions].some((mention) => memberNames.has(mention))) {
    // At least one mention names somebody who is in this channel (a human, or
    // the author themselves). That IS an addressing decision, so honour it even
    // when it leaves no agent to notify.
    return mergeSupervisors([]);
  }
  // Either there are no mentions at all, or every mention is a stranger to this
  // channel. A stranger handle is a reference to someone outside — it must not
  // silently cancel delivery, so the message broadcasts like an unmentioned one.
  return agents;
}

/** True when the body addresses the human operator. */
export function mentionsHuman(body: string): boolean {
  return extractMentions(body).includes('human');
}
