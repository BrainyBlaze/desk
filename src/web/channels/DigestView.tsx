import { useCallback, useEffect, useState } from 'react';
import { Newspaper } from 'lucide-react';
import { ActionModal, useActionSounds } from './ActionModal.js';
import { channelsState } from './channelsClient.js';
import { buildAwayDigest, buildInboxItems, type InboxItem } from './channelsModel.js';

/**
 * while-away digest — a returning-operator summary. Unread-per-channel comes
 * from the channel list (messageCount) vs the seen pointer (buildAwayDigest);
 * "needs your reply" comes from the activity feed (the needs-reply items it
 * self-fetches). Clicking a channel selects it; a needs-reply item navigates to
 * the message. No new persistence — a view over data the hub already holds.
 */
export function DigestView({
  open,
  onClose,
  channels,
  seenCounts,
  onSelectChannel,
  onNavigate
}: {
  open: boolean;
  onClose: () => void;
  channels: { name: string; messageCount: number }[];
  seenCounts: Record<string, number>;
  onSelectChannel: (channel: string) => void;
  onNavigate: (channel: string, messageId?: string) => void;
}): JSX.Element | null {
  const [needsReply, setNeedsReply] = useState<InboxItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sounds = useActionSounds();

  const refresh = useCallback(async () => {
    try {
      const state = await channelsState();
      setNeedsReply(buildInboxItems(state.delivery, state.activity).filter((item) => item.kind === 'needs-reply'));
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
    return undefined;
  }, [open, refresh]);

  if (!open) {
    return null;
  }

  const digest = buildAwayDigest(channels, seenCounts);
  const totalUnread = digest.reduce((sum, entry) => sum + entry.unread, 0);
  const allClear = digest.length === 0 && needsReply.length === 0;

  return (
    <ActionModal open={open} title="While you were away" icon={<Newspaper size={13} />} onClose={onClose}>
      <div className="chanActionMeta">
        <span>{totalUnread} unread</span>
      </div>
      {error ? <div className="chanDigestError">{error}</div> : null}
      {allClear ? (
        <div className="chanDigestEmpty">All caught up — nothing new since your last visit.</div>
      ) : (
        <div className="chanDigestBody">
            {needsReply.length > 0 ? (
              <section className="chanDigestSection">
                <h4 className="chanDigestSectionTitle">Needs your reply</h4>
                <ul className="chanDigestList">
                  {needsReply.map((item) => (
                    <li key={item.id} className="chanDigestItem">
                      <button
                        className="chanDigestRow"
                        onMouseEnter={sounds.hover}
                        onClick={() => {
                          sounds.click(() => {
                            onClose();
                            onNavigate(item.channel ?? '', item.messageId);
                          });
                        }}
                      >
                        <span className="chanDigestRowLabel">{item.label}</span>
                        {item.detail ? (
                          <span className="chanDigestRowDetail" title={item.detail}>
                            {item.detail}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {digest.length > 0 ? (
              <section className="chanDigestSection">
                <h4 className="chanDigestSectionTitle">Unread by channel</h4>
                <ul className="chanDigestList">
                  {digest.map((entry) => (
                    <li key={entry.channel} className="chanDigestItem">
                      <button
                        className="chanDigestRow"
                        onMouseEnter={sounds.hover}
                        onClick={() => {
                          sounds.click(() => {
                            onClose();
                            onSelectChannel(entry.channel);
                          });
                        }}
                      >
                        <span className="chanDigestRowLabel">#{entry.channel}</span>
                        <span className="chanDigestUnread">{entry.unread}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
      )}
    </ActionModal>
  );
}
