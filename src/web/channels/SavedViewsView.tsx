import { useCallback, useEffect, useState } from 'react';
import { Filter } from 'lucide-react';
import { ActionModal, useActionSounds } from './ActionModal.js';
import { channelsViews, channelsViewAdd, channelsViewRemove, type SavedView, type ViewFilter } from './channelsClient.js';

/** Human summary of a ViewFilter for the saved-views list. */
function summarize(filter: ViewFilter): string {
  const parts: string[] = [];
  if (filter.text) {
    parts.push(`"${filter.text}"`);
  }
  if (filter.author) {
    parts.push(`@${filter.author}`);
  }
  if (filter.mentionsMe) {
    parts.push('mentions me');
  }
  if (filter.hasThread) {
    parts.push('has thread');
  }
  return parts.length > 0 ? parts.join(' · ') : 'all messages';
}

/**
 * saved filtered views. Self-fetching overlay: lists saved views (apply /
 * delete) and a small form to compose + persist a new ViewFilter (text / author /
 * mentions-me / has-thread). Applying a view hands the filter back to the hub,
 * which filters the feed via the shared messageMatchesFilter. Persistence is
 * codex/glm's committed channelsViews store via the channelsView* client fns.
 */
export function SavedViewsView({
  open,
  onClose,
  onApply
}: {
  open: boolean;
  onClose: () => void;
  onApply: (filter: ViewFilter, name: string) => void;
}): JSX.Element | null {
  const [views, setViews] = useState<SavedView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [author, setAuthor] = useState('');
  const [mentionsMe, setMentionsMe] = useState(false);
  const [hasThread, setHasThread] = useState(false);
  const sounds = useActionSounds();

  const refresh = useCallback(async () => {
    try {
      const res = await channelsViews();
      setViews(res.items);
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

  const formFilter = (): ViewFilter => {
    const filter: ViewFilter = {};
    if (text.trim() !== '') {
      filter.text = text.trim();
    }
    if (author.trim() !== '') {
      filter.author = author.trim();
    }
    if (mentionsMe) {
      filter.mentionsMe = true;
    }
    if (hasThread) {
      filter.hasThread = true;
    }
    return filter;
  };

  const save = async (): Promise<void> => {
    if (name.trim() === '') {
      return;
    }
    try {
      const res = await channelsViewAdd({ name: name.trim(), filter: formFilter() });
      setViews(res.items);
      setName('');
      setText('');
      setAuthor('');
      setMentionsMe(false);
      setHasThread(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (viewName: string): Promise<void> => {
    try {
      const res = await channelsViewRemove({ name: viewName });
      setViews(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ActionModal open={open} title="Saved views" icon={<Filter size={13} />} onClose={onClose}>
      {error ? <div className="chanViewsError">{error}</div> : null}
      {views.length === 0 ? (
        <div className="chanViewsEmpty">No saved views yet — build one below.</div>
      ) : (
        <ul className="chanViewsList">
          {views.map((view) => (
            <li key={view.name} className="chanViewsItem">
              <button
                className="chanViewsApply"
                onMouseEnter={sounds.hover}
                onClick={() =>
                  sounds.click(() => {
                    onApply(view.filter, view.name);
                    onClose();
                  })
                }
              >
                  <span className="chanViewsName">{view.name}</span>
                  <span className="chanViewsSummary">{summarize(view.filter)}</span>
                </button>
                <button
                  className="chanViewsDelete"
                  onMouseEnter={sounds.hover}
                  onClick={() => sounds.click(() => void remove(view.name))}
                  aria-label={`Delete view ${view.name}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
      )}
      <div className="chanViewsForm">
        <input className="chanViewsInput" placeholder="view name" value={name} onChange={(event) => setName(event.target.value)} aria-label="View name" />
        <input className="chanViewsInput" placeholder="text" value={text} onChange={(event) => setText(event.target.value)} aria-label="Text filter" />
        <input className="chanViewsInput" placeholder="author" value={author} onChange={(event) => setAuthor(event.target.value)} aria-label="Author filter" />
        <label className="chanViewsToggle">
          <input type="checkbox" checked={mentionsMe} onChange={(event) => setMentionsMe(event.target.checked)} /> mentions me
        </label>
        <label className="chanViewsToggle">
          <input type="checkbox" checked={hasThread} onChange={(event) => setHasThread(event.target.checked)} /> has thread
        </label>
        <button className="chanViewsSave" onMouseEnter={sounds.hover} onClick={() => sounds.click(() => void save())} disabled={name.trim() === ''}>
          Save view
        </button>
      </div>
    </ActionModal>
  );
}
