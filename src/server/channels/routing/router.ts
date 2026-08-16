// Who a message is for.
//
// The routing decision is a pure function of one message and the channel
// roster: which members must be notified, whether the operator was addressed,
// and the thread context that shaped the answer. It performs no I/O — a thread
// reply needs its parent's author, so the caller supplies a lookup rather than
// the router reaching for a store.
//
// What it deliberately does NOT decide: how a recipient is reached, whether a
// queue exists for them, or what text they will see. `handleMessage` maps the
// decision onto delivery; this module never learns that delivery happened.

import type { ChannelMember, ChannelMessage } from '../protocol/format.js';
import { mentionsHuman, resolveTargets } from '../protocol/routing.js';

/** A recipient the engine can actually deliver to: session-bound, not the author. */
export type Recipient = ChannelMember & { sessionId: string };

export interface RouteInput {
  channel: string;
  /** conversation file the message landed in — `root.md` or `thread-<id>.md` */
  file: string;
  message: ChannelMessage;
  members: ChannelMember[];
  /**
   * Author of the thread's root message. Called only when `file` names a
   * thread, so a caller that never threads never pays for the lookup.
   */
  threadAuthor?: (parentId: string) => string | undefined;
}

export interface RoutingDecision {
  /**
   * Members to notify. Already filtered to those this engine can reach: a
   * member with no session, and the author's own session, are excluded here so
   * no caller has to remember to.
   */
  recipients: Recipient[];
  /** The body addresses the human operator (and the operator did not write it). */
  pingsOperator: boolean;
  /**
   * The author posts as a supervisor of this channel. Not a routing fact in
   * itself — supervision uses it to decide whether this message opens a work
   * window — but the roster scan that answers it happens here anyway.
   */
  authorIsSupervisor: boolean;
  /** Parent message id when the message is a thread reply. */
  threadParentId?: string;
}

export interface MessageRouter {
  route(input: RouteInput): RoutingDecision;
}

export function threadParentIdFromFile(file: string): string | undefined {
  return /^thread-(msg-[A-Za-z0-9-]+)\.md$/.exec(file)?.[1];
}

/**
 * The stock router: @mention resolution as documented in `protocol/routing.ts`,
 * plus the two exclusions every delivery path needs.
 */
export class MentionRouter implements MessageRouter {
  route(input: RouteInput): RoutingDecision {
    const { channel: _channel, file, message, members } = input;
    const authorMember = members.find((member) => member.name === message.author);
    const authorIsSupervisor = authorMember?.supervisor === true;
    const authorSession = authorMember?.sessionId;

    const threadParentId = threadParentIdFromFile(file);
    const threadAuthor = threadParentId ? input.threadAuthor?.(threadParentId) : undefined;

    const targets = resolveTargets(message.author, message.body, members, {
      isThread: Boolean(threadParentId),
      threadAuthor
    });

    const recipients = targets.filter(
      (target): target is Recipient => Boolean(target.sessionId) && target.sessionId !== authorSession
    );

    return {
      recipients,
      pingsOperator: message.author !== 'human' && mentionsHuman(message.body),
      authorIsSupervisor,
      threadParentId
    };
  }
}
