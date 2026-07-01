import { describe, expect, it } from 'vitest';
import {
  AttentionTracker,
  containsTerminalNotification,
  detectBellEdges,
  extractTerminalNotifications,
  isLikelyUserInput,
  parseBellFlagsOutput
} from '../src/server/attention.js';

describe('parseBellFlagsOutput', () => {
  it('parses session/flag/activity rows, ignoring blanks', () => {
    const out = 'sess-a\t1\t1700000000\nsess-b\t0\t1700000050\n\n';
    const flags = parseBellFlagsOutput(out);
    expect(flags.get('sess-a')).toEqual({ bellFlag: 1, activity: 1700000000 });
    expect(flags.get('sess-b')).toEqual({ bellFlag: 0, activity: 1700000050 });
    expect(flags.size).toBe(2);
  });

  it('treats any non-1 flag as 0 and missing activity as 0', () => {
    const flags = parseBellFlagsOutput('sess-c\t\t');
    expect(flags.get('sess-c')).toEqual({ bellFlag: 0, activity: 0 });
  });
});

describe('extractTerminalNotifications', () => {
  it('parses OSC 9 message into kind', () => {
    expect(extractTerminalNotifications('\x1b]9;Codex: turn complete\x07')).toEqual([
      { kind: 'turn-complete', message: 'Codex: turn complete' }
    ]);
    expect(extractTerminalNotifications('\x1b]9;Approval requested: rm -rf\x1b\\')).toEqual([
      { kind: 'approval-requested', message: 'Approval requested: rm -rf' }
    ]);
    expect(extractTerminalNotifications('\x1b]9;opencode needs input\x07')).toEqual([
      { kind: 'input-requested', message: 'opencode needs input' }
    ]);
  });

  it('reports bare BEL as a generic bell, ignoring OSC-terminating BELs', () => {
    expect(extractTerminalNotifications('done\x07')).toEqual([{ kind: 'bell' }]);
    expect(extractTerminalNotifications('\x1b]0;title\x07')).toEqual([]);
  });

  it('fast-path returns empty for plain output with no BEL or OSC-9 marker', () => {
    // The indexOf guard must not change results: plain colored output has no markers.
    const plain = '\x1b[32mline 1 lorem ipsum\x1b[0m\r\nline 2 dolor sit amet\r\n';
    expect(extractTerminalNotifications(plain)).toEqual([]);
    expect(extractTerminalNotifications('')).toEqual([]);
    // OSC-9 terminated by ST (no BEL anywhere) must still be detected past the guard.
    expect(extractTerminalNotifications('\x1b]9;done\x1b\\')).toEqual([{ kind: 'turn-complete', message: 'done' }]);
  });
});

