import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('WorkspaceHeader responsive menu', () => {
  it('clears the mobile menu state when the viewport widens', () => {
    const source = readFileSync(new URL('../../src/web/WorkspaceHeader.tsx', import.meta.url), 'utf8');

    expect(source).toContain("import { useNarrowViewport } from './sidebarPanel.js';");
    expect(source).toMatch(/const narrowViewport = useNarrowViewport\(\)/);
    expect(source).toMatch(/if \(!narrowViewport\) \{\s*setMenuOpen\(false\);\s*\}/);
  });

  it('drives every telemetry tile from one pulse-failure signal so a failed pulse cannot read as a first load', () => {
    const source = readFileSync(new URL('../../src/web/WorkspaceHeader.tsx', import.meta.url), 'utf8');

    // A failing pulse is any set error, not only a never-arrived first snapshot:
    // a stale snapshot must still warn rather than show calm live numbers.
    expect(source).toContain('const pulseDown = Boolean(systemError)');
    expect(source).toContain('const warnTone = pulseDown ?');
    // Tiles route their text through the shared tileText/placeholder rather
    // than a per-tile loading string; the precedence itself is unit-tested in
    // system-format (telemetryTileText).
    expect(source).not.toMatch(/:\s*'load init'/);
    expect(source).toContain('telemetryTileText');
    // A snapshot present keeps the real GPU cells (even stale, under warn); only
    // a first load with no snapshot collapses to one placeholder cell.
    expect(source).toMatch(/label: 'GPU', value: placeholder/);
  });

  it('hides the dead NVIDIA fallback cell on darwin and keeps NET honest about unmeasured traffic', () => {
    const source = readFileSync(new URL('../../src/web/WorkspaceHeader.tsx', import.meta.url), 'utf8');

    // nvidia-smi is structurally absent on macOS: a permanent N/A cell is
    // noise there, while on Linux the same cell diagnoses a missing driver.
    expect(source).toMatch(/platform === 'darwin'\s*\n?\s*\?\s*\[\]/);
    // Traffic is measured only when an interface was parsed; otherwise the NET
    // tile shows 'unmeasured', never a confident 0 B/s.
    expect(source).toMatch(/network\.interfaces\.length > 0/);
  });
});
