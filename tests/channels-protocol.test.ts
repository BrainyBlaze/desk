import { describe, expect, it } from 'vitest';
import {
  END_TURN,
  extractMentions,
  formatMemberManifest,
  formatMessageBlock,
  formatSharedMessage,
  generateMessageId,
  isValidChannelName,
  memberHandleFromSession,
  mentionsHuman,
  parseConversation,
  parseMemberManifest,
  qualifiedMemberHandle,
  resolveTargets,
  type ChannelMember
} from '../src/server/channelsProtocol.js';

const member = (name: string, type = 'claude-code', tmuxSession?: string): ChannelMember => ({
  name,
  type,
  status: 'active',
  joined: '2026-06-11 12:00:00',
  tmuxSession
});

describe('message format round-trip', () => {
  it('formats a protocol block and parses it back', () => {
    const block = formatMessageBlock({
      id: 'msg-20260611-120000-abcd',
      author: 'claude',
      timestamp: '2026-06-11 12:00:00',
      body: 'Hello @agent-b, check `code` here.\n\nSecond paragraph.'
    });
    expect(block).toContain(END_TURN);
    const { messages } = parseConversation(`# chan\n\n> goal\n\n## Messages\n\n${block}`);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'msg-20260611-120000-abcd',
      author: 'claude',
      timestamp: '2026-06-11 12:00:00',
      hasEndTurn: true
    });
    expect(messages[0].body).toBe('Hello @agent-b, check `code` here.\n\nSecond paragraph.');
  });

  it('parses multiple blocks and keeps the preamble', () => {
    const blocks = [
      formatMessageBlock({ id: 'msg-1-aaaa', author: 'human', timestamp: '2026-06-11 12:00:00', body: 'one' }),
      formatMessageBlock({ id: 'msg-2-bbbb', author: 'agent-b', timestamp: '2026-06-11 12:01:00', body: 'two' })
    ].join('\n');
    const parsed = parseConversation(`# chan\n\n> the goal\n\n${blocks}`);
    expect(parsed.preamble).toContain('> the goal');
    expect(parsed.messages.map((message) => message.id)).toEqual(['msg-1-aaaa', 'msg-2-bbbb']);
  });

  it('flags streaming blocks without END_TURN', () => {
    const text = '### msg-3-cccc\n**@agent-a** · 2026-06-11 12:02:00\n\nstill typing';
    const { messages } = parseConversation(text);
    expect(messages[0].hasEndTurn).toBe(false);
    expect(messages[0].body).toBe('still typing');
  });

  it('parses the thread link line', () => {
    const text = [
      '### msg-4-dddd',
      '**@agent-a** · 2026-06-11 12:03:00',
      '**thread**: [thread-msg-4-dddd](thread-msg-4-dddd.md) (3 replies)',
      '',
      'parent body',
      '',
      END_TURN
    ].join('\n');
    const { messages } = parseConversation(text);
    expect(messages[0].threadFile).toBe('thread-msg-4-dddd.md');
    expect(messages[0].threadReplies).toBe(3);
    expect(messages[0].body).toBe('parent body');
  });
});

describe('mentions', () => {
  it('extracts unique handles, ignoring code spans and mid-word @', () => {
    expect(extractMentions('hey @agent-b and @agent-a-2, also @agent-b')).toEqual(['agent-b', 'agent-a-2']);
    expect(extractMentions('see `@notme` and ```\n@also-not\n```')).toEqual([]);
    expect(extractMentions('email me@example.com')).toEqual([]);
  });

  it('resolveTargets: no mentions or @channel → all agents except author', () => {
    const members = [member('agent-a'), member('agent-b', 'agent-cli'), member('human', 'human')];
    expect(resolveTargets('agent-a', 'hello there', members).map((m) => m.name)).toEqual(['agent-b']);
    expect(resolveTargets('human', 'hello @channel', members).map((m) => m.name)).toEqual(['agent-a', 'agent-b']);
  });

  it('resolveTargets: named agent mentions restrict delivery to those agents', () => {
    const members = [member('agent-a'), member('agent-b', 'agent-cli'), member('human', 'human')];
    expect(resolveTargets('human', 'ping @agent-b', members).map((m) => m.name)).toEqual(['agent-b']);
    expect(resolveTargets('human', 'ping @agent-a and @agent-b', members).map((m) => m.name)).toEqual(['agent-a', 'agent-b']);
    expect(resolveTargets('agent-b', '@agent-b self-ping @human', members).map((m) => m.name)).toEqual([]);
    expect(resolveTargets('human', 'ping @human only', members).map((m) => m.name)).toEqual([]);
    expect(resolveTargets('human', 'ping @not-a-member only', members).map((m) => m.name)).toEqual([]);
    expect(mentionsHuman('@human look at this')).toBe(true);
    expect(mentionsHuman('plain message')).toBe(false);
  });
});

