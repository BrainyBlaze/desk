/** Monaco's defineTheme only accepts hex colors; Desk theme tokens are hsl() strings. */
export function hslStringToHex(input: string): string {
  if (input.startsWith('#')) {
    return input;
  }
  const match = /^hsla?\(\s*(-?[\d.]+)(?:\s*,\s*|\s+)([\d.]+)%(?:\s*,\s*|\s+)([\d.]+)%/.exec(input);
  if (!match) {
    return '#000000';
  }
  // Match CSS: wrap hue into [0,360) and clamp S/L to their valid range BEFORE conversion
  // (clamping the derived RGB bytes instead yields a different colour than the browser).
  const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));
  const h = (((Number(match[1]) % 360) + 360) % 360) / 360;
  const s = clamp(Number(match[2]), 0, 100) / 100;
  const l = clamp(Number(match[3]), 0, 100) / 100;
  const hueToRgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }
  const toHex = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
