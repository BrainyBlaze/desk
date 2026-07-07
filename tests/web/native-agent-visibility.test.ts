import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = () => readFileSync('src/web/App.tsx', 'utf8');
const nativeSurfaceSource = () => readFileSync('src/web/agentSurface/NativeAgentSurface.tsx', 'utf8');

describe('native agent grid visibility', () => {
  it('passes warm-group physical visibility down to native surfaces', () => {
    const source = appSource();

    expect(source).toMatch(/<AgentMultiplexer[\s\S]*?visible=\{visible\}/);
    expect(source).toMatch(/<TerminalCell[\s\S]*?visible=\{visible\}/);
    expect(source).toMatch(/<NativeAgentSurface[\s\S]*?visible=\{visible\}/);
  });

  it('subscribes native cells with physical visibility, not focus or mountedness', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/visible = true/);
    expect(source).toMatch(/agentSurfaceClient\.subscribe\(surfaceId, session, visible, handlers\)/);
    expect(source).toMatch(/agentSurfaceClient\.setVisibility\(surfaceId, visible\)/);
    expect(source).not.toMatch(/agentSurfaceClient\.subscribe\(surfaceId, session, true, handlers\)/);
    expect(source).not.toMatch(/agentSurfaceClient\.subscribe\(surfaceId, session, focused, handlers\)/);
    expect(source).not.toMatch(/agentSurfaceClient\.setVisibility\(surfaceId, focused\)/);
  });

  it('does not run native scroll bookkeeping while the warm group is hidden', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(/if \(!visible \|\| !el \|\| focusAnchorPendingRef\.current\) \{/);
    expect(source).toMatch(/if \(!visible \|\| !focused \|\| !focusAnchorPendingRef\.current/);
    expect(source).toMatch(/if \(visible && focused && model\.rows\.length > 0 && !focusAnchorPendingRef\.current\)/);
  });

  it('treats a broker snapshot as live after page reload', () => {
    const source = nativeSurfaceSource();

    expect(source).toMatch(
      /onSnapshot: \(\{ state, events \}\) => \{[\s\S]*?setPipelineLive\(true\);[\s\S]*?setModel\(rowsFromSnapshot\(events, state\)\);/
    );
  });
});
