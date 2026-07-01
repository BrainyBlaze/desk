import { useCallback, useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { ActionModal, useActionSounds } from './ActionModal.js';
import { channelsSearch, type ChannelSearchResult } from './channelsClient.js';
import { toSearchOptions } from './channelsModel.js';

/**
 * cross-channel search. Searches root.md + thread-*.md across every channel
 * via codex's server-side /api/channels/search (channelsSearch), with filters
 * (channel / author / mentions-me / has-thread). Debounced on input; a result
 * navigates to its source via the thread-aware nav. The form -> options mapping
 * is the unit-tested toSearchOptions helper. Self-fetches like the other panels.
 */
export function SearchView({
  open,
  channels,
  onClose,
  onNavigate
}: {
  open: boolean;
  channels: string[];
  onClose: () => void;
  onNavigate: (channel: string, messageId: string, thread?: string) => void;
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [channel, setChannel] = useState('');
  const [author, setAuthor] = useState('');
  const [mentionsMe, setMentionsMe] = useState(false);
  const [hasThread, setHasThread] = useState(false);
  const [results, setResults] = useState<ChannelSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sounds = useActionSounds();

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const run = useCallback(async () => {
    if (query.trim() === '') {
      setResults([]);
      setError(null);
      return;
    }
    setSearching(true);
    try {
      const res = await channelsSearch(toSearchOptions({ query, channel, author, mentionsMe, hasThread }));
      setResults(res.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }, [query, channel, author, mentionsMe, hasThread]);

  // Debounce: re-search 300ms after the latest input/filter change.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const id = window.setTimeout(() => void run(), 300);
    return () => window.clearTimeout(id);
  }, [open, run]);

  if (!open) {
    return null;
  }

  const activate = (result: ChannelSearchResult): void => {
    onClose();
    onNavigate(result.channel, result.messageId, result.threadParent);
  };

  return (
    <ActionModal open={open} title="Search all channels" icon={<Search size={13} />} onClose={onClose} wide>
      <div className="chanSearchControls">
        <input
          ref={inputRef}
          className="chanSearchInput"
          placeholder="Search all channels..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              onClose();
            }
          }}
          aria-label="Search query"
        />
        <div className="chanSearchFilters">
          <select className="chanSearchSelect" value={channel} onChange={(event) => setChannel(event.target.value)} aria-label="Channel filter">
            <option value="">all channels</option>
            {channels.map((name) => (
              <option key={name} value={name}>
                #{name}
              </option>
            ))}
          </select>
          <input
            className="chanSearchAuthor"
            placeholder="author"
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
            aria-label="Author filter"
          />
          <label className="chanSearchToggle">
            <input type="checkbox" checked={mentionsMe} onChange={(event) => setMentionsMe(event.target.checked)} /> mentions me
          </label>
          <label className="chanSearchToggle">
            <input type="checkbox" checked={hasThread} onChange={(event) => setHasThread(event.target.checked)} /> has thread
          </label>
        </div>
      </div>
      {error ? <div className="chanSearchError">{error}</div> : null}
      <ul className="chanSearchList">
        {results.map((result) => (
          <li key={`${result.channel}:${result.file}:${result.messageId}`} className="chanSearchItem">
            <button className="chanSearchRow" onMouseEnter={sounds.hover} onClick={() => sounds.click(() => activate(result))}>
                <span className="chanSearchMeta">
                  <span className="chanSearchChannel">#{result.channel}</span>
                  <span className="chanSearchAuthorName">@{result.author}</span>
                  <span className="chanSearchTime">{result.timestamp}</span>
                  {result.threadParent ? <span className="chanSearchThread">thread</span> : null}
                </span>
                <span className="chanSearchSnippet">{result.snippet}</span>
              </button>
            </li>
          ))}
        {!searching && query.trim() !== '' && results.length === 0 ? <li className="chanSearchEmpty">No matches</li> : null}
      </ul>
    </ActionModal>
  );
}
