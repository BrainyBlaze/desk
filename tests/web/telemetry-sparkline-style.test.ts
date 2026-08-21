import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('telemetry sparkline style', () => {
  it('strokes the element headerPrimitives actually renders', () => {
    // The sparkline renders as <path>; the stroke rule must target <path>, not
    // <polyline>. A path with no matching rule falls back to SVG defaults
    // (fill:black, no stroke) and every graph renders as a black blob.
    const primitives = readFileSync(new URL('../../src/web/headerPrimitives.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');

    expect(primitives).toContain('<path d={path} />');
    expect(styles).toMatch(/\.telemetrySpark path \{[^}]*fill: none;[^}]*stroke: var\(/s);
    expect(styles).not.toContain('.telemetrySpark polyline');
  });
});
