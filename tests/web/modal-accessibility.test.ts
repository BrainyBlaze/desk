import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isTopLayer, nextModalFocusIndex } from '../../src/web/arwes/modalFocus.js';

describe('shared Modal keyboard ownership', () => {
  it('owns focus and lets only the top dialog consume Escape', () => {
    const source = readFileSync(new URL('../../src/web/arwes/primitives.tsx', import.meta.url), 'utf8');

    expect(source).toContain("from './modalFocus.js'");
    expect(source).toMatch(/ref=\{modalRef\}[\s\S]*tabIndex=\{-1\}/);
    expect(source).toMatch(/event\.key === 'Tab'/);
    expect(source).toContain('event.stopImmediatePropagation()');
    expect(source).toMatch(/isTopLayer\(modal,[\s\S]*document\.querySelectorAll/);
    expect(source).toMatch(/previousFocus[\s\S]*\.focus\(\)/);
  });

  it('wraps Tab only at the dialog boundaries', () => {
    expect(nextModalFocusIndex(3, 2, false)).toBe(0);
    expect(nextModalFocusIndex(3, -1, false)).toBe(0);
    expect(nextModalFocusIndex(3, 0, true)).toBe(2);
    expect(nextModalFocusIndex(3, -1, true)).toBe(2);
    expect(nextModalFocusIndex(3, 1, false)).toBeNull();
    expect(nextModalFocusIndex(3, 1, true)).toBeNull();
    expect(nextModalFocusIndex(0, -1, false)).toBeNull();
  });

  it('grants keyboard ownership only to the last painted layer', () => {
    const lower = {};
    const upper = {};
    expect(isTopLayer(lower, [lower, upper])).toBe(false);
    expect(isTopLayer(upper, [lower, upper])).toBe(true);
    expect(isTopLayer(upper, [])).toBe(false);
  });
});
