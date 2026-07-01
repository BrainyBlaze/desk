import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Reduced-motion regression guard: the channels feed animations (the event-card landing
 * flash and the working spinner) must be disabled under prefers-reduced-motion.
 * styles.css is merge-churned often, so this pins the coverage rather than
 * relying on a visual check. The `[^@]*` between the media open and the rules
 * keeps the match within ONE @media block (an `@` would start a new at-rule).
 */
describe('channels reduced-motion', () => {
  const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');

  it('disables chanFlash + chanWorkingDots animations inside a prefers-reduced-motion block', () => {
    expect(css).toMatch(
      /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[^@]*\.chanMessage\.chanFlash\s*\{\s*animation:\s*none[^@]*\.chanWorkingDots\s*\{\s*animation:\s*none/
    );
  });
});
