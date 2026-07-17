import { Fragment, memo, useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import { Boxes, LayoutGrid, Plus, X, Zap } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { CellChrome, CLIP_OCTAGON_PILL, IconButton, TextReveal } from './arwes/primitives.js';
import type { DeskBleepName } from './arwes/bleeps.js';
import { useNarrowViewport } from './sidebarPanel.js';
import { TerminalSurface } from './TerminalSurface.js';
import { NativeAgentSurface } from './agentSurface/NativeAgentSurface.js';
import { StatusDot } from './statusDot.js';
import type { LayoutKind, PanelCell } from './muxLayout.js';
import type { DeskGroupView, DeskSessionView } from '../ui/model.js';

const LAYOUT_KIND_OPTIONS: Array<Exclude<LayoutKind, 'custom'>> = ['1x1', '2x2', '3x3', '4x4', 'linear'];

function AgentMultiplexerImpl({
  group,
  visible,
  cells,
  selectedTmux,
  attention,
  onTouchSession,
  busy,
  onAddCell,
  onRemoveCell,
  onSelectSession,
  onDragSession,
  onDropSession,
  onAssignSession,
  onBootSession,
  onChangeLayout,
  onPersistLayoutSizes,
  onTerminalSelectionMenu,
  onCreateNoteFromText,
  terminalRevisions
}: {
  group: DeskGroupView;
  visible: boolean;
  cells: PanelCell[];
  selectedTmux?: string;
  attention: Record<string, { attention: true; since: string }>;
  onTouchSession: (tmuxSession: string) => void;
  busy: boolean;
  onAddCell: (group: DeskGroupView) => void;
  onRemoveCell: (group: DeskGroupView, cell: PanelCell) => void;
  onSelectSession: (group: DeskGroupView, cell: PanelCell, session: DeskSessionView) => void;
  onDragSession: (tmuxSession: string | null) => void;
  onDropSession: (group: DeskGroupView, cell: PanelCell) => void;
  onAssignSession: (group: DeskGroupView, cell: PanelCell, session: DeskSessionView) => void;
  onBootSession: (session: DeskSessionView) => void;
  onChangeLayout: (group: DeskGroupView, kind: LayoutKind) => void;
  onPersistLayoutSizes: (group: DeskGroupView, sizes: { rows?: number[]; cols?: number[][] }) => void;
  onTerminalSelectionMenu: (text: string, x: number, y: number) => void;
  onCreateNoteFromText: (text: string) => void;
  terminalRevisions: Record<string, number>;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  // Phones stack cells vertically: side-by-side terminals at 120px min each
  // are unreadable and the column separators are undraggable by thumb.
  const narrowViewport = useNarrowViewport();
  // Linear packs every cell into one row (N columns); all other kinds use the
  // square-ish sqrt grid. Phones always stack to a single-column pager.
  const columns = narrowViewport
    ? 1
    : group.layout.kind === 'linear'
      ? group.layout.cellCount
      : Math.ceil(Math.sqrt(group.layout.cellCount));
  const rows = chunkCells(cells, columns);

  // Persisted drag-resized split sizes. defaultSize is applied only when the
  // stored shape still matches the current grid (cell count / column changes
  // invalidate old sizes, which then fall back to an even split). Sizes are
  // captured from the panel refs at the end of a drag gesture and handed up to
  // persist (debounced there).
  const storedSizes = group.layout.sizes;
  const sizesMatchShape = Boolean(
    storedSizes?.rows &&
      storedSizes.rows.length === rows.length &&
      storedSizes.cols &&
      storedSizes.cols.length === rows.length &&
      rows.every((row, index) => storedSizes.cols?.[index]?.length === row.length)
  );
  const rowPanelRefs = useRef<(PanelImperativeHandle | null)[]>([]);
  const cellPanelRefs = useRef<(PanelImperativeHandle | null)[][]>([]);
  const panelDraggingRef = useRef(false);
  const captureAndPersistSizes = useCallback((): void => {
    const toPct = (panel: PanelImperativeHandle | null): number | null =>
      panel ? Math.round(panel.getSize().asPercentage * 100) / 100 : null;
    const rowSizes = rowPanelRefs.current.map(toPct).filter((n): n is number => n !== null);
    const colSizes = cellPanelRefs.current.map((rowRefs) =>
      rowRefs.map(toPct).filter((n): n is number => n !== null)
    );
    // Only persist when there is something resizable: more than one row, or a
    // row with more than one cell. A 1x1 group has no separators.
    const hasSplits = rowSizes.length > 1 || colSizes.some((row) => row.length > 1);
    if (hasSplits) {
      onPersistLayoutSizes(group, { rows: rowSizes, cols: colSizes });
    }
  }, [group, onPersistLayoutSizes]);
  // A drag ends on pointerup anywhere; capture the final sizes once per gesture.
  useEffect(() => {
    const onPointerUp = (): void => {
      if (panelDraggingRef.current) {
        panelDraggingRef.current = false;
        captureAndPersistSizes();
      }
    };
    window.addEventListener('pointerup', onPointerUp);
    return () => window.removeEventListener('pointerup', onPointerUp);
  }, [captureAndPersistSizes]);
  const onSeparatorPointerDown = (): void => {
    panelDraggingRef.current = true;
  };
  // Mobile pager state: which slide the scroll-snap carousel rests on.
  const [pageIndex, setPageIndex] = useState(0);
  const pagerRef = useRef<HTMLDivElement | null>(null);
  // Layout badge dropdown (1x1/2x2/3x3/4x4); +/- keeps covering custom counts.
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  useEffect(() => {
    if (!layoutMenuOpen) {
      return;
    }
    const close = (): void => setLayoutMenuOpen(false);
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [layoutMenuOpen]);
  const renderCell = (cell: PanelCell): JSX.Element => (
    <TerminalCell
      group={group}
      cell={cell}
      visible={visible}
      selectedTmux={selectedTmux}
      attention={attention}
      onTouchSession={onTouchSession}
      revision={cell.activeSession ? terminalRevisions[cell.activeSession.spec.tmuxSession] ?? 0 : 0}
      onSelectSession={onSelectSession}
      onDragSession={onDragSession}
      onDropSession={onDropSession}
      onAssignSession={onAssignSession}
      onBootSession={onBootSession}
      onRemoveCell={onRemoveCell}
      onSelectionMenu={onTerminalSelectionMenu}
      onCreateNoteFromText={onCreateNoteFromText}
    />
  );
  const header = (
    <div className="subsystemHeader">
      <div className="railTitle">
        <Boxes size={13} />
        <TextReveal as="span" manager="decipher">{group.projectLabel ?? group.label}</TextReveal>
        <small>{group.label}</small>
      </div>
      <div className="railActions">
        <IconButton
          icon={<Plus size={12} />}
          label="Add layout cell"
          disabled={busy || group.layout.cellCount >= 16}
          onClick={() => onAddCell(group)}
        />
        <div className="layoutBadgeWrap">
          <button
            type="button"
            className="layoutBadge"
            style={{ clipPath: CLIP_OCTAGON_PILL }}
            title="Change layout"
            aria-haspopup="menu"
            aria-expanded={layoutMenuOpen}
            disabled={busy}
            onMouseEnter={() => bleeps.hover?.play()}
            onClick={(event) => {
              event.stopPropagation();
              bleeps.click?.play();
              setLayoutMenuOpen((open) => !open);
            }}
          >
            {group.layout.kind} / {group.layout.cellCount}
          </button>
          {layoutMenuOpen ? (
            <div className="layoutMenu treeMenu" role="menu">
              {LAYOUT_KIND_OPTIONS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  className={`treeMenuItem ${group.layout.kind === kind ? 'selected' : ''}`}
                  onMouseEnter={() => bleeps.hover?.play()}
                  onClick={() => {
                    bleeps.click?.play();
                    setLayoutMenuOpen(false);
                    if (kind !== group.layout.kind) {
                      onChangeLayout(group, kind);
                    }
                  }}
                >
                  <LayoutGrid size={11} />
                  {kind}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
  if (narrowViewport) {
    // One full-screen terminal at a time; swipe (native scroll-snap) between
    // cells. No resizable splits — a phone gets a pager, not a mosaic.
    return (
      <section className="agentSubsystem mobileMux">
        {header}
        <div
          className="mobileMuxPager"
          ref={pagerRef}
          onScroll={(event) => {
            const pager = event.currentTarget;
            const index = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
            if (index !== pageIndex) {
              setPageIndex(index);
            }
          }}
        >
          {cells.map((cell) => (
            <div className="mobileMuxSlide" key={cell.id}>
              {renderCell(cell)}
            </div>
          ))}
        </div>
        {cells.length > 1 ? (
          <div className="mobileMuxDots" role="tablist" aria-label="Terminal pager">
            {cells.map((cell, index) => {
              const session = cell.activeSession;
              const active = index === pageIndex;
              const hasAttention = Boolean(session && attention[session.spec.tmuxSession]);
              // Inactive cells keep the arwes diamond, tinted by session state
              // (attention pulses); the active one expands into a named pill —
              // 9 anonymous dots told you nothing about who was screaming.
              const stateClass = session ? (hasAttention ? 'attn' : session.state) : 'empty';
              return (
                <button
                  key={cell.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-label={`${session?.spec.name ?? 'empty cell'} — terminal ${index + 1} of ${cells.length}`}
                  className={`mobileMuxDot ${active ? `mobileMuxPill active` : ''} state-${stateClass}`}
                  onClick={() => {
                    const pager = pagerRef.current;
                    pager?.scrollTo({ left: index * pager.clientWidth, behavior: 'smooth' });
                  }}
                >
                  {active ? (
                    <>
                      {session ? (
                        <StatusDot state={session.state} attention={hasAttention} />
                      ) : null}
                      <span className="mobileMuxPillName">{session?.spec.name ?? 'empty'}</span>
                    </>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </section>
    );
  }
  // Rebuild the panel-ref slots for this render's grid; stale slots from a
  // previous (larger) grid are dropped so captureAndPersistSizes reads only
  // live panels.
  rowPanelRefs.current = [];
  cellPanelRefs.current = rows.map(() => []);
  return (
    <section className="agentSubsystem">
      {header}
      <div className="multiplexerGrid">
        <Group orientation="vertical" className="terminalPanelRows" id={`desk-layout-${group.id}-rows`}>
          {rows.map((row, rowIndex) => (
            <Fragment key={`${group.id}:row-${rowIndex}`}>
              {rowIndex > 0 ? (
                <Separator className="panelResizeHandle" onPointerDown={onSeparatorPointerDown} />
              ) : null}
              <Panel
                minSize={90}
                className="terminalPanelRow"
                defaultSize={sizesMatchShape ? `${storedSizes?.rows?.[rowIndex]}%` : undefined}
                panelRef={(handle) => {
                  rowPanelRefs.current[rowIndex] = handle;
                }}
              >
                <Group
                  orientation="horizontal"
                  className="terminalPanelCols"
                  id={`desk-layout-${group.id}-row-${rowIndex}`}
                >
                  {row.map((cell, cellIndex) => (
                    <Fragment key={cell.id}>
                      {cellIndex > 0 ? (
                        <Separator className="panelResizeHandle" onPointerDown={onSeparatorPointerDown} />
                      ) : null}
                      <Panel
                        minSize={120}
                        className="terminalPanelCell"
                        defaultSize={sizesMatchShape ? `${storedSizes?.cols?.[rowIndex]?.[cellIndex]}%` : undefined}
                        panelRef={(handle) => {
                          (cellPanelRefs.current[rowIndex] ??= [])[cellIndex] = handle;
                        }}
                      >
                        {renderCell(cell)}
                      </Panel>
                    </Fragment>
                  ))}
                </Group>
              </Panel>
            </Fragment>
          ))}
        </Group>
      </div>
    </section>
  );
}

export const AgentMultiplexer = memo(AgentMultiplexerImpl);

function TerminalCellImpl({
  group,
  cell,
  visible,
  selectedTmux,
  attention,
  onTouchSession,
  revision,
  onSelectSession,
  onDragSession,
  onDropSession,
  onAssignSession,
  onBootSession,
  onRemoveCell,
  onSelectionMenu,
  onCreateNoteFromText
}: {
  group: DeskGroupView;
  cell: PanelCell;
  visible: boolean;
  selectedTmux?: string;
  attention: Record<string, { attention: true; since: string }>;
  onTouchSession: (tmuxSession: string) => void;
  revision: number;
  onSelectSession: (group: DeskGroupView, cell: PanelCell, session: DeskSessionView) => void;
  onDragSession: (tmuxSession: string | null) => void;
  onDropSession: (group: DeskGroupView, cell: PanelCell) => void;
  onAssignSession: (group: DeskGroupView, cell: PanelCell, session: DeskSessionView) => void;
  onBootSession: (session: DeskSessionView) => void;
  onRemoveCell: (group: DeskGroupView, cell: PanelCell) => void;
  onSelectionMenu: (text: string, x: number, y: number) => void;
  onCreateNoteFromText: (text: string) => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  // Tap-to-assign picker for empty cells — DnD-only assignment is hostile to
  // touch and undiscoverable elsewhere.
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <Animator>
      <Animated
        as="section"
        className="terminalCell"
        animated={['flicker', ['scale', 0.96, 1], ['y', 10, 0]]}
        onMouseEnter={() => bleeps.hover?.play()}
        onMouseDownCapture={() => {
          const active = cell.activeSession;
          if (!active) {
            return;
          }
          onTouchSession(active.spec.tmuxSession);
          if (active.spec.tmuxSession !== selectedTmux) {
            // Clicking anywhere in the terminal selects it, like a sidebar click.
            bleeps.click?.play();
            onSelectSession(group, cell, active);
          }
        }}
        onDragOver={(event: DragEvent<HTMLElement>) => event.preventDefault()}
        onDrop={() => onDropSession(group, cell)}
      >
        <CellChrome focused={Boolean(cell.activeSession && cell.activeSession.spec.tmuxSession === selectedTmux)}>
          <div
            className="cellTabs"
            draggable={Boolean(cell.activeSession)}
            onDragStart={(event: DragEvent<HTMLDivElement>) => {
              if (!cell.activeSession) return;
              event.dataTransfer.effectAllowed = 'move';
              // Drag image = just the active tab pill (name + status), not the whole header.
              const activeTab = event.currentTarget.querySelector('.cellTab.selected') as HTMLElement | null;
              if (activeTab) {
                const rect = activeTab.getBoundingClientRect();
                event.dataTransfer.setDragImage(activeTab, event.clientX - rect.left, event.clientY - rect.top);
              }
              onDragSession(cell.activeSession.spec.tmuxSession);
            }}
            onDragEnd={() => onDragSession(null)}
          >
            {cell.sessions.map((session) => (
              <button
                key={session.spec.tmuxSession}
                className={`cellTab ${session.spec.tmuxSession === cell.activeSession?.spec.tmuxSession ? 'selected' : ''} ${
                  session.spec.tmuxSession === selectedTmux ? 'globalSelected' : ''
                }`}
                onMouseEnter={() => bleeps.hover?.play()}
                onClick={() => {
                  bleeps.click?.play();
                  onSelectSession(group, cell, session);
                }}
                title={session.spec.tmuxSession}
              >
                <StatusDot state={session.state} attention={Boolean(attention[session.spec.tmuxSession])} />
                <span>{session.spec.name}</span>
              </button>
            ))}
            <button
              className="cellRemove"
              type="button"
              aria-label="Remove layout cell"
              onClick={(event) => {
                event.stopPropagation();
                onRemoveCell(group, cell);
              }}
              disabled={group.layout.cellCount <= 1}
              title="Remove layout cell"
            >
              <X size={10} />
            </button>
          </div>
          <div className="terminalCellBody">
            {cell.activeSession ? (
              <>
                {cell.activeSession.spec.uiMode === 'native' ? (
                  <NativeAgentSurface
                    session={cell.activeSession.spec.tmuxSession}
                    revision={revision}
                    visible={visible}
                    focused={cell.activeSession.spec.tmuxSession === selectedTmux}
                    onMessageMenu={onSelectionMenu}
                    onCreateNote={onCreateNoteFromText}
                  />
                ) : (
                  <TerminalSurface
                    session={cell.activeSession}
                    revision={revision}
                    focused={cell.activeSession.spec.tmuxSession === selectedTmux}
                    onSelectionMenu={onSelectionMenu}
                  />
                )}
                {cell.activeSession.state !== 'running' ? (
                  <div className="cellMissingOverlay">
                    <span className="cellMissingTitle">SESSION MISSING</span>
                    <small className="cellMissingMeta">{cell.activeSession.spec.tmuxSession}</small>
                    <button
                      type="button"
                      className="cellMissingBoot"
                      onMouseEnter={() => bleeps.hover?.play()}
                      onClick={() => {
                        bleeps.deploy?.play();
                        onBootSession(cell.activeSession!);
                      }}
                    >
                      <Zap size={11} />
                      Boot session
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="emptyCell">
                <button
                  type="button"
                  className="emptyCellAssign"
                  onMouseEnter={() => bleeps.hover?.play()}
                  onClick={(event) => {
                    event.stopPropagation();
                    bleeps.click?.play();
                    setPickerOpen((open) => !open);
                  }}
                >
                  <TextReveal as="span" manager="sequence">Empty — tap to assign, or drop a session</TextReveal>
                </button>
                {pickerOpen ? (
                  <div className="cellSessionPicker treeMenu" role="menu">
                    {group.sessions.length === 0 ? (
                      <span className="gitEmptyNote small">No sessions in this group.</span>
                    ) : (
                      group.sessions.map((session) => (
                        <button
                          key={session.spec.tmuxSession}
                          type="button"
                          role="menuitem"
                          className="treeMenuItem"
                          onMouseEnter={() => bleeps.hover?.play()}
                          onClick={(event) => {
                            event.stopPropagation();
                            bleeps.click?.play();
                            setPickerOpen(false);
                            onAssignSession(group, cell, session);
                          }}
                        >
                          <StatusDot state={session.state} attention={Boolean(attention[session.spec.tmuxSession])} />
                          {session.spec.name}
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </CellChrome>
      </Animated>
    </Animator>
  );
}

const TerminalCell = memo(TerminalCellImpl);

function chunkCells(cells: PanelCell[], columns: number): PanelCell[][] {
  const rows: PanelCell[][] = [];
  for (let index = 0; index < cells.length; index += columns) {
    rows.push(cells.slice(index, index + columns));
  }
  return rows;
}
