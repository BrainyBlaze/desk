import { describe, expect, it } from 'vitest';
import {
  DESK_THEMES,
  DESK_THEME_NAMES,
  THEME_STORAGE_KEY,
  createDeskTheme,
  readStoredTheme,
  theme,
  themeRootVars
} from '../src/web/arwes/theme.js';

describe('arwes theme', () => {
  it('produces css color strings per index', () => {
    const a = theme.colors.primary.main(3);
    const b = theme.colors.primary.main(9);
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it('supports alpha option', () => {
    const solid = theme.colors.primary.high(5);
    const faded = theme.colors.primary.high(5, { alpha: 0.2 });
    expect(faded).not.toBe(solid);
  });

  it('exposes spacing unit and multiplier', () => {
    expect(theme.space(4)).toBe('1rem');
    expect(theme.spacen(4)).toBe(16);
  });

  it('registers twelve themes with labels, modes, and previews', () => {
    expect(DESK_THEME_NAMES).toHaveLength(12);
    expect(DESK_THEME_NAMES).toContain('cyan-night');
    expect(DESK_THEME_NAMES).toContain('medical-calm');
    expect(DESK_THEME_NAMES).toContain('sage-light');
    expect(DESK_THEME_NAMES.filter((name) => DESK_THEMES[name].mode === 'light').length).toBeGreaterThanOrEqual(4);
    for (const name of DESK_THEME_NAMES) {
      const entry = DESK_THEMES[name];
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.preview).toHaveLength(3);
    }
  });

  it('creates a full var map + canvas colors for every theme, distinct across themes', () => {
    const requiredVars = ['--desk-bg', '--desk-text', '--desk-line-strong', '--arwes-frames-line-color'];
    const fingerprints = new Set<string>();
    for (const name of DESK_THEME_NAMES) {
      const built = createDeskTheme(name);
      for (const key of requiredVars) {
        expect(built.vars[key], `${name} ${key}`).toBeTypeOf('string');
      }
      expect(built.canvas.gridLine.length).toBeGreaterThan(0);
      expect(built.canvas.movingLine.length).toBeGreaterThan(0);
      expect(built.canvas.dots.length).toBeGreaterThan(0);
      expect(built.canvas.illuminator.length).toBeGreaterThan(0);
      expect(built.terminal.background.length).toBeGreaterThan(0);
      expect(built.terminal.foreground.length).toBeGreaterThan(0);
      expect(built.terminal.cursor.length).toBeGreaterThan(0);
      expect(built.terminal.selectionBackground.length).toBeGreaterThan(0);
      expect(built.vars['--desk-term-bg']).toBe(built.terminal.background);
      fingerprints.add(built.vars['--desk-bg']! + built.vars['--desk-text']!);
    }
    expect(fingerprints.size).toBe(DESK_THEME_NAMES.length);
  });

  it('light themes get light terminal backgrounds, dark themes dark', () => {
    expect(createDeskTheme('arctic-light').terminal.background).toMatch(/9[0-9]%\)$/);
    expect(createDeskTheme('cyan-night').terminal.background).toMatch(/ [0-9]%\)$/);
  });

  it('brand sheen highlight is white on dark themes, never white on light themes', () => {
    for (const name of DESK_THEME_NAMES) {
      const built = createDeskTheme(name);
      expect(built.vars['--desk-sheen-hi'], `${name} sheen-hi`).toBeTypeOf('string');
      expect(built.vars['--desk-sheen-glow'], `${name} sheen-glow`).toBeTypeOf('string');
      if (built.mode === 'dark') {
        expect(built.vars['--desk-sheen-hi']).toBe('#ffffff');
      } else {
        // A white/near-white glint would erase the dark wordmark glyphs into
        // the ~96% lightness background as the band sweeps across them.
        expect(built.vars['--desk-sheen-hi']).not.toBe('#ffffff');
        const lightness = Number(/(\d+)%\)$/.exec(built.vars['--desk-sheen-hi']!)?.[1]);
        expect(lightness, `${name} sheen-hi lightness`).toBeLessThanOrEqual(60);
      }
    }
  });

  it('parses stored theme with fallback to default', () => {
    expect(THEME_STORAGE_KEY).toBe('desk.theme');
    expect(readStoredTheme('medical-calm')).toBe('medical-calm');
    expect(readStoredTheme('nonsense')).toBe('cyan-night');
    expect(readStoredTheme(null)).toBe('cyan-night');
  });

  it('themeRootVars returns complete css custom property map', () => {
    const vars = themeRootVars();
    for (const key of [
      '--desk-bg',
      '--desk-bg-elevated',
      '--desk-text',
      '--desk-text-dim',
      '--desk-line',
      '--desk-line-strong',
      '--desk-accent',
      '--desk-error',
      '--desk-ok',
      '--desk-glow',
      '--arwes-frames-line-color',
      '--arwes-frames-bg-color',
      '--arwes-frames-deco-color'
    ]) {
      expect(vars[key], key).toBeTypeOf('string');
      expect(vars[key]!.length).toBeGreaterThan(0);
    }
  });
});
