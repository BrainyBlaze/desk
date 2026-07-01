import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { terminalBroker } from './terminalBrokerClient.js';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { DeskSessionView } from './types.js';
import { MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS } from '../core/terminalSizing.js';
import { captureTerminal, repaintTerminal } from './api.js';
import {
  applicationScrollProfileForAgent,
  chooseScrollStrategy,
  encodeApplicationScrollInput
} from './terminalScroll.js';
import { useDeskTheme } from './arwes/primitives.js';

interface TerminalSurfaceProps {
  session?: DeskSessionView;
  revision?: number;
  /** this cell holds the global selection — drives cursor blink (one blink timer, not N) */
  focused?: boolean;
  /**
   * Right-click over SELECTED text opens the caller's menu (copy/create note)
   * instead of the legacy instant-copy. Right-click without a selection keeps
   * pasting, exactly as before.
   */
  onSelectionMenu?: (text: string, x: number, y: number) => void;
}

/** Fetched lazily on scrollback entry; matches the server's single-capture cap. */
const SCROLLBACK_FETCH_ROWS = 2000;

/** Per-cell broker identity. Stable for one mounted surface, distinct across
 * cells showing the same session, so the broker can target snapshots/visibility
 * per cell while sharing one session output stream. */
let surfaceCounter = 0;
function nextSurfaceId(): string {
  surfaceCounter += 1;
  return `surface-${surfaceCounter}`;
}

/**
 * Live WebGL contexts across ALL terminal surfaces. Browsers evict the
 * oldest context past their cap (~16), firing loss on a VISIBLE terminal —
 * the dead-white canvas and the silent mixed-renderer downgrade both came
 * from unbounded contexts during group churn. Hidden keep-alive surfaces
 * release their context; visible ones (re)acquire on reveal/focus/tab-return,
 * so the live count stays at most the number of on-screen cells, capped here.
 */
const WEBGL_BUDGET = 8;
let webglActiveCount = 0;

/**
 * On reveal, a freshly-shown group's cells each create a WebGL context +
 * compile shaders synchronously — measured as the dominant cost of an otherwise
 * "warm" (0-socket, 0-tmux) group switch (hundreds of ms to seconds under
 * software GL). We keep the switch off the GL critical path: paint immediately
 * with xterm's DOM renderer, then upgrade visible cells to WebGL shortly after
 * the switch settles. A small random spread avoids all visible cells compiling
 * shaders in the same frame. An explicit click still upgrades that cell at once.
 */
const WEBGL_UPGRADE_DELAY_MS = 200;
const WEBGL_UPGRADE_SPREAD_MS = 150;

/**
 * Shared WebGL-context budget across every surface — live cells AND the
 * scrollback viewer. Centralizing the counter here (rather than each terminal
 * mutating webglActiveCount inline) is what lets the viewer's context count
 * against the same 8-slot budget instead of bypassing it.
 */
function acquireWebglSlot(): boolean {
  if (webglActiveCount >= WEBGL_BUDGET) {
    return false;
  }
  webglActiveCount += 1;
  return true;
}
function releaseWebglSlot(): void {
  webglActiveCount = Math.max(0, webglActiveCount - 1);
}

