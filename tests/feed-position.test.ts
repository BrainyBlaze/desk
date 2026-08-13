import { describe, expect, it } from 'vitest';
import {
  createFeedPosition,
  reduceFeedPosition,
  type FeedEvent,
  type FeedPositionState,
  type FeedWindowModel
} from '../src/web/channels/feedPosition.js';

const win = (ids: string[], overrides: Partial<FeedWindowModel> = {}): FeedWindowModel => ({
  ids,
  startIndex: 0,
  hasOlder: false,
  hasNewer: false,
  ...overrides
});

const open = (overrides: Partial<Extract<FeedEvent, { type: 'OPEN_CHANNEL' }>> = {}): FeedEvent => ({
  type: 'OPEN_CHANNEL',
  channel: 'dev',
  readId: null,
  firstUnreadId: null,
  restore: null,
  window: win(['m1', 'm2', 'm3']),
  ...overrides
});

const run = (state: FeedPositionState, events: FeedEvent[]) => {
  let current = state;
  const commands = [];
  for (const event of events) {
    const next = reduceFeedPosition(current, event);
    current = next.state;
    commands.push(...next.commands);
  }
  return { state: current, commands };
};

describe('feedPosition: channel open', () => {
  it('opens a never-visited channel pinned to the bottom', () => {
    const { state, commands } = run(createFeedPosition(), [open()]);
    expect(state.viewport.kind).toBe('pending');
    expect(commands).toEqual([{ t: 'scrollTo', target: { kind: 'bottom' }, gen: 1 }]);
  });

  it('opens at the first unread when no viewport was saved', () => {
    const { commands } = run(createFeedPosition(), [
      open({ readId: 'm1', firstUnreadId: 'm2' })
    ]);
    expect(commands[0]).toEqual({ t: 'scrollTo', target: { kind: 'first-unread', messageId: 'm2' }, gen: 1 });
  });

  it('returns to the saved viewport even when unread exists', () => {
    const { commands } = run(createFeedPosition(), [
      open({ readId: 'm1', firstUnreadId: 'm2', restore: { messageId: 'm2', offsetPx: -40 } })
    ]);
    expect(commands[0]).toEqual({
      t: 'scrollTo',
      target: { kind: 'restore', messageId: 'm2', offsetPx: -40 },
      gen: 1
    });
  });
});

describe('feedPosition: scroll certification', () => {
  const opened = () => run(createFeedPosition(), [open({ readId: 'm1', firstUnreadId: 'm2' })]).state;

  it('resolves pending on the certified programmatic completion', () => {
    const { state } = run(opened(), [
      { type: 'PROGRAMMATIC_DONE', gen: 1, atBottom: false, firstVisibleId: 'm2', offsetPx: 0 }
    ]);
    expect(state.viewport).toEqual({ kind: 'anchored', messageId: 'm2', offsetPx: 0 });
  });

  it('ignores a stale programmatic completion from an earlier generation', () => {
    const first = run(opened(), [{ type: 'JUMP_LATEST' }]);
    const { state } = run(first.state, [
      { type: 'PROGRAMMATIC_DONE', gen: 1, atBottom: false, firstVisibleId: 'm1', offsetPx: 0 }
    ]);
    expect(state.viewport.kind).toBe('pending');
  });

  it('does not resolve pending on a single uncertified scroll (browser clamp echo)', () => {
    const { state, commands } = run(opened(), [
      { type: 'USER_SCROLL', firstVisibleId: 'm1', offsetPx: -10, atBottom: false, certifiedGen: null }
    ]);
    expect(state.viewport.kind).toBe('pending');
    expect(commands.filter((c) => c.t === 'persistRead')).toEqual([]);
  });

  it('lets a second uncertified scroll interrupt pending (operator wins)', () => {
    const { state } = run(opened(), [
      { type: 'USER_SCROLL', firstVisibleId: 'm1', offsetPx: -10, atBottom: false, certifiedGen: null },
      { type: 'USER_SCROLL', firstVisibleId: 'm3', offsetPx: -80, atBottom: false, certifiedGen: null }
    ]);
    expect(state.viewport).toEqual({ kind: 'anchored', messageId: 'm3', offsetPx: -80 });
  });

  it('tracks the operator between follow and anchored from genuine scrolls', () => {
    const base = run(opened(), [
      { type: 'PROGRAMMATIC_DONE', gen: 1, atBottom: false, firstVisibleId: 'm2', offsetPx: 0 }
    ]).state;
    const followed = run(base, [
      { type: 'USER_SCROLL', firstVisibleId: 'm3', offsetPx: 0, atBottom: true, certifiedGen: null }
    ]).state;
    expect(followed.viewport.kind).toBe('follow-bottom');
    const back = run(followed, [
      { type: 'USER_SCROLL', firstVisibleId: 'm1', offsetPx: -5, atBottom: false, certifiedGen: null }
    ]).state;
    expect(back.viewport).toEqual({ kind: 'anchored', messageId: 'm1', offsetPx: -5 });
  });
});

