import { Fragment, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  GitBranchPlus,
  GitCommitHorizontal,
  History,
  Plus,
  Undo2
} from 'lucide-react';
import { CLIP_OCTAGON_TINY, Cmd, Pill, TextReveal } from '../arwes/primitives.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import { LIST_REVEAL, LIST_ROW_DURATION } from '../arwes/motion.js';
import { fileIcon } from '../editor/fileIcons.js';
import { fileNameOf } from '../editor/editorState.js';
import type { GitCommitDetail, GitCommitFile, GitLogCommit } from './gitClient.js';
import { computeGraph, laneColorIndex, type GraphRow } from './gitGraph.js';
import { commitFileBadge, dirOf, shortTimeAgo } from './gitStatusMeta.js';
import { useClampedMenu } from '../menuPosition.js';

const LANE_W = 10;
const ROW_H = 30;
const MAX_LANES = 6;

interface CommitMenuState {
  x: number;
  y: number;
  commit: GitLogCommit;
}

export interface HistoryPanelProps {
  commits: GitLogCommit[];
  hasMore: boolean;
  loadingMore: boolean;
  collapsed: boolean;
  details: Map<string, GitCommitDetail>;
  expanded: Set<string>;
  onToggleCollapsed: () => void;
  onToggleCommit: (sha: string) => void;
  onLoadMore: () => void;
  onOpenCommitFile: (commit: GitLogCommit, file: GitCommitFile) => void;
  onCheckout: (sha: string) => void;
  onCreateBranch: (sha: string) => void;
  onRevert: (commit: GitLogCommit) => void;
  onBrowse: (sha: string) => void;
}

export function HistoryPanel({
  commits,
  hasMore,
  loadingMore,
  collapsed,
  details,
  expanded,
  onToggleCollapsed,
  onToggleCommit,
  onLoadMore,
  onOpenCommitFile,
  onCheckout,
  onCreateBranch,
  onRevert,
  onBrowse
}: HistoryPanelProps): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [menu, setMenu] = useState<CommitMenuState | null>(null);
  const menuRef = useClampedMenu(menu);
  const graph = useMemo(() => computeGraph(commits), [commits]);
  const railLanes = Math.min(MAX_LANES, Math.max(1, ...graph.map((row) => row.laneCount)));

  useEffect(() => {
    if (!menu) {
      return;
    }
    const close = (): void => setMenu(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenu(null);
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const openMenu = (event: MouseEvent, commit: GitLogCommit): void => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, commit });
  };

  const menuItem = (icon: JSX.Element, label: string, danger: boolean, action: () => void): JSX.Element => (
    <Animator key={label}>
      <Animated animated={['fade', ['x', -6, 0]]}>
        <button
          type="button"
          className={`treeMenuItem ${danger ? 'treeMenuDanger' : ''}`}
          onMouseEnter={() => bleeps.hover?.play()}
          onClick={() => {
            bleeps.click?.play();
            setMenu(null);
            action();
          }}
        >
          {icon}
          {label}
        </button>
      </Animated>
    </Animator>
  );

  return (
    <section className={`gitSection gitHistorySection ${collapsed ? 'gitSectionCollapsed' : ''}`}>
      <button
        type="button"
        className="gitSectionHeader"
        onMouseEnter={() => bleeps.hover?.play()}
        onClick={() => {
          bleeps.slide?.play();
          onToggleCollapsed();
        }}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <TextReveal as="span" manager="decipher">History</TextReveal>
        <Pill tone={commits.length > 0 ? undefined : 'muted'}>{commits.length}{hasMore ? '+' : ''}</Pill>
      </button>
      {!collapsed ? (
        <div className="gitSectionBody gitHistoryBody">
          {commits.length === 0 ? (
            <div className="gitEmptyNote">
              <TextReveal as="span" manager="sequence">No commits yet.</TextReveal>
            </div>
          ) : (
            <Animator combine manager="stagger" duration={{ stagger: LIST_REVEAL.stagger, limit: LIST_REVEAL.limit }}>
              {commits.map((commit, index) => (
                <Fragment key={commit.sha}>
                  <Animator duration={LIST_ROW_DURATION}>
                    <Animated animated={['fade', ['x', -8, 0]]}>
                      <div
                        className={`gitCommitRow ${expanded.has(commit.sha) ? 'expanded' : ''}`}
                        title={`${commit.sha.slice(0, 10)} — ${commit.author} — ${new Date(commit.date).toLocaleString()}`}
                        onContextMenu={(event) => openMenu(event, commit)}
                        onMouseEnter={() => bleeps.hover?.play()}
                        onClick={() => {
                          bleeps.click?.play();
                          onToggleCommit(commit.sha);
                        }}
                      >
                        <GraphRail row={graph[index]!} lanes={railLanes} />
                        <span className="gitCommitMain">
                          {commit.refs.length > 0 ? (
                            <span
                              className="gitCommitRefs"
                              title={commit.refs.map((ref) => ref.name).join(', ')}
                            >
                              {commit.refs.map((ref) => (
                                <i key={`${ref.kind}:${ref.name}`} className={`gitRefChip gitRef-${ref.kind}`} title={ref.name}>
                                  {ref.name}
                                </i>
                              ))}
                            </span>
                          ) : null}
                          <span className="gitCommitSubject">{commit.subject}</span>
                        </span>
                        <small className="gitCommitMeta">{commit.author.split(' ')[0]}</small>
                        <small className="gitCommitMeta gitCommitTime">{shortTimeAgo(commit.date)}</small>
                      </div>
                    </Animated>
                  </Animator>
                  {expanded.has(commit.sha) ? (
                    <CommitFiles
                      commit={commit}
                      detail={details.get(commit.sha)}
                      onOpenFile={(file) => onOpenCommitFile(commit, file)}
                    />
                  ) : null}
                </Fragment>
              ))}
            </Animator>
          )}
          {hasMore ? (
            <div className="gitLoadMore">
              <Cmd icon={<Plus size={12} />} label={loadingMore ? 'Loading…' : 'Load more'} disabled={loadingMore} onClick={onLoadMore} />
            </div>
          ) : null}
        </div>
      ) : null}
      {menu ? (
        <div ref={menuRef} className="treeContextMenu" style={{ left: menu.x, top: menu.y, clipPath: CLIP_OCTAGON_TINY }}>
          <Animator combine manager="stagger" duration={{ stagger: 0.015 }}>
            {menuItem(<History size={12} />, 'Checkout commit', false, () => onCheckout(menu.commit.sha))}
            {menuItem(<GitBranchPlus size={12} />, 'Create branch here…', false, () => onCreateBranch(menu.commit.sha))}
            {menuItem(<Undo2 size={12} />, 'Revert commit', true, () => onRevert(menu.commit))}
            {menuItem(<Copy size={12} />, 'Copy SHA', false, () => {
              void navigator.clipboard.writeText(menu.commit.sha).catch(() => undefined);
            })}
            {menuItem(<GitCommitHorizontal size={12} />, 'Copy message', false, () => {
              void navigator.clipboard.writeText(menu.commit.subject).catch(() => undefined);
            })}
            {menuItem(<ExternalLink size={12} />, 'Open on GitHub', false, () => onBrowse(menu.commit.sha))}
          </Animator>
        </div>
      ) : null}
    </section>
  );
}

