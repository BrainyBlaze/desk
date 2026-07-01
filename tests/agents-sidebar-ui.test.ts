import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('agents sidebar UI', () => {
  it('does not render the repair-session action in session rows', () => {
    const source = readFileSync(new URL('../src/web/App.tsx', import.meta.url), 'utf8');
    const withoutJsxComments = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

    expect(withoutJsxComments).not.toContain('label="Repair session"');
  });
});
