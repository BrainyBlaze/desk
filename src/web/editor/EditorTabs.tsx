import { useEffect, useState, type DragEvent, type MouseEvent } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import { BookOpen, CopyX, FileCode, X, XCircle } from 'lucide-react';
import { CLIP_OCTAGON_PILL, CLIP_OCTAGON_TINY } from '../arwes/primitives.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import { fileNameOf, tabDropTargetIndex, tabLabels } from './editorState.js';
import { fileIcon } from './fileIcons.js';
import { useClampedMenu } from '../menuPosition.js';

export interface TabMeta {
  dirty: boolean;
  conflict: boolean;
  deleted: boolean;
  /** markdown files can toggle between source and rendered preview */
  markdown: boolean;
  rendered: boolean;
}

export interface TabMenuExtra {
  icon: JSX.Element;
  label: string;
  action: () => void;
}

export interface EditorTabsProps {
  tabs: string[];
  active: string | null;
  meta: Map<string, TabMeta>;
  /** custom display labels (git diff tabs); defaults to basename labels */
  labels?: Map<string, string>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onCloseOthers: (path: string) => void;
  onCloseAll: () => void;
  onToggleRender: (path: string) => void;
  onMove: (from: number, to: number) => void;
  /** extra context-menu entries (copy path, reveal in tree, git actions) */
  extraMenuItems?: (path: string) => TabMenuExtra[];
}

interface TabMenuState {
  x: number;
  y: number;
  path: string;
}

export function EditorTabs({
  tabs,
  active,
  meta,
  labels: labelsProp,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onToggleRender,
  onMove,
  extraMenuItems
}: EditorTabsProps): JSX.Element | null {
  const bleeps = useBleeps<DeskBleepName>();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropPosition, setDropPosition] = useState<number | null>(null);
  const [menu, setMenu] = useState<TabMenuState | null>(null);
  const menuRef = useClampedMenu(menu);
  const labels = labelsProp ?? tabLabels(tabs);

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

  const openMenu = (event: MouseEvent, path: string): void => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, path });
  };

  const menuItem = (icon: JSX.Element, label: string, action: () => void): JSX.Element => (
    <Animator key={label}>
      <Animated animated={['fade', ['x', -6, 0]]}>
        <button
          type="button"
          className="treeMenuItem"
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

  const menuMeta = menu ? meta.get(menu.path) : undefined;

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="editorTabs" role="tablist">
      {tabs.map((path, index) => {
        const tabMeta = meta.get(path);
        const isActive = path === active;
        return (
          <Animator key={path}>
            <Animated animated={['fade', ['y', 6, 0]]}>
              <div
                role="tab"
                aria-selected={isActive}
                title={path}
                className={[
                  'editorTab',
                  isActive ? 'editorTabActive' : '',
                  tabMeta?.conflict ? 'editorTabConflict' : '',
                  tabMeta?.deleted ? 'editorTabDeleted' : '',
                  dropPosition === index ? 'editorTabDropBefore' : '',
                  dropPosition === index + 1 ? 'editorTabDropAfter' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ clipPath: CLIP_OCTAGON_PILL }}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event: DragEvent) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  if (dragIndex === null) return;
                  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                  const midpoint = rect.left + rect.width / 2;
                  setDropPosition(event.clientX < midpoint ? index : index + 1);
                }}
                onDragLeave={() => setDropPosition(null)}
                onDrop={(event: DragEvent) => {
                  event.preventDefault();
                  if (dragIndex !== null) {
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    const midpoint = rect.left + rect.width / 2;
                    const targetIndex = tabDropTargetIndex(dragIndex, index, event.clientX >= midpoint, tabs.length);
                    if (targetIndex !== dragIndex) {
                      onMove(dragIndex, targetIndex);
                    }
                  }
                  setDragIndex(null);
                  setDropPosition(null);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDropPosition(null);
                }}
                onMouseEnter={() => bleeps.hover?.play()}
                onClick={() => {
                  if (!isActive) {
                    bleeps.click?.play();
                  }
                  onSelect(path);
                }}
                onContextMenu={(event) => openMenu(event, path)}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    bleeps.close?.play();
                    onClose(path);
                  }
                }}
              >
                <span className="editorTabBar" aria-hidden="true" />
                <span className="editorTabIcon">
                  {tabMeta?.markdown && tabMeta.rendered ? <BookOpen size={12} /> : fileIcon(fileNameOf(path), 12)}
                </span>
                <span className={`editorTabDot ${tabMeta?.dirty ? 'editorTabDotDirty' : ''}`} />
                <span className="editorTabLabel">{labels.get(path)}</span>
                <button
                  className="editorTabClose"
                  type="button"
                  aria-label={`close ${labels.get(path)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    bleeps.close?.play();
                    onClose(path);
                  }}
                >
                  <X size={10} />
                </button>
              </div>
            </Animated>
          </Animator>
        );
      })}
      {menu ? (
        <div ref={menuRef} className="treeContextMenu" style={{ left: menu.x, top: menu.y, clipPath: CLIP_OCTAGON_TINY }}>
          <Animator combine manager="stagger" duration={{ stagger: 0.015 }}>
            {menuMeta?.markdown
              ? menuItem(
                  menuMeta.rendered ? <FileCode size={12} /> : <BookOpen size={12} />,
                  menuMeta.rendered ? 'Edit source' : 'Render preview',
                  () => onToggleRender(menu.path)
                )
              : null}
            {menuItem(<X size={12} />, 'Close', () => onClose(menu.path))}
            {menuItem(<CopyX size={12} />, 'Close others', () => onCloseOthers(menu.path))}
            {menuItem(<XCircle size={12} />, 'Close all', () => onCloseAll())}
            {(extraMenuItems?.(menu.path) ?? []).map((extra) => menuItem(extra.icon, extra.label, extra.action))}
          </Animator>
        </div>
      ) : null}
    </div>
  );
}
