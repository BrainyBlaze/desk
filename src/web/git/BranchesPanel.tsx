import { useState } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderTree,
  GitBranch,
  GitBranchPlus,
  GitCompareArrows,
  Globe,
  Trash2
} from 'lucide-react';
import { IconButton, Pill, TextReveal } from '../arwes/primitives.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import { LIST_ROW_DURATION } from '../arwes/motion.js';
import { fileIcon } from '../editor/fileIcons.js';
import { fileNameOf } from '../editor/editorState.js';
import { commitFileBadge, dirOf, shortTimeAgo } from './gitStatusMeta.js';
import type { GitBranchRef, GitCommitFile, GitWorktree } from './gitClient.js';

/** One branch's compare-without-checkout state (vs merge-base with HEAD). */
export interface BranchCompare {
  ref: string;
  baseSha: string;
  refSha: string;
  files: GitCommitFile[];
  loading: boolean;
}

/**
 * Branches & worktrees explorer — third section of the git sidebar. Local
 * branches with ahead/behind and checkout/delete actions, remote branches
 * (checkout creates a tracking branch via git's DWIM), and every worktree of
 * the repository (click switches the git subsystem to that worktree).
 */
export function BranchesPanel({
  branches,
  worktrees,
  repoPath,
  busy,
  collapsed,
  onToggleCollapsed,
  onCheckout,
  onCreateBranch,
  onDeleteBranch,
  onOpenWorktree,
  onRemoveWorktree,
  onCopy,
  compare,
  onToggleCompare,
  onOpenCompareFile
}: {
  branches: GitBranchRef[];
  worktrees: GitWorktree[];
  /** currently selected repo path (highlights its worktree row) */
  repoPath: string | null;
  busy: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onCheckout: (ref: string) => void;
  onCreateBranch: (fromSha: string) => void;
  onDeleteBranch: (branch: GitBranchRef) => void;
  onOpenWorktree: (tree: GitWorktree) => void;
  onRemoveWorktree: (tree: GitWorktree) => void;
  onCopy: (text: string) => void;
  /** expanded branch-compare (one at a time); files vs merge-base with HEAD */
  compare?: BranchCompare | null;
  onToggleCompare?: (ref: string) => void;
  onOpenCompareFile?: (file: GitCommitFile) => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [remotesOpen, setRemotesOpen] = useState(false);
  const local = branches.filter((branch) => !branch.remote);
  const remote = branches.filter((branch) => branch.remote);

  const compareFiles = (open: BranchCompare): JSX.Element => (
    <div className="gitCommitFiles gitCompareFiles">
      <div className="gitCompareHead">
        <GitCompareArrows size={10} />
        <span>
          {open.loading
            ? 'comparing…'
            : open.files.length === 0
              ? 'no changes vs current branch'
              : `${open.files.length} file${open.files.length === 1 ? '' : 's'} vs merge-base ${open.baseSha.slice(0, 7)}`}
        </span>
      </div>
      {open.files.map((file) => {
        const badge = commitFileBadge(file.status);
        const directory = dirOf(file.path);
        return (
          <Animator key={file.path} duration={LIST_ROW_DURATION}>
            <Animated animated={['fade', ['x', -8, 0]]}>
              <div className="gitChangeRow gitCommitFileRow" title={`${open.ref}: ${file.path}`}>
                <button
                  type="button"
                  className="treeMain gitChangeMain"
                  onMouseEnter={() => bleeps.hover?.play()}
                  onClick={() => {
                    bleeps.click?.play();
                    onOpenCompareFile?.(file);
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
    </div>
  );

  const branchRow = (branch: GitBranchRef): JSX.Element => {
    const comparing = compare?.ref === branch.name;
    return (
    <div key={`${branch.remote ? 'r:' : 'l:'}${branch.name}`}>
      <div
        className={`gitBranchRow ${branch.current ? 'current' : ''} ${comparing ? 'comparing' : ''}`}
        title={`${branch.subject}\n${branch.sha} · ${shortTimeAgo(branch.date)}${branch.upstream ? `\ntracks ${branch.upstream}` : ''}`}
      >
        {branch.current ? <Check size={11} className="gitBranchCurrentMark" /> : branch.remote ? <Globe size={11} /> : <GitBranch size={11} />}
        <span className="gitBranchRowName">{branch.name}</span>
        {branch.ahead > 0 ? <Pill tone="ok">↑{branch.ahead}</Pill> : null}
        {branch.behind > 0 ? <Pill tone="warn">↓{branch.behind}</Pill> : null}
        <small className="gitBranchAge">{shortTimeAgo(branch.date)}</small>
        <span className="gitRowActions">
          {!branch.current && onToggleCompare ? (
            <IconButton
              icon={<GitCompareArrows size={11} />}
              label={comparing ? 'Hide changes' : `View ${branch.name}'s changes without checkout`}
              onClick={() => onToggleCompare(branch.name)}
            />
          ) : null}
          {!branch.current ? (
            <IconButton
              icon={<Check size={11} />}
              label={branch.remote ? `Checkout tracking branch from ${branch.name}` : `Checkout ${branch.name}`}
              disabled={busy}
              onClick={() => onCheckout(branch.remote ? branch.name.split('/').slice(1).join('/') : branch.name)}
            />
          ) : null}
          <IconButton icon={<GitBranchPlus size={11} />} label={`New branch from ${branch.name}`} disabled={busy} onClick={() => onCreateBranch(branch.sha)} />
          <IconButton icon={<Copy size={11} />} label="Copy branch name" onClick={() => onCopy(branch.name)} />
          {!branch.remote && !branch.current ? (
            <IconButton icon={<Trash2 size={11} />} label={`Delete ${branch.name}`} disabled={busy} onClick={() => onDeleteBranch(branch)} />
          ) : null}
        </span>
      </div>
      {comparing && compare ? compareFiles(compare) : null}
    </div>
    );
  };

  return (
    <section className={`gitSection gitBranchesSection ${collapsed ? 'gitSectionCollapsed' : ''}`}>
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
        <TextReveal as="span" manager="decipher">Branches</TextReveal>
        <Pill tone={local.length > 0 ? undefined : 'muted'}>{local.length}</Pill>
        {worktrees.length > 1 ? <Pill tone="muted" title="worktrees">{worktrees.length} trees</Pill> : null}
      </button>
      {!collapsed ? (
        <div className="gitSectionBody gitBranchesBody">
          <div className="gitBranchGroup">
            {local.map(branchRow)}
            {local.length === 0 ? <div className="gitEmptyNote small">No local branches.</div> : null}
          </div>

          {remote.length > 0 ? (
            <>
              <button
                type="button"
                className="gitBranchSubHeader"
                onMouseEnter={() => bleeps.hover?.play()}
                onClick={() => {
                  bleeps.click?.play();
                  setRemotesOpen((open) => !open);
                }}
              >
                {remotesOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                <span>Remotes</span>
                <Pill tone="muted">{remote.length}</Pill>
              </button>
              {remotesOpen ? <div className="gitBranchGroup">{remote.map(branchRow)}</div> : null}
            </>
          ) : null}

          {worktrees.length > 0 ? (
            <>
              <div className="gitBranchSubHeader static">
                <FolderTree size={11} />
                <span>Worktrees</span>
                <Pill tone="muted">{worktrees.length}</Pill>
              </div>
              <div className="gitBranchGroup">
                {worktrees.map((tree) => {
                  const name = tree.path.split('/').filter(Boolean).pop() ?? tree.path;
                  const active = repoPath !== null && tree.path === repoPath;
                  return (
                    <div
                      key={tree.path}
                      className={`gitBranchRow gitWorktreeRow ${active ? 'current' : ''}`}
                      title={`${tree.path}\n${tree.branch ?? `detached @ ${tree.sha}`}`}
                      onDoubleClick={() => onOpenWorktree(tree)}
                    >
                      <FolderTree size={11} />
                      <span className="gitBranchRowName">{name}</span>
                      {tree.branch ? <small className="gitWorktreeBranch">{tree.branch}</small> : <Pill tone="warn">detached</Pill>}
                      {tree.main ? <Pill tone="muted">main</Pill> : null}
                      {tree.locked ? <Pill tone="warn">locked</Pill> : null}
                      {tree.prunable ? <Pill tone="warn">prunable</Pill> : null}
                      <span className="gitRowActions">
                        {!active ? (
                          <IconButton icon={<Check size={11} />} label="Open this worktree as the active repo" onClick={() => onOpenWorktree(tree)} />
                        ) : null}
                        <IconButton icon={<Copy size={11} />} label="Copy worktree path" onClick={() => onCopy(tree.path)} />
                        {!tree.main ? (
                          <IconButton icon={<Trash2 size={11} />} label="Remove worktree" disabled={busy} onClick={() => onRemoveWorktree(tree)} />
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