export function TerminalSurface({ session, revision = 0, focused = false, onSelectionMenu }: TerminalSurfaceProps): JSX.Element {
  const builtTheme = useDeskTheme();
  const builtThemeRef = useRef(builtTheme);
  builtThemeRef.current = builtTheme;
  const [scrollbackLines, setScrollbackLines] = useState<string[] | null>(null);
  // Bridge gave up reconnecting — surfaced as a Reconnect button instead of
  // a line of yellow text telling the user to re-select the session.
  const [bridgeDown, setBridgeDown] = useState(false);
  const reconnectRef = useRef<() => void>(() => undefined);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<DeskSessionView | undefined>(session);
  const selectionMenuRef = useRef(onSelectionMenu);
  selectionMenuRef.current = onSelectionMenu;
  const terminalRef = useRef<Terminal | null>(null);
  const scrollRailRef = useRef<HTMLDivElement | null>(null);
  const scrollThumbRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Terminal | null>(null);
  const scrollbackActiveRef = useRef(false);
  const capturePendingRef = useRef(false);
  const entryLinesRef = useRef(0);
  const exitScrollbackRef = useRef<() => void>(() => undefined);
  const captureRequestRef = useRef(0);
  const notifyResizeRef = useRef<(cols: number, rows: number) => void>(() => undefined);
  const resizeTimerRef = useRef<number | undefined>(undefined);
  const lastResizeRef = useRef<string>('');
  // Stable broker surface id for this cell instance.
  const surfaceIdRef = useRef<string>('');
  if (surfaceIdRef.current === '') {
    surfaceIdRef.current = nextSurfaceId();
  }
  // Current visibility (host has non-zero size) and the bridge that pushes
  // visibility transitions to the broker — set by the session effect, called by
  // the mount effect's fit/visibility logic, so the two effects stay decoupled.
  const cellVisibleRef = useRef(false);
  const brokerVisibilityRef = useRef<(visible: boolean) => void>(() => undefined);

  const resetScrollbackContent = (): void => {
    setScrollbackLines(null);
  };

  useEffect(() => {
    sessionRef.current = session;
  }, [session, revision]);

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: false,
      convertEol: true,
      allowProposedApi: true,
      altClickMovesCursor: true,
      fontFamily: 'JetBrains Mono, IBM Plex Mono, ui-monospace, monospace',
      fontSize: 13,
      macOptionClickForcesSelection: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      scrollback: 20000,
      scrollOnUserInput: true,
      scrollSensitivity: 1.35,
      smoothScrollDuration: 0,
      theme: { ...builtThemeRef.current.terminal }
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const serializeAddon = new SerializeAddon();
    const unicode11Addon = new Unicode11Addon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(serializeAddon);
    terminal.loadAddon(unicode11Addon);
    terminal.loadAddon(webLinksAddon);
    terminal.unicode.activeVersion = '11';

    // Budgeted WebGL with event-driven recovery: acquire when visible and
    // under budget, release when hidden (keep-alive mounts) or on context
    // loss. Retry points are reveal (ResizeObserver fires), pointer-down and
    // tab return — no give-up-after-N-timers.
    let webglAddon: WebglAddon | undefined;
    let webglWanted = supportsWebgl2();
    let webglUpgradeTimer: number | undefined;
    const releaseWebgl = (): void => {
      // Cancel a pending deferred upgrade too: a cell hidden during the upgrade
      // delay must not compile a GL context it no longer needs (and would have
      // to release immediately anyway).
      window.clearTimeout(webglUpgradeTimer);
      webglUpgradeTimer = undefined;
      if (!webglAddon) {
        return;
      }
      const addon = webglAddon;
      webglAddon = undefined;
      releaseWebglSlot();
      try {
        addon.dispose();
      } catch {
        // already torn down with its context
      }
    };
    const acquireWebgl = (): void => {
      if (!webglWanted || webglAddon) {
        return;
      }
      if (!acquireWebglSlot()) {
        return; // budget full — stay on the DOM renderer until a slot frees
      }
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          if (webglAddon === addon) {
            webglAddon = undefined;
            releaseWebglSlot();
          }
          addon.dispose();
        });
        terminal.loadAddon(addon);
        webglAddon = addon;
      } catch {
        // WebGL unavailable on this machine — DOM renderer permanently.
        releaseWebglSlot();
        webglWanted = false;
      }
    };
    // Deferred, DOM-first upgrade: schedule WebGL acquisition off the
    // switch-critical path and re-check visibility when it fires (a cell hidden
    // again in the meantime stays on the DOM renderer). Idempotent: an existing
    // pending timer or a live context short-circuits.
    const scheduleAcquireWebgl = (): void => {
      if (!webglWanted || webglAddon || webglUpgradeTimer !== undefined) {
        return;
      }
      webglUpgradeTimer = window.setTimeout(() => {
        webglUpgradeTimer = undefined;
        const hostNode = hostRef.current;
        if (!hostNode || hostNode.clientWidth === 0 || hostNode.clientHeight === 0) {
          return; // hidden again before the upgrade fired
        }
        acquireWebgl();
      }, WEBGL_UPGRADE_DELAY_MS + Math.random() * WEBGL_UPGRADE_SPREAD_MS);
    };

    terminal.open(hostRef.current);
    scheduleAcquireWebgl();
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    searchRef.current = searchAddon;
    serializeRef.current = serializeAddon;
    const updateScrollRail = (): void => {
      const rail = scrollRailRef.current;
      const thumb = scrollThumbRef.current;
      if (!rail || !thumb) {
        return;
      }
      if (scrollbackActiveRef.current) {
        // Scrollback overlay owns scrolling (native scrollbar); custom rail is hidden via CSS.
        return;
      }
      const buffer = terminal.buffer.active;
      const scrollableRows = Math.max(0, buffer.baseY);
      const hasRunningSession = sessionRef.current?.state === 'running';
      const totalRows = Math.max(terminal.rows, buffer.baseY + terminal.rows);
      const trackHeight = rail.clientHeight;
      if (trackHeight <= 0) {
        return;
      }
      const thumbHeight =
        scrollableRows === 0 ? trackHeight : Math.max(28, Math.floor((terminal.rows / totalRows) * trackHeight));
      const thumbTop =
        scrollableRows === 0
          ? 0
          : Math.min(trackHeight - thumbHeight, Math.floor((buffer.viewportY / scrollableRows) * (trackHeight - thumbHeight)));

      rail.dataset.scrollable = scrollableRows > 0 || hasRunningSession ? 'true' : 'false';
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${thumbTop}px)`;
    };
    const fitAndReport = (): void => {
      const hostNode = hostRef.current;
      if (!hostNode || hostNode.clientWidth === 0 || hostNode.clientHeight === 0) {
        // Hidden keep-alive mount: a fit here would shrink the terminal to
        // nothing and resize tmux with it. Yield the WebGL context to the
        // visible cells; the ResizeObserver fires again on reveal. Tell the
        // broker we are hidden so it stops streaming live output to this cell.
        if (cellVisibleRef.current) {
          cellVisibleRef.current = false;
          brokerVisibilityRef.current(false);
        }
        releaseWebgl();
        return;
      }
      const wasHidden = !cellVisibleRef.current;
      cellVisibleRef.current = true;
      scheduleAcquireWebgl();
      fitAddon.fit();
      notifyResizeRef.current(terminal.cols, terminal.rows);
      updateScrollRail();
      if (wasHidden) {
        // Reveal: the broker replies with a self-contained snapshot, then resumes
        // live output. No client-side reconnect or tmux repaint needed.
        brokerVisibilityRef.current(true);
      }
    };
    fitAndReport();
    const handleVisibilityReturn = (): void => {
      if (!document.hidden) {
        fitAndReport();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityReturn);

    const setInputActive = (active: boolean): void => {
      if (shellRef.current) {
        shellRef.current.dataset.terminalInputActive = active ? 'true' : 'false';
      }
    };

    const exitScrollback = (): void => {
      if (!scrollbackActiveRef.current) {
        return;
      }
      scrollbackActiveRef.current = false;
      captureRequestRef.current += 1;
      resetScrollbackContent();
      if (shellRef.current) {
        shellRef.current.dataset.terminalScrollback = 'false';
      }
      updateScrollRail();
    };
    exitScrollbackRef.current = exitScrollback;

    const enterScrollback = (entryLines: number): void => {
      const activeSession = sessionRef.current;
      if (activeSession?.state !== 'running' || scrollbackActiveRef.current || capturePendingRef.current) {
        return;
      }
      resetScrollbackContent();
      capturePendingRef.current = true;
      const requestId = captureRequestRef.current + 1;
      captureRequestRef.current = requestId;
      void captureTerminal({
        session: activeSession.spec.tmuxSession,
        rows: SCROLLBACK_FETCH_ROWS,
        offset: 0
      })
        .then((snapshot) => {
          if (captureRequestRef.current !== requestId || snapshot.lines.length === 0) {
            return;
          }
          // Freeze the buffer: scrolling is native from here, immune to live output growth.
          entryLinesRef.current = Math.max(1, entryLines);
          scrollbackActiveRef.current = true;
          setScrollbackLines(snapshot.lines);
          setInputActive(false);
          if (shellRef.current) {
            shellRef.current.dataset.terminalScrollback = 'true';
          }
        })
        .catch(() => undefined)
        .finally(() => {
          capturePendingRef.current = false;
        });
    };

    const resetLiveScroll = (): void => {
      exitScrollback();
    };

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') {
        return true;
      }

      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'f') {
        event.preventDefault();
        const query = window.prompt('Find in terminal');
        if (query) {
          if (event.shiftKey) {
            searchAddon.findPrevious(query);
          } else {
            searchAddon.findNext(query);
          }
        }
        return false;
      }

      if ((event.ctrlKey || event.metaKey) && key === 'c') {
        const selection = getSelectedText(terminal);
        if (selection) {
          event.preventDefault();
          copyText(selection);
          return false;
        }
      }

      if ((event.ctrlKey || event.metaKey) && key === 'v') {
        event.preventDefault();
        void navigator.clipboard?.readText().then((text) => {
          if (text) {
            setInputActive(true);
            resetLiveScroll();
            terminal.paste(text);
          }
        }).catch(() => undefined);
        return false;
      }

      if (event.ctrlKey && event.altKey && key === 'c') {
        void navigator.clipboard?.writeText(serializeAddon.serialize());
        return false;
      }

      setInputActive(true);
      resetLiveScroll();
      return true;
    });

    const resizeObserver = new ResizeObserver(fitAndReport);
    resizeObserver.observe(hostRef.current);
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      notifyResizeRef.current(cols, rows);
      updateScrollRail();
    });
    const scrollDisposable = terminal.onScroll(updateScrollRail);
    // The rail's "scrollable" geometry changes only when output grows the buffer
    // (baseY) — which onScroll/onResize miss. The old fix was a 500ms poll on
    // every mounted cell (15 cells = 30 wakeups/s for rail math nobody sees on
    // idle/hidden cells). Drive it off writes instead, coalesced to one update
    // per frame; rAF is naturally paused while the tab is hidden, and
    // updateScrollRail bails early on a 0-height (display:none) rail.
    let railRaf = 0;
    const scheduleRailUpdate = (): void => {
      if (railRaf) {
        return;
      }
      railRaf = window.requestAnimationFrame(() => {
        railRaf = 0;
        updateScrollRail();
      });
    };
    const writeDisposable = terminal.onWriteParsed(scheduleRailUpdate);

    const host = hostRef.current;
    const shell = shellRef.current;
    const rail = scrollRailRef.current;
    let railDragLastY: number | undefined;
    let railDragGripY: number | undefined;
    const handleHostMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) {
        return;
      }
      // A click is the strongest "this cell matters now" signal — reclaim a
      // WebGL slot if an eviction or budget pressure took ours.
      acquireWebgl();
      if (isInputRowClick(event)) {
        setInputActive(true);
        resetLiveScroll();
        terminal.focus();
        return;
      }
      setInputActive(false);
    };
    const requestScroll = (lines: number): void => {
      const activeSession = sessionRef.current;
      const normalizedLines = Math.trunc(lines);
      if (!normalizedLines) {
        return;
      }
      const strategy = chooseScrollStrategy({
        activeBufferType: terminal.buffer.active.type,
        running: activeSession?.state === 'running',
        localScrollbackRows: Math.max(0, terminal.buffer.active.baseY),
        localViewportY: Math.max(0, terminal.buffer.active.viewportY),
        requestedLines: normalizedLines
      });
      if (strategy === 'application') {
        const input = encodeApplicationScrollInput(
          normalizedLines,
          applicationScrollProfileForAgent(activeSession?.spec.agent)
        );
        if (input) {
          terminalBroker.sendInput(surfaceIdRef.current, input);
        }
        return;
      }
      if (strategy === 'local') {
        terminal.scrollLines(normalizedLines);
        updateScrollRail();
        return;
      }
      if (normalizedLines < 0) {
        enterScrollback(-normalizedLines);
      }
    };
    const handleWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) {
        return;
      }
      if (scrollbackActiveRef.current) {
        // The xterm viewer scrolls itself (smooth, color-faithful, selection-preserving).
        // Only intercept a further wheel-down at the very bottom: return to live view.
        const viewer = viewerRef.current;
        if (viewer && event.deltaY > 0) {
          const buffer = viewer.buffer.active;
          if (buffer.viewportY >= buffer.baseY) {
            event.preventDefault();
            event.stopPropagation();
            exitScrollback();
          }
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const direction = Math.sign(event.deltaY);
      const magnitude = Math.max(1, Math.min(12, Math.ceil(Math.abs(event.deltaY) / 28)));
      requestScroll(direction * magnitude);
    };
    const handleRailPointerDown = (event: PointerEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const activeSession = sessionRef.current;
      if (activeSession?.state === 'running' && terminal.buffer.active.baseY <= 0) {
        // Live tmux view has no local scrollback: any rail interaction enters frozen scrollback,
        // where the overlay's native scrollbar takes over.
        enterScrollback(terminal.rows * 3);
        return;
      }
      const thumb = scrollThumbRef.current;
      const railBounds = scrollRailRef.current?.getBoundingClientRect();
      const thumbBounds = thumb?.getBoundingClientRect();
      if (!railBounds || !thumbBounds) {
        return;
      }
      rail?.setPointerCapture(event.pointerId);
      if (event.clientY >= thumbBounds.top && event.clientY <= thumbBounds.bottom) {
        railDragLastY = event.clientY;
        railDragGripY = event.clientY - thumbBounds.top;
        return;
      }
      requestScroll(event.clientY < thumbBounds.top ? -terminal.rows * 3 : terminal.rows * 3);
    };
    const handleRailPointerMove = (event: PointerEvent): void => {
      if (railDragLastY === undefined) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const delta = event.clientY - railDragLastY;
      if (Math.abs(delta) < 8) {
        return;
      }
      requestScroll(Math.sign(delta) * Math.max(1, Math.min(terminal.rows, Math.floor(Math.abs(delta) / 4))));
      railDragLastY = event.clientY;
    };
    const handleRailPointerEnd = (event: PointerEvent): void => {
      if (railDragLastY !== undefined) {
        event.preventDefault();
        event.stopPropagation();
      }
      railDragLastY = undefined;
      railDragGripY = undefined;
    };
    const handlePaste = (event: ClipboardEvent): void => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain');
      if (!text) {
        return;
      }
      setInputActive(true);
      resetLiveScroll();
      terminal.paste(text);
    };
    const handleCopy = (event: ClipboardEvent): void => {
      const selection = getSelectedText(terminal);
      if (!selection) {
        return;
      }
      event.preventDefault();
      event.clipboardData?.setData('text/plain', selection);
    };
    const handleContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      const selection = getSelectedText(terminal);
      if (selection) {
        const openMenu = selectionMenuRef.current;
        if (openMenu) {
          openMenu(selection, event.clientX, event.clientY);
        } else {
          copyText(selection);
        }
        return;
      }
      void navigator.clipboard?.readText().then((text) => {
        if (text) {
          setInputActive(true);
          resetLiveScroll();
          terminal.paste(text);
        }
      }).catch(() => undefined);
    };

    const isInputRowClick = (event: MouseEvent): boolean => {
      if (scrollbackActiveRef.current) {
        return false;
      }
      const cursor = host.querySelector<HTMLElement>('.xterm-cursor, .xterm-cursor-block, .xterm-cursor-bar, .xterm-cursor-underline');
      const textarea = host.querySelector<HTMLElement>('.xterm-helper-textarea');
      const target = cursor ?? textarea;
      if (!target) {
        return false;
      }
      const bounds = target.getBoundingClientRect();
      const rowSlack = Math.max(8, bounds.height * 0.6);
      const leftSlack = 240;
      const rightSlack = 80;
      return (
        event.clientY >= bounds.top - rowSlack &&
        event.clientY <= bounds.bottom + rowSlack &&
        event.clientX >= bounds.left - leftSlack &&
        event.clientX <= bounds.right + rightSlack
      );
    };

    // Touch scrolling: the wheel pipeline never fires on touch. Vertical
    // drags convert into the same scroll path (live view -> frozen snapshot,
    // overlay scrolls its own xterm). Taps stay taps, and horizontal drags
    // are released to the mobile pager's swipe.
    let touchLastY: number | undefined;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchAxis: 'pending' | 'vertical' | 'released' = 'released';
    const handleTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) {
        touchAxis = 'released';
        return;
      }
      touchStartX = event.touches[0].clientX;
      touchStartY = event.touches[0].clientY;
      touchLastY = touchStartY;
      touchAxis = 'pending';
    };
    const handleTouchMove = (event: TouchEvent): void => {
      if (touchLastY === undefined || touchAxis === 'released' || event.touches.length !== 1) {
        return;
      }
      const x = event.touches[0].clientX;
      const y = event.touches[0].clientY;
      if (touchAxis === 'pending') {
        const movedX = Math.abs(x - touchStartX);
        const movedY = Math.abs(y - touchStartY);
        if (movedX < 8 && movedY < 8) {
          return; // still a tap
        }
        touchAxis = movedY >= movedX ? 'vertical' : 'released';
        if (touchAxis === 'released') {
          return;
        }
      }
      event.preventDefault(); // the gesture is ours: no page scroll/rubber-band
      const rowHeight = Math.max(8, host.clientHeight / Math.max(1, terminal.rows));
      const deltaLines = Math.trunc((touchLastY - y) / rowHeight);
      if (deltaLines === 0) {
        return;
      }
      touchLastY -= deltaLines * rowHeight;
      if (scrollbackActiveRef.current) {
        const viewer = viewerRef.current;
        if (!viewer) {
          return;
        }
        const buffer = viewer.buffer.active;
        if (deltaLines > 0 && buffer.viewportY >= buffer.baseY) {
          exitScrollback(); // dragged past the bottom: back to live
        } else {
          viewer.scrollLines(deltaLines);
        }
        return;
      }
      requestScroll(deltaLines);
    };
    const handleTouchEnd = (): void => {
      touchLastY = undefined;
      touchAxis = 'released';
    };

    shell?.addEventListener('mousedown', handleHostMouseDown);
    shell?.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    shell?.addEventListener('touchstart', handleTouchStart, { passive: true });
    shell?.addEventListener('touchmove', handleTouchMove, { passive: false });
    shell?.addEventListener('touchend', handleTouchEnd);
    shell?.addEventListener('touchcancel', handleTouchEnd);
    host.addEventListener('paste', handlePaste);
    host.addEventListener('copy', handleCopy);
    host.addEventListener('contextmenu', handleContextMenu);
    rail?.addEventListener('pointerdown', handleRailPointerDown);
    rail?.addEventListener('pointermove', handleRailPointerMove);
    rail?.addEventListener('pointerup', handleRailPointerEnd);
    rail?.addEventListener('pointercancel', handleRailPointerEnd);

    return () => {
      resizeObserver.disconnect();
      resizeDisposable.dispose();
      scrollDisposable.dispose();
      writeDisposable.dispose();
      if (railRaf) {
        window.cancelAnimationFrame(railRaf);
      }
      document.removeEventListener('visibilitychange', handleVisibilityReturn);
      releaseWebgl();
      shell?.removeEventListener('mousedown', handleHostMouseDown);
      shell?.removeEventListener('wheel', handleWheel, { capture: true });
      shell?.removeEventListener('touchstart', handleTouchStart);
      shell?.removeEventListener('touchmove', handleTouchMove);
      shell?.removeEventListener('touchend', handleTouchEnd);
      shell?.removeEventListener('touchcancel', handleTouchEnd);
      host.removeEventListener('paste', handlePaste);
      host.removeEventListener('copy', handleCopy);
      host.removeEventListener('contextmenu', handleContextMenu);
      rail?.removeEventListener('pointerdown', handleRailPointerDown);
      rail?.removeEventListener('pointermove', handleRailPointerMove);
      rail?.removeEventListener('pointerup', handleRailPointerEnd);
      rail?.removeEventListener('pointercancel', handleRailPointerEnd);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      serializeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const resizeTmuxWindow = (cols: number, rows: number): void => {
      if (!session || session.state !== 'running') {
        return;
      }
      // Never drive tmux below a usable size: a fit() against a collapsing or
      // mid-transition host can momentarily report tiny dimensions, and the
      // server pins whatever it receives as manual window-size. Dropping these
      // keeps the last good size instead of corrupting the window to 12x6.
      if (cols < MIN_TERMINAL_COLS || rows < MIN_TERMINAL_ROWS) {
        return;
      }
      const key = `${session.spec.tmuxSession}:${cols}:${rows}`;
      if (lastResizeRef.current === key) {
        return;
      }
      lastResizeRef.current = key;
      window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        // Resize travels as a broker frame through the server's min-size-guarded
        // resize path. Only a visible surface may resize.
        terminalBroker.sendResize(surfaceIdRef.current, cols, rows);
      }, 80);
    };

    notifyResizeRef.current = resizeTmuxWindow;
    // Hidden keep-alive mounts skip the fit/resize: fit() against a 0-size
    // host would collapse the terminal, and tmux must not follow a cell the
    // user cannot see. The reveal refit covers it.
    if (hostRef.current && hostRef.current.clientWidth > 0) {
      fitRef.current?.fit();
      resizeTmuxWindow(terminal.cols, terminal.rows);
    }
    scrollbackActiveRef.current = false;
    captureRequestRef.current += 1;
    resetScrollbackContent();
    setBridgeDown(false);
    if (shellRef.current) {
      shellRef.current.dataset.terminalInputActive = 'false';
      shellRef.current.dataset.terminalScrollback = 'false';
    }

    if (!session) {
      terminal.clear();
      terminal.writeln('\x1b[36mDESK CONTROL CHANNEL\x1b[0m');
      terminal.writeln('');
      terminal.writeln('Select a session from the left rail.');
      return;
    }

    if (session.state !== 'running') {
      terminal.clear();
      terminal.writeln(`\x1b[36m${session.spec.name}\x1b[0m  \x1b[33mMISSING\x1b[0m`);
      terminal.writeln(`cwd      ${session.spec.cwd}`);
      terminal.writeln(`tmux     ${session.spec.tmuxSession}`);
      terminal.writeln('');
      terminal.writeln('Boot it from this cell, or Up in the header starts all missing sessions.');
      return;
    }

    terminal.clear();
    terminal.writeln(`\x1b[36mDESK LIVE ATTACH\x1b[0m ${session.spec.tmuxSession}`);
    terminal.writeln(`cwd ${session.spec.cwd}`);
    terminal.writeln('');

    const tmuxTarget = session.spec.tmuxSession;
    const surfaceId = surfaceIdRef.current;
    let disposed = false;
    let stabilizeTimer: number | undefined;

    // A freshly attached tmux window can be painted for stale dimensions (a
    // redraw that raced the resize). Stabilize repairs that ONCE, after the
    // layout settles — but only when the settled size actually differs from
    // what attach already established. Previously it unconditionally posted a
    // direct resize + repaint on every cold mount (the 2nd resize + the repaint
    // measured as 18 resizes / 9 repaints for a 9-cell cold switch); with the
    // bridge attaching via ignore-size the window is already correct, so the
    // common path is now a no-op. The min-size guard keeps a transient tiny fit
    // from pinning the window. The repaint still chains after the resize so it
    // paints at the corrected size.
    const stabilize = (): void => {
      window.clearTimeout(stabilizeTimer);
      stabilizeTimer = window.setTimeout(() => {
        if (disposed) {
          return;
        }
        fitRef.current?.fit();
        const { cols, rows } = terminal;
        if (rows < 3) {
          return;
        }
        const key = `${tmuxTarget}:${cols}:${rows}`;
        if (lastResizeRef.current === key) {
          return; // already the right size — no redundant resize/repaint
        }
        if (cols < MIN_TERMINAL_COLS || rows < MIN_TERMINAL_ROWS) {
          return; // never pin a degenerate size
        }
        lastResizeRef.current = key;
        terminalBroker.sendResize(surfaceId, cols, rows);
        void repaintTerminal({ session: tmuxTarget }).catch(() => undefined);
      }, 450);
    };

    // Subscribe this surface to the shared broker connection (one WebSocket per
    // browser tab). The broker streams live `output` for the session only while
    // at least one surface is visible; a hidden surface receives nothing, so a
    // warm-but-hidden keep-alive cell costs no parse/render. On reveal the broker
    // sends a self-contained snapshot, which we apply after a reset.
    terminalBroker.subscribe(surfaceId, tmuxTarget, cellVisibleRef.current, {
      onOutput: (data) => {
        terminal.write(data);
      },
      onSnapshot: (data) => {
        terminal.reset();
        terminal.options.theme = { ...builtThemeRef.current.terminal };
        terminal.write(data);
        // The snapshot is the current screen; repair tmux size once if the
        // settled cell size differs from what the window currently has.
        stabilize();
      },
      onExit: () => {
        terminal.writeln('\r\n\x1b[33m[session exited]\x1b[0m');
      },
      onError: (message) => {
        terminal.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
      },
      onConnectionChange: (up) => {
        if (disposed) {
          return;
        }
        // The connection is shared across all cells; one drop flips every cell
        // to the Reconnect affordance, one recovery clears them (the broker
        // resubscribes visible surfaces, which re-snapshots their screens).
        setBridgeDown(!up);
      }
    });
    // Let the mount effect's reveal/hide detection drive broker visibility, and
    // route the manual Reconnect button to the shared connection.
    brokerVisibilityRef.current = (visible) => terminalBroker.setVisibility(surfaceId, visible);
    reconnectRef.current = () => terminalBroker.forceReconnect();

    // Keystrokes flow back through the broker; the server only accepts input
    // from a visible, subscribed surface.
    const onDataDisposable = terminal.onData((data) => {
      terminalBroker.sendInput(surfaceId, data);
    });

    return () => {
      disposed = true;
      brokerVisibilityRef.current = () => undefined;
      reconnectRef.current = () => undefined;
      notifyResizeRef.current = () => undefined;
      window.clearTimeout(resizeTimerRef.current);
      window.clearTimeout(stabilizeTimer);
      onDataDisposable.dispose();
      terminalBroker.unsubscribe(surfaceId);
    };
  }, [session, revision]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    // Re-theme the live terminal when the app theme changes (full ITheme palette).
    terminal.options.theme = { ...builtTheme.terminal };
    if (viewerRef.current) {
      viewerRef.current.options.theme = { ...builtTheme.terminal };
    }
  }, [builtTheme]);

  useEffect(() => {
    // One blink timer for the focused cell instead of N — a 4x4 grid kept 16
    // cursor-blink intervals alive for cursors nobody was looking at.
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.options.cursorBlink = focused;
    }
  }, [focused]);

  useEffect(() => {
    const host = overlayRef.current;
    const main = terminalRef.current;
    if (!scrollbackLines || !host || !main) {
      return;
    }
    // Render the frozen snapshot in a second xterm with the SAME cols/rows/font/theme
    // as the live terminal: identical wrapping and metrics (no jump, no h-scroll),
    // full colors (capture-pane -e), xterm-native smooth scrolling and selection.
    const viewer = new Terminal({
      cols: main.cols,
      rows: main.rows,
      allowProposedApi: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: 'JetBrains Mono, IBM Plex Mono, ui-monospace, monospace',
      fontSize: 13,
      scrollback: SCROLLBACK_FETCH_ROWS + main.rows,
      scrollSensitivity: 1.35,
      smoothScrollDuration: 0,
      theme: { ...builtThemeRef.current.terminal }
    });
    viewer.open(host);
    // The viewer's WebGL context counts against the SAME 8-slot budget as the
    // live cells — it used to bypass it, so opening scrollback on a full 3x3
    // grid could push the page past the browser's context cap and evict a
    // visible cell's renderer. Only acquire a real context when a slot is free;
    // the DOM fallback's sub-pixel metric drift is acceptable for a transient,
    // non-scrolling snapshot.
    let viewerWebgl: WebglAddon | undefined;
    let viewerSlotHeld = false;
    if (supportsWebgl2() && acquireWebglSlot()) {
      viewerSlotHeld = true;
      // Renderer addons must load AFTER open() to activate on a second instance.
      try {
        viewerWebgl = new WebglAddon();
        viewer.loadAddon(viewerWebgl);
        viewerWebgl.onContextLoss(() => {
          viewerWebgl?.dispose();
          viewerWebgl = undefined;
          if (viewerSlotHeld) {
            viewerSlotHeld = false;
            releaseWebglSlot();
          }
        });
      } catch {
        // DOM renderer fallback is acceptable
        viewerSlotHeld = false;
        releaseWebglSlot();
      }
    }
    viewerRef.current = viewer;
    // Hide the cursor, replay the snapshot, then land continuous with the live view:
    // bottom of buffer == current screen, nudged up by the wheel lines that entered.
    viewer.write('\x1b[?25l' + scrollbackLines.join('\r\n'), () => {
      viewer.scrollLines(-entryLinesRef.current);
    });
    host.focus({ preventScroll: true });
    return () => {
      viewerRef.current = null;
      if (viewerSlotHeld) {
        viewerSlotHeld = false;
        releaseWebglSlot();
      }
      viewer.dispose();
    };
  }, [scrollbackLines]);

  return (
    <div className="terminalSurfaceShell" ref={shellRef}>
      <div className="terminalSurface" ref={hostRef} />
      {scrollbackLines ? (
        <div
          className="terminalScrollbackOverlay"
          ref={overlayRef}
          tabIndex={-1}
          onContextMenu={(event) => {
            const selection = viewerRef.current?.getSelection() ?? '';
            if (selection) {
              event.preventDefault();
              selectionMenuRef.current?.(selection, event.clientX, event.clientY);
            }
          }}
          onKeyDownCapture={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              exitScrollbackRef.current();
              return;
            }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
              const viewer = viewerRef.current;
              if (viewer?.hasSelection()) {
                event.preventDefault();
                void navigator.clipboard?.writeText(viewer.getSelection()).catch(() => undefined);
              }
            }
          }}
        />
      ) : null}
      {bridgeDown ? (
        <div className="terminalReconnect">
          <span>terminal bridge lost</span>
          <button type="button" onClick={() => reconnectRef.current()}>
            Reconnect
          </button>
        </div>
      ) : null}
      <div className="terminalScrollRail" ref={scrollRailRef} aria-hidden="true">
        <div className="terminalScrollThumb" ref={scrollThumbRef} />
      </div>
    </div>
  );
}

let webgl2Supported: boolean | undefined;

/**
 * WebGL2 availability, probed once per page. The previous per-call version
 * created a temporary WebGL2 context on every cell mount and every scrollback
 * entry — exactly the context-eviction pressure the budget exists to avoid.
 */
function supportsWebgl2(): boolean {
  if (webgl2Supported === undefined) {
    webgl2Supported = detectAcceleratedWebgl2();
  }
  return webgl2Supported;
}

/**
 * True only for HARDWARE-accelerated WebGL2. Software GL (SwiftShader, llvmpipe,
 * Mesa software, Microsoft Basic Render) is common on WSL2, remote desktops and
 * GPU-less VMs, and there xterm's WebGL renderer is SLOWER to create and run
 * than its DOM renderer — WebGL context creation alone was measured at hundreds
 * of ms to seconds per group switch under SwiftShader, versus ~50-100ms for the
 * DOM renderer. On those machines we stay on the DOM renderer so switches paint
 * fast; real GPUs keep WebGL for steady-state throughput.
 */
function detectAcceleratedWebgl2(): boolean {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) {
    return false;
  }
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debugInfo
    ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '')
    : '';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(renderer)) {
    return false;
  }
  return true;
}

function getSelectedText(terminal: Terminal): string {
  return terminal.getSelection() || window.getSelection()?.toString() || '';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function copyText(text: string): void {
  if (!text) {
    return;
  }

  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
    return;
  }

  fallbackCopyText(text);
}

function fallbackCopyText(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}
