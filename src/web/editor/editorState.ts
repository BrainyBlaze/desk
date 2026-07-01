export interface TabSelection {
  tabs: string[];
  active: string | null;
}

export function openTab(tabs: string[], active: string | null, path: string): { tabs: string[]; active: string } {
  if (tabs.includes(path)) {
    return { tabs, active: path };
  }
  return { tabs: [...tabs, path], active: path };
}

export function closeTab(tabs: string[], active: string | null, path: string): TabSelection {
  const index = tabs.indexOf(path);
  if (index === -1) {
    return { tabs, active };
  }
  const next = tabs.filter((tab) => tab !== path);
  if (active !== path) {
    return { tabs: next, active };
  }
  return { tabs: next, active: next[index] ?? next[index - 1] ?? null };
}

export function moveTab(tabs: string[], from: number, to: number): string[] {
  if (from < 0 || from >= tabs.length || to < 0 || to >= tabs.length || from === to) {
    return tabs;
  }
  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

/** Basename labels; duplicates get "name — parentDir" disambiguation. */
export function tabLabels(tabs: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const tab of tabs) {
    const name = fileNameOf(tab);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const tab of tabs) {
    const name = fileNameOf(tab);
    if ((counts.get(name) ?? 0) > 1) {
      const parent = tab.slice(0, tab.lastIndexOf('/'));
      labels.set(tab, `${name} — ${parent.slice(parent.lastIndexOf('/') + 1)}`);
    } else {
      labels.set(tab, name);
    }
  }
  return labels;
}

/**
 * Candidate names for a duplicated entry: a.txt -> a-copy.txt, a-copy-2.txt …
 * Dotfiles and extensionless names get the suffix appended at the end.
 */
export function duplicateName(name: string, attempt: number): string {
  const suffix = attempt === 0 ? '-copy' : `-copy-${attempt + 1}`;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return `${name}${suffix}`;
  }
  return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
}
