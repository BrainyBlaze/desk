import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('WorkspaceHeader responsive menu', () => {
  it('clears the mobile menu state when the viewport widens', () => {
    const source = readFileSync(new URL('../../src/web/WorkspaceHeader.tsx', import.meta.url), 'utf8');

    expect(source).toContain("import { useNarrowViewport } from './sidebarPanel.js';");
    expect(source).toMatch(/const narrowViewport = useNarrowViewport\(\)/);
    expect(source).toMatch(/if \(!narrowViewport\) \{\s*setMenuOpen\(false\);\s*\}/);
  });
});
