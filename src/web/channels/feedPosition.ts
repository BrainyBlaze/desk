/** Why a window was (re)loaded — drives applyWindow's merge semantics and the
    reducer's WINDOW_APPLIED handling. */
export type WindowReason = 'init' | 'poll' | 'older' | 'newer' | 'around' | 'jump';

export interface FeedWindowModel {
  ids: string[];
  startIndex: number;
  hasOlder: boolean;
  hasNewer: boolean;
}

export type PendingTarget =
  | { kind: 'bottom' }
  | { kind: 'first-unread'; messageId: string }
  | { kind: 'message'; messageId: string; align: 'start' | 'auto' }
  | { kind: 'restore'; messageId: string | null; offsetPx: number };

export type FeedViewport =
  | { kind: 'follow-bottom' }
  | { kind: 'anchored'; messageId: string; offsetPx: number }
  | { kind: 'pending'; target: PendingTarget; gen: number; sawUncertified?: boolean };

export interface FeedPositionState {
  channel: string | null;
  viewport: FeedViewport;
  readId: string | null;
  gen: number;
  reflowing: boolean;
  active: boolean;
  window: FeedWindowModel;
}

export type FeedEvent =
  | {
      type: 'OPEN_CHANNEL';
      channel: string;
      readId: string | null;
      firstUnreadId: string | null;
      restore: { messageId: string | null; offsetPx: number } | null;
      window: FeedWindowModel;
    }
  | { type: 'WINDOW_APPLIED'; reason: WindowReason; window: FeedWindowModel }
  | {
      type: 'USER_SCROLL';
      firstVisibleId: string | null;
      offsetPx: number;
      atBottom: boolean;
      certifiedGen: number | null;
    }
  | { type: 'PROGRAMMATIC_DONE'; gen: number; atBottom: boolean; firstVisibleId: string | null; offsetPx: number }
  | { type: 'SCROLLED_PAST'; messageId: string; certifiedGen: number | null }
  | { type: 'ACK_VISIBLE'; messageId: string }
  | { type: 'REFLOW'; active: boolean }
  | { type: 'VISIBILITY'; active: boolean }
  | { type: 'JUMP_LATEST' }
  | { type: 'NAVIGATE'; messageId: string };

export type FeedCommand =
  | { t: 'scrollTo'; target: PendingTarget; gen: number }
  | { t: 'persistRead'; channel: string; id: string };

export interface FeedReduction {
  state: FeedPositionState;
  commands: FeedCommand[];
}

export function createFeedPosition(): FeedPositionState {
  return {
    channel: null,
    viewport: { kind: 'follow-bottom' },
    readId: null,
    gen: 0,
    reflowing: false,
    active: true,
    window: { ids: [], startIndex: 0, hasOlder: false, hasNewer: false }
  };
}

function windowOrder(window: FeedWindowModel, id: string): number {
  return window.ids.indexOf(id);
}

function readAdvances(state: FeedPositionState, messageId: string): boolean {
  if (!state.active || state.reflowing || state.viewport.kind === 'pending') {
    return false;
  }
  if (windowOrder(state.window, messageId) === -1) {
    return false;
  }
  if (state.readId === null) {
    return true;
  }
  const current = windowOrder(state.window, state.readId);
  const next = windowOrder(state.window, messageId);
  return current === -1 ? true : next > current;
}

function advanceRead(state: FeedPositionState, messageId: string): FeedReduction {
  if (!readAdvances(state, messageId) || state.channel === null) {
    return { state, commands: [] };
  }
  return {
    state: { ...state, readId: messageId },
    commands: [{ t: 'persistRead', channel: state.channel, id: messageId }]
  };
}

function beginPending(state: FeedPositionState, target: PendingTarget): FeedReduction {
  const gen = state.gen + 1;
  return {
    state: { ...state, gen, viewport: { kind: 'pending', target, gen } },
    commands: [{ t: 'scrollTo', target, gen }]
  };
}