describe('feedPosition: read pointer', () => {
  const anchored = () =>
    run(createFeedPosition(), [
      open({ readId: 'm1', firstUnreadId: 'm2' }),
      { type: 'PROGRAMMATIC_DONE', gen: 1, atBottom: false, firstVisibleId: 'm2', offsetPx: 0 }
    ]).state;

  it('advances the pointer forward only, and persists it', () => {
    const { state, commands } = run(anchored(), [
      { type: 'SCROLLED_PAST', messageId: 'm2', certifiedGen: null },
      { type: 'SCROLLED_PAST', messageId: 'm1', certifiedGen: null }
    ]);
    expect(state.readId).toBe('m2');
    expect(commands.filter((c) => c.t === 'persistRead')).toEqual([
      { t: 'persistRead', channel: 'dev', id: 'm2' }
    ]);
  });

  it('never advances from a certified (programmatic) pass', () => {
    const { state } = run(anchored(), [{ type: 'SCROLLED_PAST', messageId: 'm3', certifiedGen: 1 }]);
    expect(state.readId).toBe('m1');
  });

  it('never advances while hidden or reflowing', () => {
    const hidden = run(anchored(), [
      { type: 'VISIBILITY', active: false },
      { type: 'SCROLLED_PAST', messageId: 'm3', certifiedGen: null }
    ]).state;
    expect(hidden.readId).toBe('m1');
    const reflowing = run(anchored(), [
      { type: 'REFLOW', active: true },
      { type: 'ACK_VISIBLE', messageId: 'm3' }
    ]).state;
    expect(reflowing.readId).toBe('m1');
  });

  it('never advances while the viewport is pending', () => {
    const pending = run(createFeedPosition(), [open({ readId: 'm1', firstUnreadId: 'm2' })]).state;
    const { state } = run(pending, [{ type: 'SCROLLED_PAST', messageId: 'm3', certifiedGen: null }]);
    expect(state.readId).toBe('m1');
  });
});

