import { useEffect, useRef, useState } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import { Search } from 'lucide-react';
import { TextReveal } from '../arwes/primitives.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import {
  fsSearchContent,
  fsSearchFiles,
  type FsSearchContentMatch,
  type FsSearchFileMatch
} from './fsClient.js';
import { fileNameOf } from './editorState.js';
import { fileIcon } from './fileIcons.js';

const joinRoot = (root: string, rel: string): string => (root.endsWith('/') ? `${root}${rel}` : `${root}/${rel}`);

export interface SearchPanelProps {
  root: string;
  onOpenFile: (path: string, reveal?: { line: number; column: number }) => void;
  onError: (message: string) => void;
}

export function SearchPanel({ root, onOpenFile, onError }: SearchPanelProps): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [query, setQuery] = useState('');
  const [fileMatches, setFileMatches] = useState<FsSearchFileMatch[]>([]);
  const [contentMatches, setContentMatches] = useState<FsSearchContentMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const requestIdRef = useRef(0);
  // Re-keys the result animators so fresh results replay their reveal.
  const [resultsKey, setResultsKey] = useState(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === '') {
      requestIdRef.current += 1; // invalidate any in-flight search
      setFileMatches([]);
      setContentMatches([]);
      setTruncated(false);
      setSearching(false);
      return;
    }
    const requestId = (requestIdRef.current += 1);
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const [files, content] = await Promise.all([fsSearchFiles(root, trimmed), fsSearchContent(root, trimmed)]);
          if (requestIdRef.current !== requestId) {
            return; // a newer query superseded this one
          }
          setFileMatches(files.matches.slice(0, 50));
          setContentMatches(content.matches);
          setTruncated(files.truncated || content.truncated);
          setResultsKey((value) => value + 1);
        } catch (error) {
          if (requestIdRef.current === requestId) {
            onError(error instanceof Error ? error.message : String(error));
          }
        } finally {
          if (requestIdRef.current === requestId) {
            setSearching(false);
          }
        }
      })();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, root, onError]);

  const byFile = new Map<string, FsSearchContentMatch[]>();
  for (const match of contentMatches) {
    const list = byFile.get(match.path) ?? [];
    list.push(match);
    byFile.set(match.path, list);
  }

  const openHit = (path: string, reveal?: { line: number; column: number }): void => {
    bleeps.click?.play();
    onOpenFile(path, reveal);
  };

  return (
    <div className="searchPanel">
      <div className="searchInputRow">
        <Search size={12} />
        <input
          autoFocus
          className="treeInlineInput"
          value={query}
          placeholder="filename, path, or content…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {searching ? <div className="searchStatus">searching…</div> : null}
      {truncated ? <div className="searchStatus">results truncated — refine the query</div> : null}

      {fileMatches.length > 0 ? (
        <Animator key={`files-${resultsKey}`} combine manager="stagger" duration={{ stagger: 0.015, limit: 10 }}>
          <div className="searchGroup">
            <TextReveal as="div" manager="decipher">FILES</TextReveal>
            {fileMatches.map((match) => (
              <Animator key={match.path}>
                <Animated
                  as="button"
                  animated={['fade', ['x', -8, 0]]}
                  type="button"
                  className="searchHit"
                  title={match.path}
                  onMouseEnter={() => bleeps.hover?.play()}
                  onClick={() => openHit(joinRoot(root, match.path))}
                >
                  <span className="fileNodeIcon">{fileIcon(fileNameOf(match.path), 11)}</span>
                  <span className="searchHitPath">{match.path}</span>
                </Animated>
              </Animator>
            ))}
          </div>
        </Animator>
      ) : null}

      {byFile.size > 0 ? (
        <Animator key={`content-${resultsKey}`} combine manager="stagger" duration={{ stagger: 0.015, limit: 10 }}>
          <div className="searchGroup">
            <TextReveal as="div" manager="decipher">CONTENT</TextReveal>
            {[...byFile.entries()].map(([path, matches]) => (
              <Animator key={path}>
                <Animated className="searchFileGroup" animated={['fade', ['x', -8, 0]]}>
                  <div className="searchHitFile" title={path}>
                    <span className="fileNodeIcon">{fileIcon(fileNameOf(path), 11)}</span>
                    <span className="searchHitPath">{path}</span>
                  </div>
                  {matches.map((match, index) => (
                    <button
                      key={`${match.line}:${match.column}:${index}`}
                      type="button"
                      className="searchHit searchHitLine"
                      onClick={() => openHit(joinRoot(root, match.path), { line: match.line, column: match.column })}
                    >
                      <span className="searchLineNo">{match.line}</span>
                      <span className="searchHitText">{match.text.trim()}</span>
                    </button>
                  ))}
                </Animated>
              </Animator>
            ))}
          </div>
        </Animator>
      ) : null}

      {query.trim() !== '' && !searching && fileMatches.length === 0 && byFile.size === 0 ? (
        <div className="searchStatus">no matches</div>
      ) : null}
    </div>
  );
}
