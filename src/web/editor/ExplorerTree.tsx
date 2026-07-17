import { Fragment, useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { Animated, Animator, FrameUnderline, useBleeps } from '@arwes/react';
import { BookOpen, ChevronDown, ChevronRight, ClipboardCopy, ClipboardPaste, Copy, CopyPlus, ExternalLink, FilePlus, FolderPlus, GitCompareArrows, History, Link2, Minus, Pencil, Plus, Trash2, Undo2, X } from 'lucide-react';
import { CLIP_OCTAGON_TINY, Cmd, Modal } from '../arwes/primitives.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import { LIST_REVEAL, LIST_ROW_DURATION } from '../arwes/motion.js';
import { fsCopy, fsCreate, fsDelete, fsList, fsRename, fsUpload, type FsEntry, type FsWatchSocket } from './fsClient.js';
import { duplicateName, fileNameOf } from './editorState.js';
import { dirIcon, fileIcon } from './fileIcons.js';
import { useClampedMenu } from '../menuPosition.js';
import { isMarkdownFile } from './fileKinds.js';
import type { StatusBadge } from '../git/gitStatusMeta.js';
import { shortenBranch, type RepoChipInfo } from './gitTreeModel.js';

const DRAG_MIME = 'text/x-desk-path';

// Module-level so Copy in one workspace (editor) can Paste in another (notes).
let fileClipboard: { path: string; name: string } | null = null;

/** Git actions for one file row's context menu (provided by EditorSubsystem). */
export interface TreeGitMenuSpec {
  canStage: boolean;
  canUnstage: boolean;
  canDiscard: boolean;
  openDiff: () => void;
  stage: () => void;
  unstage: () => void;
  discard: () => void;
  history: () => void;
  copyGitHubUrl: () => void;
}

/** Read-side git decorations + menu factory for the tree. */
export interface TreeGitIntegration {
  badgeFor: (path: string) => StatusBadge | null;
  dirHasChanges: (path: string) => boolean;
  repoChipFor: (path: string) => RepoChipInfo | null;
  menuFor: (path: string) => TreeGitMenuSpec | null;
}

export interface ExplorerTreeActions {
  createFile: () => void;
  createDir: () => void;
  refresh: () => void;
  uploadFiles: () => void;
  /** expand ancestors, scroll the row into view, flash it; expandTarget also
      expands the target itself (used to navigate INTO a linked directory) */
  revealPath: (path: string, expandTarget?: boolean) => Promise<void>;
}

interface ContextMenuState {
  x: number;
  y: number;
  entry: FsEntry | null;
}

interface PendingEdit {
  kind: 'create-file' | 'create-dir' | 'rename';
  dirPath: string;
  targetPath?: string;
  /** for rename: whether the renamed entry is a file or folder (folders skip the LSP preview) */
  targetKind?: 'file' | 'dir';
  value: string;
}

function parentOf(path: string): string {
  const parent = path.slice(0, path.lastIndexOf('/'));
  return parent || '/';
}

function isDescendantOf(path: string, ancestor: string): boolean {
  return path.startsWith(`${ancestor}/`);
}

export function ExplorerTree({
  root,
  watcher,
  activePath,
  onOpenFile,
  onOpenRendered,
  onRenameFile,
  onCreateFile,
  onDeleteFile,
  onError,
  registerActions,
  git,
  onVisibleDirsChange
}: {
  root: string;
  watcher: FsWatchSocket;
  /** path of the file open in the active editor tab — highlighted in the tree */
  activePath: string | null;
  onOpenFile: (path: string) => void;
  /** open a markdown file directly in the rendered preview */
  onOpenRendered?: (path: string) => void;
  /**
   * LSP-aware rename/move hook. When provided, rename commits + drag-moves delegate here so the
   * editor can run the willRenameFiles preview/apply flow; falls back to a plain fsRename when absent.
   */
  onRenameFile?: (from: string, to: string, kind: 'file' | 'dir') => Promise<void>;
  /** LSP-aware create hook. When provided, create commits delegate here (preview-first); else plain fsCreate. */
  onCreateFile?: (path: string, kind: 'file' | 'dir') => Promise<void>;
  /** LSP-aware delete hook. When provided, deletes delegate here (preview-first + subtree close); else plain fsDelete. */
  onDeleteFile?: (path: string, kind: 'file' | 'dir') => Promise<void>;
  onError: (message: string) => void;
  registerActions?: (actions: ExplorerTreeActions) => void;
  /** git decorations + per-file actions (editor variant only) */
  git?: TreeGitIntegration;
  /** reports root + expanded dirs + their visible child dirs (status-map scope) */
  onVisibleDirsChange?: (dirs: string[]) => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [childrenByDir, setChildrenByDir] = useState<Map<string, FsEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FsEntry | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<{ entry: FsEntry; spec: TreeGitMenuSpec } | null>(null);
  const [revealFlash, setRevealFlash] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadDir, setUploadDir] = useState<string | null>(null);
  const menuRef = useClampedMenu(menu);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Watch events arrive outside React's render cycle; refs keep the listener
  // honest without re-subscribing on every listing change.
  const childrenByDirRef = useRef(childrenByDir);
  childrenByDirRef.current = childrenByDir;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const editCommittedRef = useRef(false);
  // The directory paths THIS tree watches (root + expanded dirs). The FsWatchSocket
  // is shared and NOT ref-counted, so unwatchAll() would also drop the per-file
  // watches openFile registered for disk-change detection — meaning toggling the
  // sidebar to Search (which unmounts this tree) silently killed conflict/reload
  // detection for every open file. Track our own paths and unwatch only those.
  const ownWatchedRef = useRef<Set<string>>(new Set());
  const watchDir = useCallback(
    (path: string): void => {
      ownWatchedRef.current.add(path);
      watcher.watch(path);
    },
    [watcher]
  );
  const unwatchOwnDirs = useCallback((): void => {
    for (const path of ownWatchedRef.current) {
      watcher.unwatch(path);
    }
    ownWatchedRef.current.clear();
  }, [watcher]);

  const loadDir = useCallback(
    async (path: string): Promise<void> => {
      try {
        const entries = await fsList(root, path);
        setChildrenByDir((current) => {
          const next = new Map(current);
          next.set(path, entries);
          return next;
        });
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    },
    [root, onError]
  );

  useEffect(() => {
    setChildrenByDir(new Map());
    setExpanded(new Set());
    setMenu(null);
    setPendingEdit(null);
    setConfirmDelete(null);
    setDropTarget(null);
    unwatchOwnDirs();
    watchDir(root);
    void loadDir(root);
    return () => {
      unwatchOwnDirs();
    };
  }, [root, watchDir, unwatchOwnDirs, loadDir]);

  useEffect(() => {
    return watcher.onEvent((event) => {
      if (childrenByDirRef.current.has(event.watched)) {
        void loadDir(event.watched);
      }
    });
  }, [watcher, loadDir]);

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

  // Update tree selection when active file changes (e.g., user clicks a different tab).
  useEffect(() => {
    if (activePath && activePath !== lastSelectedPath) {
      setSelectedPaths(new Set([activePath]));
      setLastSelectedPath(activePath);
    }
  }, [activePath]);

  const expandDir = useCallback(
    (path: string): void => {
      setExpanded((current) => new Set(current).add(path));
      watchDir(path);
      void loadDir(path);
    },
    [watchDir, loadDir]
  );

  const collapseDir = useCallback(
    (path: string): void => {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      ownWatchedRef.current.delete(path);
      watcher.unwatch(path);
    },
    [watcher]
  );

  const toggleDir = (entry: FsEntry): void => {
    if (expanded.has(entry.path)) {
      collapseDir(entry.path);
    } else {
      expandDir(entry.path);
    }
  };

  // Status-map scope: the explorer's visible dirs (root, expanded dirs, and
  // their immediate child dirs — those rows may be repo roots needing chips).
  useEffect(() => {
    if (!onVisibleDirsChange) {
      return;
    }
    const dirs = new Set<string>([root, ...expanded]);
    for (const [dir, entries] of childrenByDir) {
      if (dir !== root && !expanded.has(dir)) {
        continue;
      }
      for (const entry of entries) {
        if (entry.expandable) {
          dirs.add(entry.path);
        }
      }
    }
    onVisibleDirsChange([...dirs].sort());
  }, [expanded, childrenByDir, root, onVisibleDirsChange]);

  const startCreate = (kind: 'create-file' | 'create-dir', dirPath: string): void => {
    setMenu(null);
    editCommittedRef.current = false;
    if (dirPath !== root && !expanded.has(dirPath)) {
      expandDir(dirPath);
    }
    setPendingEdit({ kind, dirPath, value: '' });
  };

  const startRename = (entry: FsEntry): void => {
    setMenu(null);
    editCommittedRef.current = false;
    setPendingEdit({
      kind: 'rename',
      dirPath: parentOf(entry.path),
      targetPath: entry.path,
      targetKind: entry.kind === 'dir' ? 'dir' : 'file',
      value: entry.name
    });
  };

  /** Expand every ancestor of `path`, then scroll its row into view and flash it. */
  const revealPath = async (path: string, expandTarget = false): Promise<void> => {
    if (path !== root && !path.startsWith(`${root}/`)) {
      return;
    }
    const segments = path === root ? [] : path.slice(root.length + 1).split('/');
    // Normally expand the ancestor dirs and scroll to the (file) target; when the
    // target itself is a directory we expand it too, so the link opens it.
    const toExpand = expandTarget ? segments : segments.slice(0, -1);
    let dir = root;
    for (const segment of toExpand) {
      dir = `${dir}/${segment}`;
      if (!expandedRef.current.has(dir)) {
        setExpanded((current) => new Set(current).add(dir));
        watchDir(dir);
      }
      if (!childrenByDirRef.current.has(dir)) {
        // Sequential: each level's listing must exist before the next renders.
        await loadDir(dir);
      }
    }
    window.requestAnimationFrame(() => {
      document
        .querySelector(`[data-tree-path="${CSS.escape(path)}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    setRevealFlash(path);
    window.setTimeout(() => setRevealFlash((current) => (current === path ? null : current)), 1600);
  };

  // Trampoline so the header's icon buttons always reach fresh closures.
  const actionsRef = useRef<ExplorerTreeActions>({
    createFile: () => undefined,
    createDir: () => undefined,
    refresh: () => undefined,
    uploadFiles: () => undefined,
    revealPath: async () => undefined
  });
  actionsRef.current = {
    createFile: () => startCreate('create-file', root),
    createDir: () => startCreate('create-dir', root),
    refresh: () => void loadDir(root),
    uploadFiles: () => {
      setUploadDir(root);
      fileInputRef.current?.click();
    },
    revealPath
  };
  useEffect(() => {
    registerActions?.({
      createFile: () => actionsRef.current.createFile(),
      createDir: () => actionsRef.current.createDir(),
      refresh: () => actionsRef.current.refresh(),
      uploadFiles: () => actionsRef.current.uploadFiles(),
      revealPath: (path, expandTarget) => actionsRef.current.revealPath(path, expandTarget)
    });
  }, [registerActions]);

  const commitEdit = async (edit: PendingEdit): Promise<void> => {
    if (editCommittedRef.current) {
      return;
    }
    editCommittedRef.current = true;
    setPendingEdit(null);
    const name = edit.value.trim();
    if (!name || name.includes('/')) {
      if (name) {
        onError('names cannot contain "/"');
      }
      return;
    }
    try {
      if (edit.kind === 'rename' && edit.targetPath) {
        const destination = `${edit.dirPath}/${name}`;
        if (destination !== edit.targetPath) {
          if (onRenameFile) {
            // Delegate to the editor's LSP-aware flow; the watcher refreshes the tree when the
            // rename actually lands (immediately for a plain rename, or on dialog Apply).
            await onRenameFile(edit.targetPath, destination, edit.targetKind ?? 'file');
          } else {
            await fsRename(root, edit.targetPath, destination);
            await loadDir(edit.dirPath);
          }
        }
      } else {
        const target = `${edit.dirPath}/${name}`;
        const createKind = edit.kind === 'create-dir' ? 'dir' : 'file';
        if (onCreateFile) {
          // Delegate to the editor's LSP-aware create flow (preview-first); the watcher refreshes the
          // tree when the create lands (immediately for plain create, or on dialog Apply).
          await onCreateFile(target, createKind);
        } else {
          await fsCreate(root, target, createKind);
          await loadDir(edit.dirPath);
        }
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancelEdit = (): void => {
    editCommittedRef.current = true;
    setPendingEdit(null);
  };

  const performDelete = async (entry: FsEntry): Promise<void> => {
    setConfirmDelete(null);
    try {
      if (onDeleteFile) {
        // Delegate to the editor's LSP-aware delete flow (preview-first + subtree tab close); the
        // watcher refreshes the tree when the delete lands.
        await onDeleteFile(entry.path, entry.kind === 'dir' ? 'dir' : 'file');
      } else {
        await fsDelete(root, entry.path);
        const parent = parentOf(entry.path);
        await loadDir(childrenByDirRef.current.has(parent) ? parent : root);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Paste/duplicate share the retry loop: first the plain name, then -copy names. */
  const copyWithDedupe = async (sourcePath: string, sourceName: string, targetDir: string): Promise<void> => {
    for (let attempt = -1; attempt < 20; attempt += 1) {
      const candidate = `${targetDir}/${attempt === -1 ? sourceName : duplicateName(sourceName, attempt)}`;
      if (candidate === sourcePath) {
        continue; // duplicating in place: skip the original name
      }
      try {
        await fsCopy(root, sourcePath, candidate);
        await loadDir(targetDir);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/already exists/i.test(message)) {
          onError(message);
          return;
        }
      }
    }
    onError('could not allocate a name for the copy');
  };

  const copyTextToClipboard = (text: string): void => {
    void navigator.clipboard?.writeText(text).catch(() => onError('clipboard unavailable'));
  };

  const uploadFiles = async (files: FileList | File[], targetDir: string): Promise<void> => {
    const list = [...files];
    if (list.length === 0) {
      return;
    }
    setUploading(true);
    try {
      for (const file of list) {
        const buffer = await file.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const CHUNK = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
        }
        await fsUpload(root, targetDir, file.name, btoa(binary));
      }
      await loadDir(targetDir);
      setUploadDir(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  };

  const relativeToRoot = (path: string): string =>
    path === root ? '.' : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

  const performMove = async (sourcePath: string, targetDir: string): Promise<void> => {
    const sourceParent = parentOf(sourcePath);
    if (sourcePath === targetDir || sourceParent === targetDir || isDescendantOf(targetDir, sourcePath)) {
      return;
    }
    const destination = `${targetDir}/${fileNameOf(sourcePath)}`;
    try {
      if (onRenameFile) {
        const sourceKind = (childrenByDirRef.current.get(sourceParent) ?? []).find((entry) => entry.path === sourcePath)?.kind;
        await onRenameFile(sourcePath, destination, sourceKind === 'dir' ? 'dir' : 'file');
        // watcher reloads both dirs when the move lands.
      } else {
        await fsRename(root, sourcePath, destination);
        await loadDir(sourceParent);
        await loadDir(targetDir);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRowContextMenu = (event: MouseEvent, entry: FsEntry | null): void => {
    event.preventDefault();
    event.stopPropagation();
    if (entry && selectedPaths.has(entry.path)) {
      setMenu({ x: event.clientX, y: event.clientY, entry });
    } else if (entry) {
      setSelectedPaths(new Set([entry.path]));
      setLastSelectedPath(entry.path);
      setMenu({ x: event.clientX, y: event.clientY, entry });
    } else {
      setMenu({ x: event.clientX, y: event.clientY, entry: null });
    }
  };

  const onDirDragOver = (event: DragEvent, path: string): void => {
    const hasFiles = event.dataTransfer.types.includes('Files');
    const hasInternalDrag = event.dataTransfer.types.includes(DRAG_MIME);
    if (!hasFiles && !hasInternalDrag) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = hasFiles ? 'copy' : 'move';
    setDropTarget(path);
  };

  const onDirDrop = (event: DragEvent, path: string): void => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);

    // Handle file uploads
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      void uploadFiles(event.dataTransfer.files, path);
      return;
    }

    // Handle internal file moves
    const source = event.dataTransfer.getData(DRAG_MIME);
    if (source) {
      void performMove(source, path);
    }
  };

  const renderEditRow = (): JSX.Element | null => {
    if (!pendingEdit) {
      return null;
    }
    return (
      <div className="fileNode fileNodeEditing">
        <span className="treeToggle spacer" aria-hidden="true" />
        <span className="fileNodeIcon">
          {pendingEdit.kind === 'create-dir' ? dirIcon(false) : fileIcon(pendingEdit.value || 'file')}
        </span>
        <input
          className="treeInlineInput"
          autoFocus
          value={pendingEdit.value}
          onChange={(event) => setPendingEdit((current) => (current ? { ...current, value: event.target.value } : current))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void commitEdit(pendingEdit);
            } else if (event.key === 'Escape') {
              cancelEdit();
            }
          }}
          onBlur={() => void commitEdit(pendingEdit)}
        />
      </div>
    );
  };

  const renderEntry = (entry: FsEntry): JSX.Element => {
    const isDir = entry.expandable;
    const isExpanded = isDir && expanded.has(entry.path);
    const isActive = !isDir && entry.path === activePath;
    const isTreeSelected = selectedPaths.has(entry.path);
    if (pendingEdit?.kind === 'rename' && pendingEdit.targetPath === entry.path) {
      return <Fragment key={entry.path}>{renderEditRow()}</Fragment>;
    }
    const badge = !isDir ? git?.badgeFor(entry.path) ?? null : null;
    const repoChip = isDir ? git?.repoChipFor(entry.path) ?? null : null;
    const dirDot = isDir && !repoChip ? git?.dirHasChanges(entry.path) ?? false : false;
    return (
      <Fragment key={entry.path}>
        <Animator duration={LIST_ROW_DURATION}>
          <Animated animated={['fade', ['x', -10, 0]]}>
            <div
              className={[
                'fileNode',
                isActive ? 'selected' : '',
                isTreeSelected ? 'treeSelected' : '',
                entry.hidden ? 'fileNodeHidden' : '',
                dropTarget === entry.path ? 'fileNodeDrop' : '',
                revealFlash === entry.path ? 'fileNodeRevealFlash' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              data-tree-path={entry.path}
              draggable
              onContextMenu={(event) => onRowContextMenu(event, entry)}
              onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_MIME, entry.path);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={isDir ? (event) => onDirDragOver(event, entry.path) : undefined}
              onDragLeave={isDir ? () => setDropTarget((current) => (current === entry.path ? null : current)) : undefined}
              onDrop={isDir ? (event) => onDirDrop(event, entry.path) : undefined}
            >
              {isActive ? <FrameUnderline squareSize={6} strokeWidth={1} /> : null}
              {isDir ? (
                <button
                  className="treeToggle"
                  type="button"
                  aria-label={isExpanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
                  onClick={() => toggleDir(entry)}
                >
                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
              ) : (
                <span className="treeToggle spacer" aria-hidden="true" />
              )}
              <button
                className="treeMain"
                type="button"
                title={badge ? `${entry.path} — ${badge.tone}` : entry.path}
                onMouseEnter={() => bleeps.hover?.play()}
                onClick={(event: MouseEvent) => {
                  bleeps.click?.play();
                  if (isDir) {
                    toggleDir(entry);
                  } else {
                    if ((event as any).shiftKey && lastSelectedPath) {
                      const newSelection = new Set(selectedPaths);
                      newSelection.add(entry.path);
                      newSelection.add(lastSelectedPath);
                      setSelectedPaths(newSelection);
                      setLastSelectedPath(entry.path);
                    } else if ((event as any).ctrlKey || (event as any).metaKey) {
                      const newSelection = new Set(selectedPaths);
                      if (newSelection.has(entry.path)) {
                        newSelection.delete(entry.path);
                      } else {
                        newSelection.add(entry.path);
                      }
                      setSelectedPaths(newSelection);
                      setLastSelectedPath(entry.path);
                    } else {
                      setSelectedPaths(new Set([entry.path]));
                      setLastSelectedPath(entry.path);
                      onOpenFile(entry.path);
                    }
                  }
                }}
              >
                <span className={`fileNodeIcon ${isDir ? 'dir' : ''}`}>
                  {isDir ? dirIcon(isExpanded) : fileIcon(entry.name)}
                </span>
                <span className={badge ? `gitTone-${badge.tone}` : undefined}>{entry.name}</span>
                {entry.kind === 'symlink' ? <small>link</small> : null}
                {repoChip ? (
                  <small
                    className={`gitRepoChip ${repoChip.changes > 0 ? 'dirty' : ''}`}
                    title={`${repoChip.branch ?? 'detached'}${repoChip.ahead ? ` — ${repoChip.ahead} ahead` : ''}${repoChip.behind ? ` — ${repoChip.behind} behind` : ''}${repoChip.changes ? ` — ${repoChip.changes} changed` : ' — clean'}`}
                  >
                    <span className="gitRepoChipBranch">{shortenBranch(repoChip.branch ?? 'detached')}</span>
                    {repoChip.ahead > 0 || repoChip.behind > 0 || repoChip.changes > 0 ? (
                      <span className="gitRepoChipMeta">
                        {repoChip.ahead > 0 ? `↑${repoChip.ahead}` : ''}
                        {repoChip.behind > 0 ? `${repoChip.ahead > 0 ? ' ' : ''}↓${repoChip.behind}` : ''}
                        {repoChip.changes > 0 ? `${repoChip.ahead > 0 || repoChip.behind > 0 ? ' ' : ''}•${repoChip.changes}` : ''}
                      </span>
                    ) : null}
                  </small>
                ) : null}
                {dirDot ? <span className="gitDirDot" title="contains changes" aria-hidden="true" /> : null}
                {badge ? <small className={`gitBadge gitTone-${badge.tone}`}>{badge.letter}</small> : null}
              </button>
            </div>
          </Animated>
        </Animator>
        {isExpanded ? renderBranch(entry.path) : null}
      </Fragment>
    );
  };

  const renderBranch = (dirPath: string): JSX.Element => {
    const entries = childrenByDir.get(dirPath) ?? [];
    const isCreateHere = pendingEdit && pendingEdit.kind !== 'rename' && pendingEdit.dirPath === dirPath;
    return (
      <Animator combine manager="stagger" duration={{ stagger: LIST_REVEAL.stagger, limit: LIST_REVEAL.limit }}>
        <div className="fileBranch">
          {isCreateHere ? renderEditRow() : null}
          {entries.map((entry) => renderEntry(entry))}
        </div>
      </Animator>
    );
  };

  const rootEntries = childrenByDir.get(root) ?? [];
  const isCreateAtRoot = pendingEdit && pendingEdit.kind !== 'rename' && pendingEdit.dirPath === root;
  const menuDir = menu?.entry ? (menu.entry.expandable ? menu.entry.path : parentOf(menu.entry.path)) : root;

  const menuItem = (
    icon: JSX.Element,
    label: string,
    danger: boolean,
    action: () => void
  ): JSX.Element => (
    <Animator key={label}>
      <Animated animated={['fade', ['x', -6, 0]]}>
        <button
          type="button"
          className={`treeMenuItem ${danger ? 'treeMenuDanger' : ''}`}
          onMouseEnter={() => bleeps.hover?.play()}
          onClick={() => {
            bleeps.click?.play();
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
    <div
      className={`explorerTree ${dropTarget === root ? 'fileNodeDrop' : ''}`}
      onContextMenu={(event) => onRowContextMenu(event, null)}
      onDragOver={(event) => onDirDragOver(event, root)}
      onDragLeave={() => setDropTarget((current) => (current === root ? null : current))}
      onDrop={(event) => onDirDrop(event, root)}
    >
      <Animator key={root} combine manager="stagger" duration={{ stagger: LIST_REVEAL.stagger, limit: LIST_REVEAL.limit }}>
        {isCreateAtRoot ? renderEditRow() : null}
        {rootEntries.map((entry) => renderEntry(entry))}
      </Animator>
      {menu ? (
        <div ref={menuRef} className="treeContextMenu" style={{ left: menu.x, top: menu.y, clipPath: CLIP_OCTAGON_TINY }}>
          <Animator combine manager="stagger" duration={{ stagger: 0.015 }}>
            {menu.entry && !menu.entry.expandable && onOpenRendered && isMarkdownFile(menu.entry.name)
              ? menuItem(<BookOpen size={12} />, 'Open rendered', false, () => {
                  setMenu(null);
                  onOpenRendered(menu.entry!.path);
                })
              : null}
            {menuItem(<FilePlus size={12} />, 'New file', false, () => startCreate('create-file', menuDir))}
            {menuItem(<FolderPlus size={12} />, 'New directory', false, () => startCreate('create-dir', menuDir))}
            {menuItem(<Plus size={12} />, 'Upload files', false, () => {
              setMenu(null);
              setUploadDir(menuDir);
              fileInputRef.current?.click();
            })}
            {fileClipboard
              ? menuItem(<ClipboardPaste size={12} />, `Paste ${fileClipboard.name}`, false, () => {
                  setMenu(null);
                  const clip = fileClipboard!;
                  void copyWithDedupe(clip.path, clip.name, menuDir);
                })
              : null}
            {menu.entry && selectedPaths.size <= 1
              ? menuItem(<Copy size={12} />, 'Copy', false, () => {
                  fileClipboard = { path: menu.entry!.path, name: menu.entry!.name };
                  setMenu(null);
                })
              : null}
            {menu.entry
              ? menuItem(<CopyPlus size={12} />, selectedPaths.size > 1 ? `Duplicate ${selectedPaths.size} files` : 'Duplicate', false, () => {
                  setMenu(null);
                  for (const path of (selectedPaths.size > 1 ? selectedPaths : new Set([menu.entry!.path]))) {
                    void copyWithDedupe(path, fileNameOf(path), parentOf(path));
                  }
                })
              : null}
            {menu.entry && selectedPaths.size <= 1
              ? menuItem(<ClipboardCopy size={12} />, 'Copy path', false, () => {
                  copyTextToClipboard(menu.entry!.path);
                  setMenu(null);
                })
              : null}
            {menu.entry && selectedPaths.size <= 1
              ? menuItem(<Link2 size={12} />, 'Copy relative path', false, () => {
                  copyTextToClipboard(relativeToRoot(menu.entry!.path));
                  setMenu(null);
                })
              : null}
            {menu.entry && selectedPaths.size <= 1 ? menuItem(<Pencil size={12} />, 'Rename', false, () => startRename(menu.entry!)) : null}
            {menu.entry
              ? menuItem(<Trash2 size={12} />, selectedPaths.size > 1 ? `Delete ${selectedPaths.size} files` : 'Delete', true, () => {
                  setMenu(null);
                  if (selectedPaths.size > 1) {
                    const pathsToDelete = Array.from(selectedPaths);
                    // Confirm the bulk delete — single-file delete shows a danger
                    // modal, but multi-select used to delete immediately with no
                    // prompt and no undo.
                    if (!window.confirm(`Delete ${pathsToDelete.length} selected items? This cannot be undone.`)) {
                      return;
                    }
                    setConfirmDelete(null);
                    const performDeleteMultiple = async (): Promise<void> => {
                      try {
                        for (const path of pathsToDelete) {
                          if (onDeleteFile) {
                            const kindGuess = childrenByDirRef.current.has(path) ? 'dir' : 'file';
                            await onDeleteFile(path, kindGuess);
                          } else {
                            await fsDelete(root, path);
                          }
                        }
                        const parentDirs = new Set(pathsToDelete.map(p => parentOf(p)));
                        for (const parent of parentDirs) {
                          await loadDir(childrenByDirRef.current.has(parent) ? parent : root);
                        }
                        setSelectedPaths(new Set());
                        setLastSelectedPath(null);
                      } catch (err) {
                        onError(err instanceof Error ? err.message : String(err));
                      }
                    };
                    void performDeleteMultiple();
                  } else {
                    setConfirmDelete(menu.entry);
                  }
                })
              : null}
            {(() => {
              if (!menu.entry || menu.entry.expandable || !git) {
                return null;
              }
              const target = menu.entry;
              const spec = git.menuFor(target.path);
              if (!spec) {
                return null; // not inside a repo
              }
              const badge = git.badgeFor(target.path);
              return (
                <>
                  {badge
                    ? menuItem(<GitCompareArrows size={12} />, 'Open diff', false, () => {
                        setMenu(null);
                        spec.openDiff();
                      })
                    : null}
                  {spec.canStage
                    ? menuItem(<Plus size={12} />, 'Stage', false, () => {
                        setMenu(null);
                        spec.stage();
                      })
                    : null}
                  {spec.canUnstage
                    ? menuItem(<Minus size={12} />, 'Unstage', false, () => {
                        setMenu(null);
                        spec.unstage();
                      })
                    : null}
                  {spec.canDiscard
                    ? menuItem(<Undo2 size={12} />, 'Discard changes…', true, () => {
                        setMenu(null);
                        setConfirmDiscard({ entry: target, spec });
                      })
                    : null}
                  {menuItem(<History size={12} />, 'File history', false, () => {
                    setMenu(null);
                    spec.history();
                  })}
                  {menuItem(<ExternalLink size={12} />, 'Copy GitHub URL', false, () => {
                    setMenu(null);
                    spec.copyGitHubUrl();
                  })}
                </>
              );
            })()}
          </Animator>
        </div>
      ) : null}
      {confirmDiscard ? (
        <Modal
          title="Discard changes"
          icon={<Undo2 size={13} />}
          tone="danger"
          onClose={() => setConfirmDiscard(null)}
        >
          <div className="confirmBody">
            <span>
              Discard changes in <strong>{confirmDiscard.entry.name}</strong>? Uncommitted edits
              {git?.badgeFor(confirmDiscard.entry.path)?.tone === 'untracked' ? ' (and the file itself — it is untracked)' : ''} are lost
              for good.
            </span>
            <div className="confirmActions">
              <Cmd icon={<X size={12} />} label="Cancel" onClick={() => setConfirmDiscard(null)} />
              <Cmd
                icon={<Undo2 size={12} />}
                label="Discard"
                tone="danger"
                onClick={() => {
                  const pending = confirmDiscard;
                  setConfirmDiscard(null);
                  pending.spec.discard();
                }}
              />
            </div>
          </div>
        </Modal>
      ) : null}
      {confirmDelete ? (
        <Modal
          title="Delete"
          icon={<Trash2 size={13} />}
          tone="danger"
          onClose={() => setConfirmDelete(null)}
        >
          <div className="confirmBody">
            <span>
              Delete <strong>{confirmDelete.name}</strong>
              {confirmDelete.expandable ? ' and everything inside it' : ''}? This cannot be undone.
            </span>
            <div className="confirmActions">
              <Cmd icon={<X size={12} />} label="Cancel" onClick={() => setConfirmDelete(null)} />
              <Cmd icon={<Trash2 size={12} />} label="Delete" tone="danger" onClick={() => void performDelete(confirmDelete)} />
            </div>
          </div>
        </Modal>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files && uploadDir) {
            void uploadFiles(event.target.files, uploadDir);
            event.target.value = '';
          }
        }}
      />
    </div>
  );
}
