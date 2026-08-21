import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DESK_DURATIONS, isReducedMotion } from '../src/web/arwes/motion.js';

const appSource = readFileSync(new URL('../src/web/App.tsx', import.meta.url), 'utf8');

describe('desk motion', () => {
  it('exports tuned durations', () => {
    expect(DESK_DURATIONS).toEqual({ enter: 0.32, exit: 0.18, stagger: 0.05 });
  });

  it('detects reduced motion via injected matchMedia', () => {
    const matches = (value: boolean) =>
      ((query: string) => ({ matches: value, media: query })) as unknown as typeof window.matchMedia;
    expect(isReducedMotion(matches(true))).toBe(true);
    expect(isReducedMotion(matches(false))).toBe(false);
  });

  it('returns false when matchMedia is unavailable (SSR/tests)', () => {
    expect(isReducedMotion(undefined)).toBe(false);
  });

  it('keeps the application root and terminal frame outside animation gates', () => {
    expect(appSource).not.toContain('<Animator active={booted && snapshot !== null}>');
    expect(appSource).toContain('<section className="terminalFrame">');
    expect(appSource).not.toMatch(/<Animated[^>]*className="terminalFrame"/);
  });

  it('mounts terminal subscriptions outside staggered animation gates', () => {
    expect(appSource).not.toMatch(/<Animator[^>]*>\s*<AgentMultiplexer/);
  });
});