describe('member manifests', () => {
  it('round-trips manifests with the desk tmux extension', () => {
    const manifest = formatMemberManifest({
      name: 'forge',
      type: 'codex-cli',
      joined: '2026-06-11 12:00:00',
      tmuxSession: 'agentdesk-x-main-forge-1234',
      agentLabel: 'x / main / forge'
    });
    const parsed = parseMemberManifest(manifest);
    expect(parsed).toMatchObject({
      name: 'forge',
      type: 'codex-cli',
      status: 'active',
      tmuxSession: 'agentdesk-x-main-forge-1234'
    });
  });

  it('rejects manifests without frontmatter', () => {
    expect(parseMemberManifest('# nope')).toBeUndefined();
  });
});

describe('sharing and naming', () => {
  it('formats a shared message as an attributed quote', () => {
    const shared = formatSharedMessage(
      {
        id: 'msg-5-eeee',
        author: 'agent-a',
        timestamp: '2026-06-11 12:04:00',
        body: 'line one\nline two',
        hasEndTurn: true
      },
      'alpha',
      'worth seeing'
    );
    expect(shared).toContain('worth seeing');
    expect(shared).toContain('**Shared from #alpha** (msg-5-eeee, @agent-a · 2026-06-11 12:04:00):');
    expect(shared).toContain('> line one\n> line two');
  });

  it('validates channel names and derives mention-safe member handles', () => {
    expect(isValidChannelName('mission-control')).toBe(true);
    expect(isValidChannelName('Bad_Name')).toBe(false);
    expect(isValidChannelName('_engine')).toBe(false);
    expect(memberHandleFromSession('Forge Agent #2')).toBe('forge-agent-2');
    expect(memberHandleFromSession('123')).toBe('agent');
  });

  it('qualifies member handles by project when session names collide', () => {
    const roster = [
      { name: 'claude', projectLabel: 'archpowers', groupLabel: 'main' },
      { name: 'claude', projectLabel: 'workspace', groupLabel: 'main' },
      { name: 'forge', projectLabel: 'archpowers', groupLabel: 'main' }
    ];
    expect(qualifiedMemberHandle({ sessionName: 'claude', projectLabel: 'archpowers', groupLabel: 'main', roster })).toBe(
      'archpowers-claude'
    );
    // Unique base name → no qualification.
    expect(qualifiedMemberHandle({ sessionName: 'forge', projectLabel: 'archpowers', groupLabel: 'main', roster })).toBe('forge');
  });

  it('escalates to the group when the name AND project both collide', () => {
    // Two "codex" agents in different groups of the same project: project alone
    // can't disambiguate, so the group enters the handle.
    const roster = [
      { name: 'codex', projectLabel: 'sample', groupLabel: 'main' },
      { name: 'codex', projectLabel: 'sample', groupLabel: 'feature' }
    ];
    expect(qualifiedMemberHandle({ sessionName: 'codex', projectLabel: 'sample', groupLabel: 'feature', roster })).toBe(
      'sample-feature-codex'
    );
    expect(qualifiedMemberHandle({ sessionName: 'codex', projectLabel: 'sample', groupLabel: 'main', roster })).toBe(
      'sample-main-codex'
    );
  });

  it('falls back to group when there is no project to qualify with', () => {
    const roster = [
      { name: 'bot', groupLabel: 'alpha' },
      { name: 'bot', groupLabel: 'beta' }
    ];
    expect(qualifiedMemberHandle({ sessionName: 'bot', groupLabel: 'alpha', roster })).toBe('alpha-bot');
    // No project, no group, still colliding → bare handle (per-channel -2 dedupe catches the rest).
    expect(qualifiedMemberHandle({ sessionName: 'bot', roster })).toBe('bot');
  });

  it('generates protocol-shaped message ids', () => {
    expect(generateMessageId(new Date(2026, 5, 11, 15, 30, 12))).toMatch(/^msg-20260611-153012-[0-9a-f]{4}$/);
  });
});
