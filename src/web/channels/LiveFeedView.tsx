import { useCallback, useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { ActionModal, useActionSounds } from './ActionModal.js';
import { channelsState, type ChannelActivityEvent, type ChannelsState } from './channelsClient.js';

// Exhaustive kind -> label map (Theme C): a new ChannelActivityEvent kind tsc-forces
// an entry here so the live feed can never silently drop an event type.
const KIND_LABEL: Record<ChannelActivityEvent['kind'], string> = {
  message: 'msg',
  queued: 'queued',
  delivery: 'delivered',
  'human-mention': '@human'
};

/** thread parent id when the event lives in a thread file, else undefined. */
function threadOf(file: string): string | undefined {
  const match = /^thread-msg-(.+)\.md$/.exec(file);
  return match ? match[1] : undefined;
}

/** HH:MM:SS (local) from the event's ISO timestamp. */
function clock(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * live delivery feed — "what is happening now and why stuck". Self-fetches
 * the cheap /state poll (ChannelsState.activity, which now includes the queued
 * enqueue event), newest-first. Each event navigates to its source message via
 * the shared thread-aware nav. No new persistence, no new endpoint — a view over
 * the activity stream the hub already polls. Self-fetches like the other panels.
 */
export function LiveFeedView({
  open,
  onClose,
  onNavigate
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (channel: string, messageId: string, thread?: string) => void;
}): JSX.Element | null {
  const [events, setEvents] = useState<ChannelActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sounds = useActionSounds();

  const refresh = useCallback(async () => {
    try {
      const state: ChannelsState = await channelsState();
      // newest-first: the latest activity sits at the top of the feed
      setEvents([...state.activity].reverse());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  if (!open) {
    return null;
  }

  const activate = (event: ChannelActivityEvent): void => {
    onClose();
    onNavigate(event.channel, event.messageId, threadOf(event.file));
  };

  return (
    <ActionModal open={open} title="Live feed" icon={<Activity size={13} />} onClose={onClose} wide>
      <div className="chanActionMeta">
        <span>{events.length} events</span>
      </div>
      {error ? <div className="chanFeedViewError">{error}</div> : null}
      {events.length === 0 ? (
        <div className="chanFeedViewEmpty">No recent activity.</div>
      ) : (
        <ul className="chanFeedViewList">
          {events.map((event) => (
            <li key={event.seq} className="chanFeedViewItem">
              <button className="chanFeedViewRow" onMouseEnter={sounds.hover} onClick={() => sounds.click(() => activate(event))}>
                  <span className={`chanFeedViewKind ${event.kind}`}>{KIND_LABEL[event.kind]}</span>
                  <span className="chanFeedViewChannel">#{event.channel}</span>
                  <span className="chanFeedViewAuthor">@{event.target ?? event.author}</span>
                  <span className="chanFeedViewPreview" title={event.preview}>
                    {event.preview}
                  </span>
                  {threadOf(event.file) ? <span className="chanFeedViewThread">thread</span> : null}
                  <span className="chanFeedViewTime">{clock(event.at)}</span>
                </button>
              </li>
            ))}
          </ul>
      )}
    </ActionModal>
  );
}