describe('AttentionTracker events', () => {
  it('stores events newest-first with unread counting and mark-read', () => {
    const tracker = new AttentionTracker();
    tracker.pushEvent('s1', 'bell');
    const second = tracker.pushEvent('s2', 'turn-complete', 'done');
    expect(tracker.unreadCount()).toBe(2);
    expect(tracker.listEvents()[0]?.tmuxSession).toBe('s2');
    tracker.markEventsRead({ ids: [second.id] });
    expect(tracker.unreadCount()).toBe(1);
    tracker.markEventsRead({ all: true });
    expect(tracker.unreadCount()).toBe(0);
  });

  it('upgrades a fresh unread bell when a precise event follows', () => {
    const tracker = new AttentionTracker();
    tracker.pushEvent('s1', 'bell');
    tracker.pushEvent('s1', 'approval-requested', 'Approve?');
    const events = tracker.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('approval-requested');
    expect(events[0]?.message).toBe('Approve?');
  });

  it('upgrades a fresh unread bell when a precise input request follows', () => {
    const tracker = new AttentionTracker();
    tracker.pushEvent('s1', 'bell');
    tracker.pushEvent('s1', 'input-requested', 'Question?');
    const events = tracker.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('input-requested');
    expect(events[0]?.message).toBe('Question?');
  });

  it('does not upgrade bells of other sessions or read bells', () => {
    const tracker = new AttentionTracker();
    tracker.pushEvent('s1', 'bell');
    tracker.markEventsRead({ all: true });
    tracker.pushEvent('s1', 'turn-complete');
    expect(tracker.listEvents()).toHaveLength(2);
    tracker.pushEvent('s2', 'turn-complete');
    expect(tracker.listEvents()).toHaveLength(3);
  });

  it('touching a session marks its events read', () => {
    const tracker = new AttentionTracker();
    tracker.raise('s1');
    tracker.pushEvent('s1', 'bell');
    tracker.pushEvent('s2', 'bell');
    tracker.clear('s1');
    expect(tracker.unreadCount()).toBe(1);
    expect(tracker.listEvents().find((e) => e.tmuxSession === 's1')?.read).toBe(true);
  });

  it('clearEvents erases the whole list', () => {
    const tracker = new AttentionTracker();
    tracker.pushEvent('s1', 'bell');
    tracker.pushEvent('s2', 'turn-complete');
    tracker.clearEvents();
    expect(tracker.listEvents()).toEqual([]);
    expect(tracker.unreadCount()).toBe(0);
  });

  it('carries channel navigation metadata on events', () => {
    const tracker = new AttentionTracker();
    const event = tracker.pushEvent('s1', 'channel', '#ops @alpha: hi', {
      channel: 'ops',
      messageId: 'msg-1-aaaa',
      thread: 'msg-0-root'
    });
    expect(event).toMatchObject({ channel: 'ops', messageId: 'msg-1-aaaa', thread: 'msg-0-root' });
    expect(tracker.listEvents()[0]).toMatchObject({ channel: 'ops', messageId: 'msg-1-aaaa' });
  });

  it('reading all of a session\'s events clears its attention lamp (sidebar sync)', () => {
    const tracker = new AttentionTracker();
    tracker.raise('s1');
    tracker.raise('s2');
    const first = tracker.pushEvent('s1', 'turn-complete');
    tracker.pushEvent('s1', 'bell');
    tracker.pushEvent('s2', 'turn-complete');

    tracker.markEventsRead({ ids: [first.id] });
    expect(tracker.snapshot().s1).toBeDefined(); // one unread remains → lamp stays

    tracker.markEventsRead({ all: true });
    expect(tracker.snapshot()).toEqual({}); // everything read → all lamps off
    // acknowledgment timestamps recorded so latched bells do not re-raise
    expect(tracker.lastClearedAt('s1')).toBeGreaterThan(0);
    expect(tracker.lastClearedAt('s2')).toBeGreaterThan(0);
  });

  it('clearEvents clears every attention lamp with the log', () => {
    const tracker = new AttentionTracker();
    tracker.raise('s1');
    tracker.pushEvent('s1', 'bell');
    tracker.clearEvents();
    expect(tracker.snapshot()).toEqual({});
    expect(tracker.lastClearedAt('s1')).toBeGreaterThan(0);
  });

  it('marks events read by kind', () => {
    const tracker = new AttentionTracker();
    tracker.pushEvent('s1', 'channel', '#ops @alpha: hi');
    tracker.pushEvent('s2', 'turn-complete');
    tracker.markEventsRead({ kinds: ['channel'] });
    expect(tracker.listEvents().find((e) => e.kind === 'channel')?.read).toBe(true);
    expect(tracker.listEvents().find((e) => e.kind === 'turn-complete')?.read).toBe(false);
  });

  it('raise reports whether the state is new', () => {
    const tracker = new AttentionTracker();
    expect(tracker.raise('s1')).toBe(true);
    expect(tracker.raise('s1')).toBe(false);
  });
});

describe('containsTerminalNotification', () => {
  it('detects a bare BEL', () => {
    expect(containsTerminalNotification('done\x07')).toBe(true);
    expect(containsTerminalNotification('plain output')).toBe(false);
  });

  it('detects OSC 9 notifications (BEL or ST terminated)', () => {
    expect(containsTerminalNotification('\x1b]9;Turn complete\x07')).toBe(true);
    expect(containsTerminalNotification('\x1b]9;Turn complete\x1b\\')).toBe(true);
  });

  it('ignores BEL used as OSC terminator for non-notification OSC (title set)', () => {
    // OSC 0 (title) terminated by BEL is routine TUI noise, not a notification.
    expect(containsTerminalNotification('\x1b]0;my title\x07')).toBe(false);
  });
});

describe('detectBellEdges', () => {
  const flags = (bellFlag: number, activity = 100) => ({ bellFlag, activity });

  it('reports sessions whose bell flag rose since the previous poll', () => {
    const previous = new Map([
      ['a', 0],
      ['b', 1]
    ]);
    const current = new Map([
      ['a', flags(1)],
      ['b', flags(1)],
      ['c', flags(1)]
    ]);
    expect(detectBellEdges(previous, current).sort()).toEqual(['a', 'c']);
  });

  it('does not re-report a latched flag without new activity', () => {
    const previous = new Map([['a', 1]]);
    const current = new Map([['a', flags(1, 100)]]);
    expect(detectBellEdges(previous, current, () => 200)).toEqual([]);
  });

  it('re-raises a latched flag when output happened after the last user touch', () => {
    const previous = new Map([['a', 1]]);
    const current = new Map([['a', flags(1, 300)]]);
    expect(detectBellEdges(previous, current, () => 200)).toEqual(['a']);
  });

  it('ignores sessions with no bell flag', () => {
    const current = new Map([['a', flags(0, 999)]]);
    expect(detectBellEdges(new Map(), current, () => 1)).toEqual([]);
  });
});

