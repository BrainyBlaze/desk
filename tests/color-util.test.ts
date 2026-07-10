import { describe, expect, it } from 'vitest';
import { hslStringToHex } from '../src/web/editor/colorUtil';

describe('hslStringToHex', () => {
  it('converts hsl() strings to hex', () => {
    expect(hslStringToHex('hsl(0, 0%, 0%)')).toBe('#000000');
    expect(hslStringToHex('hsl(0, 0%, 100%)')).toBe('#ffffff');
    expect(hslStringToHex('hsl(180, 100%, 50%)')).toBe('#00ffff');
    expect(hslStringToHex('hsl(120, 100%, 25%)')).toBe('#008000');
  });

  it('converts hsla() ignoring alpha', () => {
    expect(hslStringToHex('hsla(180, 100%, 50%, 0.5)')).toBe('#00ffff');
  });

  it('passes hex through and falls back to black on garbage', () => {
    expect(hslStringToHex('#ffd166')).toBe('#ffd166');
    expect(hslStringToHex('rebeccapurple')).toBe('#000000');
  });

  it('accepts space-separated (modern CSS) hsl() syntax', () => {
    expect(hslStringToHex('hsl(180 100% 50%)')).toBe('#00ffff');
    expect(hslStringToHex('hsl(120 100% 25%)')).toBe('#008000');
  });

  it('clamps out-of-range channels to a valid 2-digit hex', () => {
    expect(hslStringToHex('hsl(0 0% 200%)')).toBe('#ffffff');
  });

  it('clamps S/L input channels like CSS and wraps hue', () => {
    // S clamped to 100 BEFORE conversion gives the dark-yellow #7f8000 (127.5 rounds the r
    // channel to 0x7f); the old byte-clamp-only bug produced #bfbf00 from the unclamped S=200.
    expect(hslStringToHex('hsl(60 200% 25%)')).toBe('#7f8000');
    expect(hslStringToHex('hsl(-120 100% 50%)')).toBe('#0000ff'); // hue -120 wraps to 240 (blue)
    expect(hslStringToHex('hsl(480 100% 50%)')).toBe('#00ff00'); // hue 480 wraps to 120 (green)
  });
});
