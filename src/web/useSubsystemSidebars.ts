import { useCallback, useRef, useState } from 'react';
import {
  CHANNELS_SIDEBAR_STORAGE_KEY,
  EDITOR_SIDEBAR_STORAGE_KEY,
  GIT_SIDEBAR_STORAGE_KEY,
  NOTES_SIDEBAR_STORAGE_KEY,
  PROJECTS_SIDEBAR_STORAGE_KEY,
  defaultSidebarCollapsed
} from './sidebarPanel.js';

type SidebarState = {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  registerToggle: (toggle: () => void) => void;
  toggle: () => void;
};

function useSubsystemSidebar(storageKey: string): SidebarState {
  const [collapsed, setCollapsed] = useState(() => defaultSidebarCollapsed(localStorage.getItem(storageKey)));
  const toggleRef = useRef<() => void>(() => undefined);
  const registerToggle = useCallback((toggle: () => void) => {
    toggleRef.current = toggle;
  }, []);
  const toggle = useCallback(() => {
    toggleRef.current();
  }, []);
  return { collapsed, onCollapsedChange: setCollapsed, registerToggle, toggle };
}

export function useSubsystemSidebars(): {
  editor: SidebarState;
  git: SidebarState;
  notes: SidebarState;
  projects: SidebarState;
  channels: SidebarState;
} {
  return {
    editor: useSubsystemSidebar(EDITOR_SIDEBAR_STORAGE_KEY),
    git: useSubsystemSidebar(GIT_SIDEBAR_STORAGE_KEY),
    notes: useSubsystemSidebar(NOTES_SIDEBAR_STORAGE_KEY),
    projects: useSubsystemSidebar(PROJECTS_SIDEBAR_STORAGE_KEY),
    channels: useSubsystemSidebar(CHANNELS_SIDEBAR_STORAGE_KEY)
  };
}
