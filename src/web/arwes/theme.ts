import { createThemeColor, createThemeMultiplier, createThemeUnit } from '@arwes/react';

const HUE_PRIMARY = 180;
const HUE_SECONDARY = 48;
const HUE_ERROR = 10;

// Index 0 (lightest) .. 12 (darkest).
const lightness = (i: number): number => Math.max(2, 96 - i * 7.5);

export const theme = Object.freeze({
  colors: {
    primary: {
      low: createThemeColor((i) => [HUE_PRIMARY, 25, lightness(i)]),
      main: createThemeColor((i) => [HUE_PRIMARY, 80, lightness(i)]),
      high: createThemeColor((i) => [HUE_PRIMARY, 100, lightness(i)])
    },
    secondary: createThemeColor((i) => [HUE_SECONDARY, 90, lightness(i)]),
    neutral: createThemeColor((i) => [HUE_PRIMARY, 10, lightness(i)]),
    error: createThemeColor((i) => [HUE_ERROR, 85, lightness(i)])
  },
  space: createThemeUnit((i) => `${i * 0.25}rem`),
  spacen: createThemeMultiplier((i) => i * 4),
  fontFamily: {
    code: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace"
  }
});

/* ---------- Switchable theme system ---------- */

export type DeskThemeName =
  | 'cyan-night'
  | 'amber-night'
  | 'matrix-night'
  | 'violet-night'
  | 'crimson-night'
  | 'synth-night'
  | 'graphite-mono'
  | 'medical-calm'
  | 'arctic-light'
  | 'paper-light'
  | 'sage-light'
  | 'lavender-light';

interface DeskThemePalette {
  label: string;
  mode: 'dark' | 'light';
  /** primary hue/saturation drives lines, glows, text tint */
  hue: number;
  sat: number;
  /** secondary accent (labels, highlights) */
  accentHue: number;
  accentSat: number;
  /** background tint */
  bgHue: number;
  bgSat: number;
  /** contrast trim: 1 = full, lower = softer (ergonomic/medical) */
  contrast: number;
  /** swatch chips for the settings UI */
  preview: [string, string, string];
}

export const DESK_THEMES: Record<DeskThemeName, DeskThemePalette> = {
  'cyan-night': {
    label: 'Cyan Night',
    mode: 'dark',
    hue: 180, sat: 80, accentHue: 48, accentSat: 90, bgHue: 188, bgSat: 45, contrast: 1,
    preview: ['hsl(188, 45%, 4%)', 'hsl(180, 80%, 55%)', 'hsl(48, 90%, 60%)']
  },
  'amber-night': {
    label: 'Amber Night',
    mode: 'dark',
    hue: 40, sat: 85, accentHue: 190, accentSat: 80, bgHue: 35, bgSat: 25, contrast: 1,
    preview: ['hsl(35, 25%, 4%)', 'hsl(40, 85%, 55%)', 'hsl(190, 80%, 60%)']
  },
  'matrix-night': {
    label: 'Matrix Green',
    mode: 'dark',
    hue: 130, sat: 75, accentHue: 80, accentSat: 85, bgHue: 140, bgSat: 30, contrast: 1,
    preview: ['hsl(140, 30%, 4%)', 'hsl(130, 75%, 50%)', 'hsl(80, 85%, 55%)']
  },
  'violet-night': {
    label: 'Violet Night',
    mode: 'dark',
    hue: 275, sat: 70, accentHue: 320, accentSat: 80, bgHue: 270, bgSat: 30, contrast: 1,
    preview: ['hsl(270, 30%, 4%)', 'hsl(275, 70%, 62%)', 'hsl(320, 80%, 62%)']
  },
  'crimson-night': {
    label: 'Crimson Night',
    mode: 'dark',
    hue: 350, sat: 75, accentHue: 28, accentSat: 90, bgHue: 350, bgSat: 22, contrast: 1,
    preview: ['hsl(350, 22%, 4%)', 'hsl(350, 75%, 58%)', 'hsl(28, 90%, 58%)']
  },
  'synth-night': {
    label: 'Synthwave',
    mode: 'dark',
    hue: 300, sat: 75, accentHue: 190, accentSat: 90, bgHue: 285, bgSat: 35, contrast: 1,
    preview: ['hsl(285, 35%, 4%)', 'hsl(300, 75%, 60%)', 'hsl(190, 90%, 58%)']
  },
  'graphite-mono': {
    label: 'Graphite Mono',
    mode: 'dark',
    hue: 210, sat: 12, accentHue: 210, accentSat: 30, bgHue: 215, bgSat: 8, contrast: 0.85,
    preview: ['hsl(215, 8%, 6%)', 'hsl(210, 12%, 62%)', 'hsl(210, 30%, 62%)']
  },
  'medical-calm': {
    label: 'Medical Calm',
    mode: 'dark',
    hue: 152, sat: 28, accentHue: 35, accentSat: 35, bgHue: 160, bgSat: 8, contrast: 0.78,
    preview: ['hsl(160, 8%, 7%)', 'hsl(152, 28%, 58%)', 'hsl(35, 35%, 60%)']
  },
  'arctic-light': {
    label: 'Arctic Light',
    mode: 'light',
    hue: 200, sat: 80, accentHue: 22, accentSat: 95, bgHue: 205, bgSat: 35, contrast: 1,
    preview: ['hsl(205, 35%, 96%)', 'hsl(200, 80%, 30%)', 'hsl(22, 95%, 42%)']
  },
  'paper-light': {
    label: 'Paper Light',
    mode: 'light',
    hue: 165, sat: 55, accentHue: 28, accentSat: 80, bgHue: 42, bgSat: 32, contrast: 0.95,
    preview: ['hsl(42, 32%, 94%)', 'hsl(165, 55%, 24%)', 'hsl(28, 80%, 38%)']
  },
  'sage-light': {
    label: 'Sage Light',
    mode: 'light',
    hue: 150, sat: 45, accentHue: 18, accentSat: 60, bgHue: 130, bgSat: 16, contrast: 0.92,
    preview: ['hsl(130, 16%, 94%)', 'hsl(150, 45%, 26%)', 'hsl(18, 60%, 40%)']
  },
  'lavender-light': {
    label: 'Lavender Light',
    mode: 'light',
    hue: 268, sat: 55, accentHue: 330, accentSat: 70, bgHue: 270, bgSat: 24, contrast: 1,
    preview: ['hsl(270, 24%, 95%)', 'hsl(268, 55%, 34%)', 'hsl(330, 70%, 40%)']
  }
};

