import { useEffect, useState, type MouseEvent } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import {
  ChevronDown,
  ChevronRight,
  FileCode,
  GitCommitHorizontal,
  ListTree,
  Minus,
  Plus,
  RotateCcw,
  Trash2,
  X,
  Copy,
  GitCompareArrows
} from 'lucide-react';
import { CLIP_OCTAGON_TINY, Cmd, IconButton, Modal, Pill, TextReveal } from '../arwes/primitives.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import { LIST_REVEAL, LIST_ROW_DURATION } from '../arwes/motion.js';
import { fileIcon } from '../editor/fileIcons.js';
import { fileNameOf } from '../editor/editorState.js';
import type { GitStatus, GitStatusEntry } from './gitClient.js';
import { dirOf, groupChanges, statusBadge } from './gitStatusMeta.js';
import { useClampedMenu } from '../menuPosition.js';

export type ChangeGroup = 'staged' | 'changes' | 'merge';

interface RowMenuState {
  x: number;
  y: number;
  entry: GitStatusEntry;
  group: ChangeGroup;
}

export interface ChangesPanelProps {
  status: GitStatus | null;
  busy: boolean;
  message: string;
  amend: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onMessageChange: (value: string) => void;
  onAmendChange: (value: boolean) => void;
  onCommit: () => void;
  onOpenDiff: (entry: GitStatusEntry, group: ChangeGroup) => void;
  onOpenFile: (path: string) => void;
  /** open the file in the editor AND expand/flash it in the explorer tree */
  onRevealInExplorer?: (path: string) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (entries: GitStatusEntry[]) => void;
}

