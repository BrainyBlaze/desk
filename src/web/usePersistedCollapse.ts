import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { defaultSidebarCollapsed } from './sidebarPanel.js';

/**
 * Collapse state for a persisted sidebar, deduplicating the identical
 * read-init + write-back pattern repeated across the five subsystem sidebars and
 * the agent sidebar (§8.1.5). Behaviour matches the hand-written copies exactly:
 *
 *  - Initialise from localStorage[storageKey], falling back to viewport width on
 *    first boot (defaultSidebarCollapsed: no stored value => isNarrowViewport()).
 *  - On every change, write String(collapsed) back under storageKey.
 *  - If onChange is supplied, fire it in the SAME effect with the new value —
 *    this is the child->App mirror notification the five child-owned sidebars
 *    rely on. The agent sidebar (App-owned) omits it and is persist-only.
 *
 * storageKey is a parameter (not a constant) so the Editor/Notes shared component
 * can pass its runtime-selected key without hard-coding either one.
 */
export function usePersistedCollapse(
  storageKey: string,
  onChange?: (collapsed: boolean) => void
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [collapsed, setCollapsed] = useState(() => defaultSidebarCollapsed(localStorage.getItem(storageKey)));
  useEffect(() => {
    localStorage.setItem(storageKey, String(collapsed));
    onChange?.(collapsed);
  }, [collapsed, onChange, storageKey]);
  return [collapsed, setCollapsed];
}
