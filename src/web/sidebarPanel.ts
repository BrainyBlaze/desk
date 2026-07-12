import { useEffect, useState } from 'react';
export const AGENT_SIDEBAR_STORAGE_KEY = 'desk.agentSidebarCollapsed';
export const EDITOR_SIDEBAR_STORAGE_KEY = 'desk.editorSidebarCollapsed';
export const GIT_SIDEBAR_STORAGE_KEY = 'desk.gitSidebarCollapsed';
export const NOTES_SIDEBAR_STORAGE_KEY = 'desk.notesSidebarCollapsed';
export const PROJECTS_SIDEBAR_STORAGE_KEY = 'desk.projectsSidebarCollapsed';
export const CHANNELS_SIDEBAR_STORAGE_KEY = 'desk.channelsSidebarCollapsed';
/** All subsystem sidebars (agents/editor/git/notes) share these: they open at
 * the minimal width by default and can be dragged out to the max. */
export const AGENT_SIDEBAR_DEFAULT_SIZE = '180px';
export const AGENT_SIDEBAR_MIN_SIZE = '180px';
export const AGENT_SIDEBAR_MAX_SIZE = '560px';
export const AGENT_SIDEBAR_COLLAPSE_THRESHOLD_PX = 180;

export function isAgentSidebarCollapseSize(widthPx: number): boolean {
  // Strictly below: the default width IS the threshold value, and a sidebar
  // resting there must not arm the release-snap collapse.
  return widthPx < AGENT_SIDEBAR_COLLAPSE_THRESHOLD_PX;
}

export function readStoredSidebarCollapsed(value: string | null): boolean {
  return value === 'true';
}

/* ---------- narrow-viewport (mobile/tablet) layout decisions ---------- */

/** Sampled per call; boot-time consumers capture the value once. Uses the SAME
 *  boundary as the CSS `@media (max-width: 860px)` block (inclusive of 860), so
 *  JS drawer behavior and CSS drawer styling never disagree at exactly 860px —
 *  the width where the sidebar became a CSS overlay with no JS scrim/tap-out. */
export function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= 860;
}

/** Live narrow-viewport flag: tracks the same 860px boundary as the CSS
 * media block, reacting to window resizes — a desktop window shrunk after
 * load must re-arm the panel constraints, not stay frozen at boot values. */
export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(isNarrowViewport);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 860px)');
    const onChange = (): void => setNarrow(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/** Subsystem surface panel minimum. 420px exceeds a phone screen — and the
 * narrow value must leave room for the sidebar minimum (180px) plus the rail
 * inside ~360px-wide phones, or the panel library silently REJECTS sidebar
 * expand() as unsatisfiable. */
export function surfaceMinSize(narrow: boolean): string {
  return narrow ? '120px' : '420px';
}

/** First boot on a phone starts with sidebars collapsed (content first);
 * any explicitly stored preference wins. */
export function defaultSidebarCollapsed(stored: string | null): boolean {
  return stored === null ? isNarrowViewport() : readStoredSidebarCollapsed(stored);
}

/* ---------- Per-subsystem persisted sidebar width ---------- */

export const SIDEBAR_WIDTH_STORAGE_PREFIX = 'desk.sidebarWidth.';
const SIDEBAR_MIN_PX = AGENT_SIDEBAR_COLLAPSE_THRESHOLD_PX;
const SIDEBAR_MAX_PX = 560;

/* Width events also fire from mount echoes, unhide relayouts and window
 * scaling — none of which are user intent. Only widths observed during an
 * actual pointer drag on a resize handle may be recorded/persisted. The flag
 * is set by onPointerDown on the sidebar Separators and cleared by the
 * components' existing document pointerup handlers — deliberately NOT via
 * document capture listeners, which destabilize the panel library's sizing. */
let sidebarHandleDragActive = false;

export function isSidebarHandleDragActive(): boolean {
  return sidebarHandleDragActive;
}

export function setSidebarHandleDragActive(active: boolean): void {
  sidebarHandleDragActive = active;
}

export function clampSidebarWidth(px: number): number {
  return Math.min(SIDEBAR_MAX_PX, Math.max(SIDEBAR_MIN_PX, Math.round(px)));
}

/** Parse a cached width; null when absent or out of the sane range. */
export function readStoredSidebarWidth(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const px = Number(value);
  return Number.isFinite(px) && px >= SIDEBAR_MIN_PX && px <= SIDEBAR_MAX_PX ? Math.round(px) : null;
}

/**
 * Width persister for one subsystem sidebar: localStorage immediately (instant
 * restore on next boot) and desk.yml debounced (source of truth across
 * browsers). Resize streams fire per-frame during a drag — the debounce keeps
 * config writes to one per gesture.
 */
export function createSidebarWidthPersister(
  key: string,
  saveToServer: (widths: Record<string, number>) => Promise<void>
): (px: number) => void {
  let timer: number | undefined;
  let lastSaved = -1;
  return (px: number) => {
    const width = clampSidebarWidth(px);
    if (width !== Math.round(px) || width === lastSaved) {
      return; // out-of-range stream values (collapse drags) or no change
    }
    localStorage.setItem(`${SIDEBAR_WIDTH_STORAGE_PREFIX}${key}`, String(width));
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      lastSaved = width;
      void saveToServer({ [key]: width }).catch(() => undefined);
    }, 800);
  };
}