export function ChangesPanel({
  status,
  busy,
  message,
  amend,
  collapsed,
  onToggleCollapsed,
  onMessageChange,
  onAmendChange,
  onCommit,
  onOpenDiff,
  onOpenFile,
  onRevealInExplorer,
  onStage,
  onUnstage,
  onDiscard
}: ChangesPanelProps): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<GitStatusEntry[] | null>(null);
  const menuRef = useClampedMenu(menu);

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

  const groups = groupChanges(status?.entries ?? []);
  const total = groups.merge.length + groups.staged.length + groups.changes.length;

  const openMenu = (event: MouseEvent, entry: GitStatusEntry, group: ChangeGroup): void => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, entry, group });
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

  const renderRow = (entry: GitStatusEntry, group: ChangeGroup): JSX.Element => {
    const badge = statusBadge(entry, group);
    const directory = dirOf(entry.path);
    return (
      <Animator key={`${group}:${entry.path}`} duration={LIST_ROW_DURATION}>
        <Animated animated={['fade', ['x', -10, 0]]}>
          <div
            className="gitChangeRow"
            title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}
            onContextMenu={(event) => openMenu(event, entry, group)}
          >
            <button
              type="button"
              className="treeMain gitChangeMain"
              onMouseEnter={() => bleeps.hover?.play()}
              onClick={() => {
                bleeps.click?.play();
                onOpenDiff(entry, group);
              }}
            >
              <span className="fileNodeIcon">{fileIcon(fileNameOf(entry.path))}</span>
              <span className="gitChangeName">{fileNameOf(entry.path)}</span>
              {directory ? <small className="gitChangeDir">{directory}</small> : null}
            </button>
            <span className="gitRowActions">
              {group !== 'staged' ? (
                <>
                  <IconButton
                    icon={<RotateCcw size={11} />}
                    label="Discard changes"
                    onClick={() => setConfirmDiscard([entry])}
                  />
                  <IconButton icon={<Plus size={11} />} label="Stage changes" onClick={() => onStage([entry.path])} />
                </>
              ) : (
                <IconButton
                  icon={<Minus size={11} />}
                  label="Unstage changes"
                  onClick={() => onUnstage([entry.path])}
                />
              )}
            </span>
            <i className={`gitStatusBadge gitTone-${badge.tone}`}>{badge.letter}</i>
          </div>
        </Animated>
      </Animator>
    );
  };

  const renderGroup = (
    label: string,
    group: ChangeGroup,
    entries: GitStatusEntry[],
    actions: JSX.Element
  ): JSX.Element | null => {
    if (entries.length === 0) {
      return null;
    }
    return (
      <div className="gitChangeGroup">
        <div className="gitGroupHeader">
          <TextReveal as="span" manager="decipher" className="gitGroupLabel">{label}</TextReveal>
          <Pill>{entries.length}</Pill>
          <span className="gitRowActions">{actions}</span>
        </div>
        <Animator combine manager="stagger" duration={{ stagger: LIST_REVEAL.stagger, limit: LIST_REVEAL.limit }}>
          {entries.map((entry) => renderRow(entry, group))}
        </Animator>
      </div>
    );
  };

  return (
    <section className={`gitSection gitChangesSection ${collapsed ? 'gitSectionCollapsed' : ''}`}>
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
        <TextReveal as="span" manager="decipher">Changes</TextReveal>
        <Pill tone={total > 0 ? undefined : 'muted'}>{total}</Pill>
      </button>
      {!collapsed ? (
        <div className="gitSectionBody">
          <div className="gitCommitBox">
            <textarea
              className="gitCommitInput"
              placeholder={amend ? 'New message (empty keeps the old one)' : `Message (Ctrl+Enter to commit)`}
              value={message}
              rows={2}
              onChange={(event) => onMessageChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  onCommit();
                }
              }}
            />
            <div className="gitCommitActions">
              <label className="gitAmendToggle" title="Replace the previous commit">
                <input type="checkbox" checked={amend} onChange={(event) => onAmendChange(event.target.checked)} />
                <span>amend</span>
              </label>
              <Cmd
                icon={<GitCommitHorizontal size={12} />}
                label="Commit"
                disabled={busy || (message.trim() === '' && !amend)}
                onClick={onCommit}
              />
            </div>
          </div>
          {total === 0 ? (
            <div className="gitEmptyNote">
              <TextReveal as="span" manager="sequence">Working tree clean.</TextReveal>
            </div>
          ) : (
            <div className="gitChangeLists">
              {renderGroup(
                'Merge Changes',
                'merge',
                groups.merge,
                <IconButton
                  icon={<Plus size={11} />}
                  label="Stage all merge changes"
                  onClick={() => onStage(groups.merge.map((entry) => entry.path))}
                />
              )}
              {renderGroup(
                'Staged Changes',
                'staged',
                groups.staged,
                <IconButton
                  icon={<Minus size={11} />}
                  label="Unstage all"
                  onClick={() => onUnstage(groups.staged.map((entry) => entry.path))}
                />
              )}
              {renderGroup(
                'Changes',
                'changes',
                groups.changes,
                <>
                  <IconButton
                    icon={<RotateCcw size={11} />}
                    label="Discard all changes"
                    onClick={() => setConfirmDiscard(groups.changes)}
                  />
                  <IconButton
                    icon={<Plus size={11} />}
                    label="Stage all changes"
                    onClick={() => onStage(groups.changes.map((entry) => entry.path))}
                  />
                </>
              )}
            </div>
          )}
        </div>
      ) : null}
      {menu ? (
        <div ref={menuRef} className="treeContextMenu" style={{ left: menu.x, top: menu.y, clipPath: CLIP_OCTAGON_TINY }}>
          <Animator combine manager="stagger" duration={{ stagger: 0.015 }}>
            {menuItem(<GitCompareArrows size={12} />, 'Open diff', false, () => onOpenDiff(menu.entry, menu.group))}
            {menuItem(<FileCode size={12} />, 'Open file', false, () => onOpenFile(menu.entry.path))}
            {onRevealInExplorer
              ? menuItem(<ListTree size={12} />, 'Reveal in explorer', false, () => onRevealInExplorer(menu.entry.path))
              : null}
            {menu.group === 'staged'
              ? menuItem(<Minus size={12} />, 'Unstage changes', false, () => onUnstage([menu.entry.path]))
              : menuItem(<Plus size={12} />, 'Stage changes', false, () => onStage([menu.entry.path]))}
            {menu.group !== 'staged'
              ? menuItem(<RotateCcw size={12} />, 'Discard changes', true, () => setConfirmDiscard([menu.entry]))
              : null}
            {menuItem(<Copy size={12} />, 'Copy path', false, () => {
              void navigator.clipboard.writeText(menu.entry.path).catch(() => undefined);
            })}
          </Animator>
        </div>
      ) : null}
      {confirmDiscard ? (
        <Modal title="Discard changes" icon={<Trash2 size={13} />} tone="danger" onClose={() => setConfirmDiscard(null)}>
          <div className="confirmBody">
            <span>
              Discard {confirmDiscard.length === 1 ? (
                <strong>{confirmDiscard[0]!.path}</strong>
              ) : (
                <strong>{confirmDiscard.length} files</strong>
              )}
              ? Untracked files are deleted. This cannot be undone.
            </span>
            <div className="confirmActions">
              <Cmd icon={<X size={12} />} label="Cancel" onClick={() => setConfirmDiscard(null)} />
              <Cmd
                icon={<Trash2 size={12} />}
                label="Discard"
                tone="danger"
                onClick={() => {
                  const entries = confirmDiscard;
                  setConfirmDiscard(null);
                  onDiscard(entries);
                }}
              />
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
