import { describe, expect, it } from 'vitest';
import { clampMenuPosition } from '../src/web/menuPosition.js';

describe('clampMenuPosition', () => {
  it('keeps an in-bounds cursor position unchanged', () => {
    expect(
      clampMenuPosition({ x: 120, y: 80 }, { width: 160, height: 120 }, { width: 800, height: 600 })
    ).toEqual({ left: 120, top: 80 });
  });

  it('flips a menu left and up when it would cross the viewport edge', () => {
    expect(
      clampMenuPosition({ x: 780, y: 580 }, { width: 180, height: 140 }, { width: 800, height: 600 })
    ).toEqual({ left: 600, top: 440 });
  });

  it('keeps the menu padding inside the top and left edges', () => {
    expect(
      clampMenuPosition({ x: 2, y: 3 }, { width: 160, height: 120 }, { width: 800, height: 600 })
    ).toEqual({ left: 8, top: 8 });
  });
});
