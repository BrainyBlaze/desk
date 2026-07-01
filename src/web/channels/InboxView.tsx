import { useCallback, useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { ActionModal, useActionSounds } from './ActionModal.js';
import { channelsState, type ChannelsState } from './channelsClient.js';
import { buildInboxItems, type InboxItem } from './channelsModel.js';

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  'submit-stuck': 'stuck',
  blocked: 'blocked',
  'awaiting-approval': 'approval',
  paused: 'paused',
  dropped: 'dropped',
  'needs-reply': 'reply',
  mention: 'mention'
};

/**
 * Operator Inbox — aggregates needs-attention items from the cheap /state
 * sources (delivery lifecycle + @human mentions) via the pure buildInboxItems
 * helper. A mention navigates to its source message; a delivery-attention item
 * opens the engine console (deep diagnostics plus force/drop controls) — no
 * duplicated recovery UI. Self-fetches like EngineConsole; off the hot poll.
 */
export function InboxView({
  open,
  onClose,
  onNavigate,
  onOpenEngine
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (channel: string, messageId?: string) => void;
  onOpenEngine: () => void;
}): JSX.Element | null {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sounds = useActionSounds();

  const refresh = useCallback(async () => {
    try {
      const state: ChannelsState = await channelsState();
      setItems(buildInboxItems(state.delivery, state.activity));
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

  const activate = (item: InboxItem): void => {
    onClose();
    if ((item.kind === 'mention' || item.kind === 'needs-reply') && item.channel) {
      onNavigate(item.channel, item.messageId);
    } else {
      // delivery-attention: hand off to the engine console for diagnostics + recovery
      onOpenEngine();
    }
  };

  return (
    <ActionModal open={open} title="Needs attention" icon={<Inbox size={13} />} onClose={onClose}>
      <div className="chanActionMeta">
        <span>{items.length} items</span>
      </div>
      {error ? <div className="chanInboxError">{error}</div> : null}
      {items.length === 0 ? (
        <div className="chanInboxEmpty">All clear — nothing needs attention.</div>
      ) : (
        <ul className="chanInboxList">
          {items.map((item) => (
            <li key={item.id} className="chanInboxItem">
              <button className="chanInboxRow" onMouseEnter={sounds.hover} onClick={() => sounds.click(() => activate(item))}>
                  <span className={`chanInboxKind ${item.kind}`}>{KIND_LABEL[item.kind]}</span>
                  <span className="chanInboxLabel">{item.label}</span>
                  {item.detail ? (
                    <span className="chanInboxDetail" title={item.detail}>
                      {item.detail}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
      )}
    </ActionModal>
  );
}