describe('isLikelyUserInput', () => {
  it('treats typing, enter, and control chars as user input', () => {
    expect(isLikelyUserInput('a')).toBe(true);
    expect(isLikelyUserInput('\r')).toBe(true);
    expect(isLikelyUserInput('\x03')).toBe(true); // ctrl+c
    expect(isLikelyUserInput('hello world\r')).toBe(true);
  });

  it('treats arrow keys and bracketed paste as user input', () => {
    expect(isLikelyUserInput('\x1b[A')).toBe(true);
    expect(isLikelyUserInput('\x1b[200~pasted\x1b[201~')).toBe(true);
  });

  it('ignores terminal auto-replies (DA, CPR, DSR, DECRPM, OSC, DCS, focus)', () => {
    expect(isLikelyUserInput('\x1b[?1;2c')).toBe(false); // DA1 response
    expect(isLikelyUserInput('\x1b[>0;276;0c')).toBe(false); // DA2 response
    expect(isLikelyUserInput('\x1b[24;80R')).toBe(false); // CPR
    expect(isLikelyUserInput('\x1b[?24;80;1R')).toBe(false); // DECXCPR
    expect(isLikelyUserInput('\x1b[0n')).toBe(false); // DSR ok
    expect(isLikelyUserInput('\x1b[?2026;2$y')).toBe(false); // DECRPM
    expect(isLikelyUserInput('\x1b]10;rgb:bf/fc/ff\x07')).toBe(false); // OSC color reply
    expect(isLikelyUserInput('\x1bP1+r544e\x1b\\')).toBe(false); // DCS reply
    expect(isLikelyUserInput('\x1b[I')).toBe(false); // focus in
    expect(isLikelyUserInput('\x1b[O')).toBe(false); // focus out
    expect(isLikelyUserInput('\x1b[?1;2c\x1b[24;80R')).toBe(false); // combined replies
    expect(isLikelyUserInput('')).toBe(false);
  });

  it('detects user input mixed with auto-replies', () => {
    expect(isLikelyUserInput('\x1b[?1;2cq')).toBe(true);
  });
});

describe('AttentionTracker', () => {
  it('raises and clears attention per session', () => {
    const tracker = new AttentionTracker();
    expect(tracker.snapshot()).toEqual({});
    tracker.raise('s1');
    expect(tracker.snapshot().s1?.attention).toBe(true);
    expect(typeof tracker.snapshot().s1?.since).toBe('string');
    tracker.clear('s1');
    expect(tracker.snapshot()).toEqual({});
  });

  it('keeps the original timestamp when raised twice', () => {
    const tracker = new AttentionTracker();
    tracker.raise('s1');
    const first = tracker.snapshot().s1?.since;
    tracker.raise('s1');
    expect(tracker.snapshot().s1?.since).toBe(first);
  });

  it('clearing an unknown session is a no-op', () => {
    const tracker = new AttentionTracker();
    expect(() => tracker.clear('nope')).not.toThrow();
  });

  it('dropDead clears attention and unread events for sessions gone from tmux', () => {
    const tracker = new AttentionTracker();
    tracker.raise('alive');
    tracker.raise('dead');
    tracker.pushEvent('dead', 'turn-complete', 'done');
    expect(tracker.unreadCount()).toBe(1);
    const dropped = tracker.dropDead(new Set(['alive', 'unrelated']));
    expect(dropped).toEqual(['dead']);
    expect(tracker.snapshot()).toHaveProperty('alive');
    expect(tracker.snapshot()).not.toHaveProperty('dead');
    // the dead session's events are acknowledged, not deleted
    expect(tracker.unreadCount()).toBe(0);
    expect(tracker.listEvents()).toHaveLength(1);
  });

  it('dropDead with every session alive changes nothing', () => {
    const tracker = new AttentionTracker();
    tracker.raise('s1');
    expect(tracker.dropDead(new Set(['s1']))).toEqual([]);
    expect(tracker.snapshot()).toHaveProperty('s1');
  });
});
