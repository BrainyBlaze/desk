import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const nativeSurfaceSource = () => readFileSync('src/web/agentSurface/NativeAgentSurface.tsx', 'utf8');

describe('native agent grid visibility', () => {
  it('subscribes mounted native cells as visible regardless of focus', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/agentSurfaceClient\.subscribe\(surfaceId, session, true, handlers\)/);
    expect(source).not.toMatch(/agentSurfaceClient\.subscribe\(surfaceId, session, focused, handlers\)/);
    expect(source).not.toMatch(/agentSurfaceClient\.setVisibility\(surfaceId, focused\)/);
  });

  it('treats a broker snapshot as live after page reload', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(
      /onSnapshot: \(\{ state, events \}\) => \{[\s\S]*?setPipelineLive\(true\);[\s\S]*?setModel\(rowsFromSnapshot\(events, state\)\);/
    );
  });
});