export function reduceFeedPosition(state: FeedPositionState, event: FeedEvent): FeedReduction {
  switch (event.type) {
    case 'OPEN_CHANNEL': {
      const opened: FeedPositionState = {
        ...createFeedPosition(),
        channel: event.channel,
        readId: event.readId,
        active: state.active,
        gen: state.gen,
        window: event.window
      };
      if (event.restore !== null) {
        return beginPending(opened, {
          kind: 'restore',
          messageId: event.restore.messageId,
          offsetPx: event.restore.offsetPx
        });
      }
      if (event.firstUnreadId !== null) {
        return beginPending(opened, { kind: 'first-unread', messageId: event.firstUnreadId });
      }
      return beginPending(opened, { kind: 'bottom' });
    }

    case 'WINDOW_APPLIED': {
      const next = { ...state, window: event.window };
      if (state.viewport.kind === 'follow-bottom') {
        const grewNewer = event.window.ids.length > 0;
        if (grewNewer && (event.reason === 'newer' || event.reason === 'poll' || event.reason === 'jump')) {
          const gen = state.gen + 1;
          const pinned: FeedPositionState = { ...next, gen, viewport: state.viewport };
          const commands: FeedCommand[] = [{ t: 'scrollTo', target: { kind: 'bottom' }, gen }];
          if (!event.window.hasNewer) {
            const tail = event.window.ids[event.window.ids.length - 1];
            const advanced = advanceRead(pinned, tail);
            return { state: advanced.state, commands: [...commands, ...advanced.commands] };
          }
          return { state: pinned, commands };
        }
        return { state: next, commands: [] };
      }
      if (state.viewport.kind === 'anchored') {
        if (windowOrder(event.window, state.viewport.messageId) !== -1) {
          return { state: next, commands: [] };
        }
        const previous = windowOrder(state.window, state.viewport.messageId);
        const successor = state.window.ids
          .slice(previous === -1 ? 0 : previous + 1)
          .find((id) => windowOrder(event.window, id) !== -1);
        if (successor !== undefined) {
          return beginPending(next, { kind: 'message', messageId: successor, align: 'start' });
        }
        return beginPending(next, { kind: 'bottom' });
      }
      return { state: next, commands: [] };
    }

    case 'USER_SCROLL': {
      if (state.viewport.kind === 'pending') {
        if (event.certifiedGen === state.viewport.gen) {
          return {
            state: {
              ...state,
              viewport: event.atBottom
                ? { kind: 'follow-bottom' }
                : event.firstVisibleId !== null
                  ? { kind: 'anchored', messageId: event.firstVisibleId, offsetPx: event.offsetPx }
                  : state.viewport
            },
            commands: []
          };
        }
        if (event.certifiedGen !== null) {
          return { state, commands: [] };
        }
        if (!state.viewport.sawUncertified) {
          return {
            state: { ...state, viewport: { ...state.viewport, sawUncertified: true } },
            commands: []
          };
        }
        return {
          state: {
            ...state,
            viewport: event.atBottom
              ? { kind: 'follow-bottom' }
              : event.firstVisibleId !== null
                ? { kind: 'anchored', messageId: event.firstVisibleId, offsetPx: event.offsetPx }
                : { kind: 'follow-bottom' }
          },
          commands: []
        };
      }
      if (event.certifiedGen !== null) {
        return { state, commands: [] };
      }
      if (event.atBottom) {
        return { state: { ...state, reflowing: false, viewport: { kind: 'follow-bottom' } }, commands: [] };
      }
      if (event.firstVisibleId !== null) {
        return {
          state: {
            ...state,
            reflowing: false,
            viewport: { kind: 'anchored', messageId: event.firstVisibleId, offsetPx: event.offsetPx }
          },
          commands: []
        };
      }
      return { state, commands: [] };
    }

    case 'PROGRAMMATIC_DONE': {
      if (state.viewport.kind !== 'pending' || event.gen !== state.viewport.gen) {
        return { state, commands: [] };
      }
      return {
        state: {
          ...state,
          viewport: event.atBottom
            ? { kind: 'follow-bottom' }
            : event.firstVisibleId !== null
              ? { kind: 'anchored', messageId: event.firstVisibleId, offsetPx: event.offsetPx }
              : { kind: 'follow-bottom' }
        },
        commands: []
      };
    }

    case 'SCROLLED_PAST': {
      if (event.certifiedGen !== null) {
        return { state, commands: [] };
      }
      return advanceRead(state, event.messageId);
    }

    case 'ACK_VISIBLE':
      return advanceRead(state, event.messageId);

    case 'REFLOW':
      return { state: { ...state, reflowing: event.active }, commands: [] };

    case 'VISIBILITY':
      return { state: { ...state, active: event.active }, commands: [] };

    case 'JUMP_LATEST':
      return beginPending(state, { kind: 'bottom' });

    case 'NAVIGATE':
      return beginPending(state, { kind: 'message', messageId: event.messageId, align: 'auto' });
  }
}