export const DESK_THEME_NAMES = Object.keys(DESK_THEMES) as DeskThemeName[];

export const THEME_STORAGE_KEY = 'desk.theme';

export function readStoredTheme(value: string | null): DeskThemeName {
  return value && value in DESK_THEMES ? (value as DeskThemeName) : 'cyan-night';
}

/** Full xterm ITheme palette (https://xtermjs.org/docs/api/terminal/interfaces/itheme/). */
export interface DeskTerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

const DARK_ANSI = {
  black: '#031015',
  red: '#ff4d6d',
  green: '#20f7a5',
  yellow: '#ffd166',
  blue: '#35a7ff',
  magenta: '#e66cff',
  cyan: '#00f5ff',
  white: '#eaffff',
  brightBlack: '#5c7a80',
  brightRed: '#ff7a90',
  brightGreen: '#6ffac0',
  brightYellow: '#ffe09a',
  brightBlue: '#6fc0ff',
  brightMagenta: '#f0a0ff',
  brightCyan: '#7ff7ff',
  brightWhite: '#ffffff'
};

/** Deeper ANSI variants that stay readable on light backgrounds. */
const LIGHT_ANSI = {
  black: '#1a2b2e',
  red: '#c2273f',
  green: '#0a7a4a',
  yellow: '#9a6b00',
  blue: '#0f5ca8',
  magenta: '#8f2bb0',
  cyan: '#006e7a',
  white: '#5c6b6e',
  brightBlack: '#44585c',
  brightRed: '#e23a55',
  brightGreen: '#0c9a5e',
  brightYellow: '#b8860b',
  brightBlue: '#1573d4',
  brightMagenta: '#a93fd0',
  brightCyan: '#008b99',
  brightWhite: '#2c3c40'
};

export interface DeskBuiltTheme {
  name: DeskThemeName;
  label: string;
  mode: 'dark' | 'light';
  vars: Record<string, string>;
  /** resolved color strings for canvas/JS consumers that cannot read CSS vars */
  canvas: {
    gridLine: string;
    movingLine: string;
    dots: string;
    illuminator: string;
  };
  /** xterm.js theme (applied live via terminal.options.theme) */
  terminal: DeskTerminalTheme;
}

