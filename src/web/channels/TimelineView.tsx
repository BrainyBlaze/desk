import { useCallback, useEffect, useState } from 'react';
import { ListOrdered } from 'lucide-react';
import { ActionModal, useActionSounds } from './ActionModal.js';
import { channelsEvents, type DeliveryEvent, type DeliveryEventKind } from './channelsClient.js';

// Exhaustive kind -> label map (Theme C): a new DeliveryEventKind tsc-forces an
// entry, so the timeline can never silently drop a transition type.
const KIND_LABEL: Record<DeliveryEventKind, string> = {
  delivering: 'delivering',
  submitted: 'submitted',
  'delivery-ack-timeout': 'ack-timeout',
  'submit-stuck-paste': 'stuck-paste',
  'submit-stuck-submit': 'stuck-submit',
  'submit-stuck-unobservable': 'stuck-unobs',
  paused: 'paused',
  queued: 'queued',
  released: 'released',
  resumed: 'resumed',
  dropped: 'dropped',
  'input-requested': 'input-req',
  'approval-requested': 'approval-req'
};

const WARN_KINDS = new Set<DeliveryEventKind>([
  'submit-stuck-paste',
  'submit-stuck-submit',
  'submit-stuck-unobservable',
  'delivery-ack-timeout',
  'dropped',
  'input-requested',
  'approval-requested'
]);

function clock(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * delivery-history timeline — the durable transition log (queued / delivering
 * / submitted / stuck / paused / released / resumed / dropped / input- &
 * approval-requested) over glm's append-only events ring, via GET
 * /api/channels/events. Newest-first; an event with a channel+message navigates
 * to its source. Distinct from the live feed (current activity) — this is the
 * "transitions over time" view. Self-fetches like the other panels.
 */
export function TimelineView({
  open,
  onClose,
  onNavigate
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (channel: string, messageId: string) => void;
}): JSX.Element | null {
  const [events, setEvents] = useState<DeliveryEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sounds = useActionSounds();

  const refresh = useCallback(async () => {
    try {
      const res = await channelsEvents({ limit: 200 });
      setEvents([...res.items].reverse()); // newest-first
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
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  if (!open) {
    return null;
  }

  const activate = (event: DeliveryEvent): void => {
    if (event.channel && event.messageId) {
      onClose();
      onNavigate(event.channel, event.messageId);
    }
  };

  return (
    <ActionModal open={open} title="Delivery timeline" icon={<ListOrdered size={13} />} onClose={onClose} wide>
      <div className="chanActionMeta">
        <span>{events.length} transitions</span>
      </div>
      {error ? <div className="chanTimelineError">{error}</div> : null}
      {events.length === 0 ? (
        <div className="chanTimelineEmpty">No delivery transitions recorded yet.</div>
      ) : (
        <ul className="chanTimelineList">
          {events.map((event) => (
            <li key={event.seq} className="chanTimelineItem">
              <button
                className="chanTimelineRow"
                onMouseEnter={sounds.hover}
                onClick={() => sounds.click(() => activate(event))}
                disabled={!(event.channel && event.messageId)}
              >
                  <span className={`chanTimelineKind ${WARN_KINDS.has(event.kind) ? 'warn' : ''}`}>{KIND_LABEL[event.kind]}</span>
                  {event.to ?? event.tmuxSession ? (
                    <span className="chanTimelineSession">{event.to ?? event.tmuxSession}</span>
                  ) : null}
                  {event.channel ? <span className="chanTimelineChannel">#{event.channel}</span> : null}
                  <span className="chanTimelinePreview" title={event.reason ?? event.preview ?? ''}>
                    {event.reason ?? event.preview ?? ''}
                  </span>
                  <span className="chanTimelineTime">{clock(event.at)}</span>
                </button>
              </li>
            ))}
          </ul>
      )}
    </ActionModal>
  );
}
