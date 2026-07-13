import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('notification drawer resize persistence', () => {
  it('updates live on move but persists only when the pointer gesture ends', () => {
    const source = readFileSync(new URL('../../src/web/App.tsx', import.meta.url), 'utf8');

    expect(source).not.toMatch(/localStorage\.setItem\('desk\.notifWidth',[\s\S]*\}, \[notifWidth\]\)/);
    expect(source).toMatch(/onResize: setNotifWidth,[\s\S]*onResizeEnd:/);
    expect(source).toMatch(/onPointerMove=[\s\S]*onResize\(nextWidth\)/);
    expect(source).toMatch(/onPointerUp=\{finishResize\}/);
    expect(source).toMatch(/onPointerCancel=\{finishResize\}/);
    expect(source).toMatch(/onResizeEnd\(drag\.currentWidth\)/);
  });
});
