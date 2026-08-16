// The routing decision has no filesystem in it.
//
// Every fixture here is a literal: a message and a roster. Before the router
// was extracted these same cases needed a temp channels home, a real engine and
// a fake delivery transport to observe "who got queued"; the answer is now a
// return value.

import { describe, expect, it } from 'vitest';
import { MentionRouter, threadParentIdFromFile } from '../src/server/channels/routing/router.js';
import type { ChannelMember, ChannelMessage } from '../src/server/channels/protocol/format.js';

const router = new MentionRouter();

function member(name: string, sessionId?: string, type = 'claude-code'): ChannelMember {
  return { name, type, status: 'active', joined: '', sessionId };
}

function message(author: string, body: string): ChannelMessage {
  return { id: 'msg-20260816-120000-abcd', author, timestamp: '2026-08-16 12:00:00', body, hasEndTurn: true };
}

const roster: ChannelMember[] = [
  member('alpha', 'alpha-1'),
  member('beta', 'beta-1'),
  member('human', undefined, 'human')
];

function route(author: string, body: string, file = 'root.md', threadAuthor?: string) {
  return router.route({
    channel: 'ops',
    file,
    message: message(author, body),
    members: roster,
    threadAuthor: () => threadAuthor
  });
}

describe('MentionRouter', () => {
  it('names the mentioned agent and nobody else', () => {
    expect(route('human', 'go @alpha').recipients.map((r) => r.name)).toEqual(['alpha']);
  });

  it('excludes the author from a broadcast, by session', () => {
    expect(route('alpha', 'status update, no mentions').recipients.map((r) => r.name)).toEqual(['beta']);
  });

  it('excludes members with no session — the engine cannot reach them', () => {
    expect(route('alpha', '@human take a look').recipients).toEqual([]);
  });

  it('reports an operator ping without routing it to an agent', () => {
    const decision = route('alpha', '@human take a look');
    expect(decision.pingsOperator).toBe(true);
    expect(decision.recipients).toEqual([]);
  });

  it('does not report an operator ping for the operator’s own message', () => {
    expect(route('human', '@human note to self').pingsOperator).toBe(false);
  });

  it('routes an unmentioned thread reply to the thread author only', () => {
    const decision = route('beta', 'done', 'thread-msg-20260816-110000-0001.md', 'alpha');
    expect(decision.recipients.map((r) => r.name)).toEqual(['alpha']);
    expect(decision.threadParentId).toBe('msg-20260816-110000-0001');
  });

  it('marks a supervisor author so supervision can skip its own nudges', () => {
    const supervised = [...roster, { ...member('watch', 'watch-1'), supervisor: true }];
    const decision = router.route({
      channel: 'ops',
      file: 'root.md',
      message: message('watch', '@alpha what is blocking you?'),
      members: supervised
    });
    expect(decision.authorIsSupervisor).toBe(true);
  });

  it('reads a thread parent id out of the conversation file name', () => {
    expect(threadParentIdFromFile('thread-msg-20260816-110000-0001.md')).toBe('msg-20260816-110000-0001');
    expect(threadParentIdFromFile('root.md')).toBeUndefined();
  });
});
