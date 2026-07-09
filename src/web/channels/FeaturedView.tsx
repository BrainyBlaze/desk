import { useCallback, useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { ActionModal, useActionSounds } from './ActionModal.js';
import { channelsFeatured, channelsFeaturedRemove, type FeaturedMessageItem } from './channelsClient.js';
import { sortFeatured } from './channelsModel.js';

/**
 * Featured / saved messages view. Lists the globally-featured messages
 * (reference-only rows the server resolves live — author/timestamp/snippet, or
 * `missing` when the source message is gone) and navigates to one via the
 * thread-aware nav path. Self-fetches like InboxView/EngineConsole; consumes
 * codex's committed channelsFeatured client fns.
 */
export function FeaturedView({
  open,
  onClose,
  onNavigate
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (channel: string, messageId: string, thread?: string) => void;
}): JSX.Element | null {
  const [items, setItems] = useState<FeaturedMessageItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sounds = useActionSounds();

  const refresh = useCallback(async () => {
    try {
      const result = await channelsFeatured();
      setItems(sortFeatured(result.items));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    void refresh();
  }, [open, refresh]);

  if (!open) {
    return null;
  }

  const activate = (item: FeaturedMessageItem): void => {
    if (item.missing) {
      return;
    }
    onClose();
    onNavigate(item.channel, item.id, item.threadParent);
  };

  const remove = async (item: FeaturedMessageItem): Promise<void> => {
    try {
      const result = await channelsFeaturedRemove({ channel: item.channel, file: item.file, id: item.id });
      setItems(sortFeatured(result.items));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ActionModal
      open={open}
      title="Featured messages"
      icon={<Star size={13} />}
      onClose={onClose}
      wide
      help="Messages you star from any channel land here.

Click a row to jump straight to the original message (or thread); the ✕ removes it from this list.

Stars are shared across the whole desk — every agent sees the same featured list."
    >
      <div className="chanActionMeta">
        <span>{items.length} saved</span>
      </div>
      {error ? <div className="chanFeaturedError">{error}</div> : null}
      {items.length === 0 ? (
        <div className="chanFeaturedEmpty">No featured messages yet — star a message to save it here.</div>
      ) : (
        <ul className="chanFeaturedList">
          {items.map((item) => (
            <li key={`${item.channel}:${item.file}:${item.id}`} className={`chanFeaturedItem ${item.missing ? 'missing' : ''}`}>
              <button
                className="chanFeaturedRow"
                onMouseEnter={sounds.hover}
                onClick={() => sounds.click(() => activate(item))}
                disabled={item.missing}
              >
                  <span className="chanFeaturedMeta">
                    <span className="chanFeaturedChannel">#{item.channel}</span>
                    {item.author ? <span className="chanFeaturedAuthor">@{item.author}</span> : null}
                    {item.timestamp ? <span className="chanFeaturedTime">{item.timestamp}</span> : null}
                    {item.threadParent ? <span className="chanFeaturedThread">thread</span> : null}
                  </span>
                  <span className="chanFeaturedSnippet">
                    {item.missing ? 'source message is gone' : item.snippet ?? '(no preview)'}
                  </span>
                  {item.note ? <span className="chanFeaturedNote">{item.note}</span> : null}
                </button>
                <button
                  className="chanFeaturedRemove"
                  onMouseEnter={sounds.hover}
                  onClick={() => sounds.click(() => void remove(item))}
                  aria-label="Remove from featured"
                  title="Remove from featured"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
      )}
    </ActionModal>
  );
}