function CommitFiles({
  commit,
  detail,
  onOpenFile
}: {
  commit: GitLogCommit;
  detail: GitCommitDetail | undefined;
  onOpenFile: (file: GitCommitFile) => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  if (!detail) {
    return <div className="gitCommitFiles gitEmptyNote">loading…</div>;
  }
  return (
    <div className="gitCommitFiles">
      {detail.message.includes('\n') ? <pre className="gitCommitBody">{detail.message}</pre> : null}
      <Animator combine manager="stagger" duration={{ stagger: LIST_REVEAL.stagger, limit: LIST_REVEAL.limit }}>
        {detail.files.map((file) => {
          const badge = commitFileBadge(file.status);
          const directory = dirOf(file.path);
          return (
            <Animator key={file.path} duration={LIST_ROW_DURATION}>
              <Animated animated={['fade', ['x', -8, 0]]}>
                <div className="gitChangeRow gitCommitFileRow" title={`${commit.sha.slice(0, 8)}: ${file.path}`}>
                  <button
                    type="button"
                    className="treeMain gitChangeMain"
                    onMouseEnter={() => bleeps.hover?.play()}
                    onClick={() => {
                      bleeps.click?.play();
                      onOpenFile(file);
                    }}
                  >
                    <span className="fileNodeIcon">{fileIcon(fileNameOf(file.path))}</span>
                    <span className="gitChangeName">{fileNameOf(file.path)}</span>
                    {directory ? <small className="gitChangeDir">{directory}</small> : null}
                  </button>
                  <i className={`gitStatusBadge gitTone-${badge.tone}`}>{badge.letter}</i>
                </div>
              </Animated>
            </Animator>
          );
        })}
      </Animator>
    </div>
  );
}

/** One row of the commit graph rail. */
function GraphRail({ row, lanes }: { row: GraphRow; lanes: number }): JSX.Element {
  const width = lanes * LANE_W;
  const x = (lane: number): number => Math.min(lane, lanes - 1) * LANE_W + LANE_W / 2;
  const stroke = (lane: number): string => `var(--desk-graph-${laneColorIndex(lane)})`;
  const mid = ROW_H / 2;
  return (
    <svg className="gitGraphRail" width={width} height={ROW_H} viewBox={`0 0 ${width} ${ROW_H}`} aria-hidden="true">
      {row.through.map(([from, to]) => (
        <path
          key={`t${from}-${to}`}
          d={from === to ? `M ${x(from)} 0 L ${x(to)} ${ROW_H}` : `M ${x(from)} 0 C ${x(from)} ${mid}, ${x(to)} ${mid}, ${x(to)} ${ROW_H}`}
          stroke={stroke(to)}
          fill="none"
        />
      ))}
      {row.intoNode.map((lane) => (
        <path
          key={`i${lane}`}
          d={`M ${x(lane)} 0 C ${x(lane)} ${mid * 0.7}, ${x(row.nodeLane)} ${mid * 0.7}, ${x(row.nodeLane)} ${mid}`}
          stroke={stroke(lane)}
          fill="none"
        />
      ))}
      {row.outOfNode.map((lane) => (
        <path
          key={`o${lane}`}
          d={
            lane === row.nodeLane
              ? `M ${x(lane)} ${mid} L ${x(lane)} ${ROW_H}`
              : `M ${x(row.nodeLane)} ${mid} C ${x(row.nodeLane)} ${mid * 1.3}, ${x(lane)} ${mid * 1.3}, ${x(lane)} ${ROW_H}`
          }
          stroke={stroke(lane)}
          fill="none"
        />
      ))}
      {/* the dot last so it sits above the lines */}
      <circle className="gitGraphNode" cx={x(row.nodeLane)} cy={mid} r={3} stroke={stroke(row.nodeLane)} />
      {row.intoNode.length > 0 || row.outOfNode.length > 1 ? (
        <circle cx={x(row.nodeLane)} cy={mid} r={1.4} fill={stroke(row.nodeLane)} stroke="none" />
      ) : null}
    </svg>
  );
}
