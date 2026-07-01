import { describe, expect, it } from 'vitest';
import { clampProblemsPanelHeight, getProblemsPanelDragHeight } from '../../src/web/editor/ProblemsPanel';

describe('ProblemsPanel resize handle', () => {
  it('clamps configured and drag-derived heights', () => {
    expect(clampProblemsPanelHeight(200, 120, 480)).toBe(200);
    expect(clampProblemsPanelHeight(900, 120, 480)).toBe(480);
    expect(clampProblemsPanelHeight(-10, 120, 480)).toBe(120);
    expect(clampProblemsPanelHeight(Number.NaN, 120, 480)).toBe(200);

    expect(getProblemsPanelDragHeight(200, 300, -100, 120, 480)).toBe(480);
    expect(getProblemsPanelDragHeight(480, 0, 800, 120, 480)).toBe(120);
    expect(getProblemsPanelDragHeight(200, 300, 250, 120, 480)).toBe(250);
  });
});