describe('feedPosition: window mutations', () => {
  it('keeps following the bottom across appends and commands the re-pin', () => {
    const followed = run(createFeedPosition(), [
      open(),
      { type: 'PROGRAMMATIC_DONE', gen: 1, atBottom: true, firstVisibleId: 'm3', offsetPx: 0 }
    ]).state;
    const { state, commands } = run(followed, [
      { type: 'WINDOW_APPLIED', reason: 'newer', window: win(['m1', 'm2', 'm3', 'm4']) }
    ]);
    expect(state.viewport.kind).toBe('follow-bottom');
    expect(commands).toContainEqual({ t: 'scrollTo', target: { kind: 'bottom' }, gen: 2 });
  });

  it('holds the anchor when it survives the applied window', () => {
    const anchored = run(createFeedPosition(), [
      open({ readId: 'm1', firstUnreadId: 'm2' }),
      { type: 'PROGRAMMATIC_DONE', gen: 1, atBottom: false, firstVisibleId: 'm2', offsetPx: -30 }
    ]).state;
    const { state, commands } = run(anchored, [
      { type: 'WINDOW_APPLIED', reason: 'older', window: win(['m0', 'm1', 'm2', 'm3']) }
    ]);
    expect(state.viewport).toEqual({ kind: 'anchored', messageId: 'm2', offsetPx: -30 });
    expect(commands).toEqual([]);
  });

  it('re-anchors to the nearest surviving neighbour when the anchor is deleted', () => {
    const anchored = run(createFeedPosition(), [
      open({ readId: 'm1', firstUnreadId: 'm2' }),
      { type: 'PROGRAMMATIC_DONE', gen: 1, atBottom: false, firstVisibleId: 'm2', offsetPx: 0 }
    ]).state;
    const { state, commands } = run(anchored, [
      { type: 'WINDOW_APPLIED', reason: 'poll', window: win(['m1', 'm3']) }
    ]);
    expect(state.viewport.kind).toBe('pending');
    expect(commands[0]).toEqual({
      t: 'scrollTo',
      target: { kind: 'message', messageId: 'm3', align: 'start' },
      gen: 2
    });
  });
});

describe('feedPosition: tail-follow reads', () => {
  const followed = () =>
    run(createFeedPosition(), [
      open(),
      { type: 'PROGRAMMATIC_DONE', gen: 1, atBottom: true, firstVisibleId: 'm3', offsetPx: 0 }
    ]).state;

  it('marks the tail read when a newer window lands while following', () => {
    const { state, commands } = run(followed(), [
      { type: 'WINDOW_APPLIED', reason: 'newer', window: win(['m1', 'm2', 'm3', 'm4']) }
    ]);
    expect(state.readId).toBe('m4');
    expect(commands).toContainEqual({ t: 'persistRead', channel: 'dev', id: 'm4' });
  });

  it('does not mark the tail read while hidden, reflowing, or when newer pages exist', () => {
    const hidden = run(followed(), [
      { type: 'VISIBILITY', active: false },
      { type: 'WINDOW_APPLIED', reason: 'newer', window: win(['m1', 'm2', 'm3', 'm4']) }
    ]).state;
    expect(hidden.readId).toBeNull();
    const paged = run(followed(), [
      { type: 'WINDOW_APPLIED', reason: 'newer', window: win(['m1', 'm2', 'm3', 'm4'], { hasNewer: true }) }
    ]).state;
    expect(paged.readId).toBeNull();
  });

  it('never marks the tail read while anchored mid-history', () => {
    const anchored = run(createFeedPosition(), [
      open({ readId: 'm1', firstUnreadId: 'm2' }),
      { type: 'PROGRAMMATIC_DONE', gen: 1, atBottom: false, firstVisibleId: 'm2', offsetPx: 0 }
    ]).state;
    const { state } = run(anchored, [
      { type: 'WINDOW_APPLIED', reason: 'newer', window: win(['m1', 'm2', 'm3', 'm4']) }
    ]);
    expect(state.readId).toBe('m1');
  });
});

describe('feedPosition: reflow self-heal', () => {
  it('a genuine user scroll clears a stranded reflowing flag and resumes reads', () => {
    const stuck = run(createFeedPosition(), [
      open({ readId: 'm1', firstUnreadId: 'm2' }),
      { type: 'PROGRAMMATIC_DONE', gen: 1, atBottom: false, firstVisibleId: 'm2', offsetPx: 0 },
      { type: 'REFLOW', active: true }
    ]).state;
    expect(stuck.reflowing).toBe(true);
    const scrolled = run(stuck, [
      { type: 'USER_SCROLL', firstVisibleId: 'm2', offsetPx: -5, atBottom: false, certifiedGen: null }
    ]).state;
    expect(scrolled.reflowing).toBe(false);
    const { state } = run(scrolled, [{ type: 'SCROLLED_PAST', messageId: 'm2', certifiedGen: null }]);
    expect(state.readId).toBe('m2');
  });
});
