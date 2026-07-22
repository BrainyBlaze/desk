import { describe, expect, it } from 'vitest';
import {
  AttentionTracker,
} from '../src/server/attention.js';
import { TerminalSequenceTokenizer } from '../src/shared/terminalSequenceTokenizer.js';



describe('AttentionTracker events', () => {
  it('stores events newest-first with unread counting and mark-read', () => {
    const tracker = new AttentionTracker();
    tracker.pushEvent('s1', 'bell');
    const second = tracker.pushEvent('s2', 'turn-complete', 'done');
    expect(tracker.unreadCount()).toBe(2);
    expect(tracker.listEvents()[0]?.sessionId).toBe('s2');
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
    expect(tracker.listEvents().find((e) => e.sessionId === 's1')?.read).toBe(true);
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
