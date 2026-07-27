import { useCallback, useEffect, useRef, useState } from 'react';
import { clearAllEvents, fetchEvents, markEventsRead } from './api.js';
import type { DeskEvent, DeskEventKind } from '../shared/controlPlane/index.js';

/**
 * Owns the unified event feed: one journal carrying agent transitions and
 * channel notifications, with one ordering and one unread count.
 *
 * Acknowledgement is journal-only. Marking an entry read changes what the
 * operator has seen; it never changes what an agent is doing and never clears
 * a session lamp. Those come from the authority, and an agent waiting for
 * approval keeps waiting whether or not its notification was read.
 *
 * The server's `unread` is authoritative. Local mutations apply optimistically
 * so the badge does not lag a click, but every poll reconciles against the
 * server value rather than trusting the local count to stay correct.
 */
export interface EventFeed {
  events: DeskEvent[];
  unread: number;
  error: string | null;
  markRead: (payload: { ids?: string[]; all?: boolean; kinds?: DeskEventKind[] }) => void;
  clearAll: () => void;
  /** Applies a local read mark immediately, then reconciles on the next poll. */
  markReadLocally: (id: string) => void;
}

const POLL_MS = 2000;

export function useEventFeed(): EventFeed {
  const [events, setEvents] = useState<DeskEvent[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Bumped by every local mutation so a response already in flight cannot
  // resurrect the state the operator just changed.
  const generationRef = useRef(0);
  // Mirror of the rendered list. Read by the mutation handlers so they can
  // count what they are about to flip WITHOUT doing work inside a state
  // updater — an updater that also sets other state is a side effect in a
  // place React may call twice (R7).
  const eventsRef = useRef<DeskEvent[]>([]);

  const applyEvents = useCallback((next: DeskEvent[]): void => {
    eventsRef.current = next;
    setEvents(next);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const generation = generationRef.current;
    try {
      const feed = await fetchEvents();
      if (generation !== generationRef.current) {
        return;
      }
      applyEvents(feed.items);
      setUnread(feed.unread);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [applyEvents]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      void load();
    }, POLL_MS);
    const onVisible = (): void => {
      if (!document.hidden) {
        void load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const markRead = useCallback(
    (payload: { ids?: string[]; all?: boolean; kinds?: DeskEventKind[] }): void => {
      generationRef.current += 1;
      const current = eventsRef.current;
      // Decrement by what this call actually flips, not by a guess: marking an
      // already-read entry read must not shrink the badge.
      const newlyRead = current.filter((event) => !event.read && matchesRead(event, payload)).length;
      applyEvents(current.map((event) => (matchesRead(event, payload) ? { ...event, read: true } : event)));
      if (newlyRead > 0) {
        setUnread((count) => Math.max(0, count - newlyRead));
      }
      void markEventsRead(payload)
        .then((response) => setUnread(response.unread))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [applyEvents]
  );

  const clearAll = useCallback((): void => {
    generationRef.current += 1;
    applyEvents([]);
    setUnread(0);
    void clearAllEvents()
      .then((response) => setUnread(response.unread))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [applyEvents]);

  const markReadLocally = useCallback(
    (id: string): void => {
      generationRef.current += 1;
      const current = eventsRef.current;
      const wasUnread = current.some((event) => event.id === id && !event.read);
      applyEvents(current.map((event) => (event.id === id ? { ...event, read: true } : event)));
      if (wasUnread) {
        setUnread((count) => Math.max(0, count - 1));
      }
    },
    [applyEvents]
  );

  return { events, unread, error, markRead, clearAll, markReadLocally };
}

/** Mirrors the server's read selector so the optimistic view matches the reply. */
export function matchesRead(
  event: DeskEvent,
  payload: { ids?: string[]; all?: boolean; kinds?: DeskEventKind[] }
): boolean {
  if (payload.all === true) {
    return true;
  }
  if (payload.ids?.includes(event.id)) {
    return true;
  }
  return payload.kinds?.includes(event.kind) === true;
}
