import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('app rail docs link', () => {
  const source = readFileSync(new URL('../src/web/App.tsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');

  it('opens the public docs from the app rail in a new tab', () => {
    expect(source).toContain('<RailDocsButton />');
    expect(source).toContain('href="https://docs.desk.cloud"');
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noreferrer noopener"');
    expect(source).toContain('aria-label="Docs"');
  });

  it('keeps the docs link pinned to the bottom of the rail', () => {
    expect(styles).toMatch(/\.railDocsButton\s*\{[^}]*margin-top:\s*auto;/s);
  });
});