export function createDeskTheme(name: DeskThemeName): DeskBuiltTheme {
  const p = DESK_THEMES[name];
  const c = p.contrast;
  const hsl = (h: number, s: number, l: number, a?: number): string =>
    a === undefined ? `hsl(${h}, ${s}%, ${l}%)` : `hsla(${h}, ${s}%, ${l}%, ${a})`;

  const vars: Record<string, string> =
    p.mode === 'dark'
      ? {
          '--desk-bg': hsl(p.bgHue, p.bgSat, 4),
          '--desk-bg-elevated': hsl(p.bgHue, p.bgSat, 7),
          '--desk-surface': hsl(p.bgHue, Math.round(p.bgSat * 0.9), 9, 0.72),
          '--desk-input-bg': hsl(p.bgHue, p.bgSat, 3, 0.94),
          '--desk-text': hsl(p.hue, Math.round(p.sat * 0.9), Math.round(88 * c)),
          '--desk-text-dim': hsl(p.hue, Math.round(p.sat * 0.25), Math.round(58 * c)),
          '--desk-line': hsl(p.hue, p.sat, 50, 0.5 * c),
          '--desk-line-strong': hsl(p.hue, Math.min(100, p.sat + 15), Math.round(58 * c)),
          '--desk-accent': hsl(p.accentHue, p.accentSat, Math.round(62 * c)),
          '--desk-error': 'hsl(10, 85%, 58%)',
          '--desk-ok': 'hsl(160, 85%, 52%)',
          '--desk-warn': 'hsl(38, 90%, 60%)',
          '--desk-info': 'hsl(212, 80%, 66%)',
          '--desk-glow': hsl(p.hue, 100, 60, 0.12 * c),
          // Brand wordmark sheen: specular band + aura. White reads as a glint
          // against dark backgrounds; the aura needs far more alpha than the
          // ambient glow to survive drop-shadow rendering at text size.
          '--desk-sheen-hi': '#ffffff',
          '--desk-sheen-glow': hsl(p.hue, 100, 65, 0.4 * c),
          '--desk-scrim': 'rgba(0, 4, 6, 0.74)',
          '--arwes-frames-line-color': hsl(p.hue, p.sat, Math.round(46 * c)),
          '--arwes-frames-bg-color': hsl(p.hue, p.sat, 14, 0.25),
          '--arwes-frames-deco-color': hsl(p.accentHue, p.accentSat, Math.round(58 * c))
        }
      : {
          '--desk-bg': hsl(p.bgHue, p.bgSat, 96),
          '--desk-bg-elevated': hsl(p.bgHue, Math.min(100, p.bgSat + 6), 90),
          '--desk-surface': hsl(p.bgHue, Math.min(100, p.bgSat + 10), 87),
          '--desk-input-bg': hsl(p.bgHue, p.bgSat, 99),
          '--desk-text': hsl(p.hue, p.sat, Math.round(14 / c)),
          '--desk-text-dim': hsl(p.hue, Math.round(p.sat * 0.55), 34),
          '--desk-line': hsl(p.hue, p.sat, 32, 0.6),
          '--desk-line-strong': hsl(p.hue, Math.min(100, p.sat + 20), 26),
          '--desk-accent': hsl(p.accentHue, p.accentSat, 35),
          '--desk-error': 'hsl(8, 80%, 38%)',
          '--desk-ok': 'hsl(158, 85%, 25%)',
          '--desk-warn': 'hsl(34, 90%, 34%)',
          '--desk-info': 'hsl(212, 75%, 38%)',
          '--desk-glow': hsl(p.hue, 90, 32, 0.16),
          // Light mode: a white glint would erase dark glyphs into the ~96%
          // lightness background, so the "shine" is a lighter-than-text tint
          // that stays readable while sweeping.
          '--desk-sheen-hi': hsl(p.hue, Math.round(p.sat * 0.6), 52),
          '--desk-sheen-glow': hsl(p.hue, 90, 32, 0.28),
          '--desk-scrim': 'rgba(228, 238, 240, 0.74)',
          '--arwes-frames-line-color': hsl(p.hue, p.sat, 30),
          '--arwes-frames-bg-color': hsl(p.bgHue, Math.min(100, p.bgSat + 8), 90, 0.85),
          '--arwes-frames-deco-color': hsl(p.accentHue, p.accentSat, 34)
        };

  const canvas =
    p.mode === 'dark'
      ? {
          gridLine: hsl(p.hue, 100, 60, 0.05 * c),
          movingLine: hsl(p.hue, 100, 70, 0.06 * c),
          dots: hsl(p.hue, 90, 55, 0.05 * c),
          illuminator: hsl(p.hue, 80, 50, 0.22 * c)
        }
      : {
          gridLine: hsl(p.hue, 60, 28, 0.1),
          movingLine: hsl(p.hue, 60, 28, 0.1),
          dots: hsl(p.hue, 50, 28, 0.08),
          illuminator: hsl(p.hue, 70, 38, 0.16)
        };

  const terminal: DeskTerminalTheme =
    p.mode === 'dark'
      ? {
          background: hsl(p.bgHue, p.bgSat, 3),
          foreground: hsl(p.hue, Math.round(p.sat * 0.7), Math.round(86 * c)),
          cursor: vars['--desk-accent']!,
          cursorAccent: hsl(p.bgHue, p.bgSat, 4),
          selectionBackground: hsl(p.hue, 60, 26),
          selectionInactiveBackground: hsl(p.hue, 40, 18),
          ...DARK_ANSI
        }
      : {
          background: hsl(p.bgHue, p.bgSat, 98),
          foreground: hsl(p.hue, p.sat, 16),
          cursor: vars['--desk-accent']!,
          cursorAccent: hsl(p.bgHue, p.bgSat, 98),
          selectionBackground: hsl(p.hue, 65, 80),
          selectionInactiveBackground: hsl(p.hue, 45, 88),
          ...LIGHT_ANSI
        };

  vars['--desk-term-bg'] = terminal.background;
  vars['--desk-term-fg'] = terminal.foreground;
  vars['--desk-term-selection'] = terminal.selectionBackground;

  return { name, label: p.label, mode: p.mode, vars, canvas, terminal };
}

/** CSS custom properties applied at the shell root; styles.css consumes var(--desk-*). */
export function themeRootVars(): Record<string, string> {
  return createDeskTheme('cyan-night').vars;
}
