import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('channels composer UI', () => {
  const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/web/channels/Composer.tsx', import.meta.url), 'utf8');

  it('uses a full-width top-edge handle instead of the native corner resize grip', () => {
    const inputRule = /\.chanComposerInput\s*\{(?<body>[^}]*)\}/.exec(css)?.groups?.body ?? '';
    const handleRule = /\.chanComposerResizeHandle\s*\{(?<body>[^}]*)\}/.exec(css)?.groups?.body ?? '';

    expect(source).toContain('className="chanComposerResizeHandle"');
    expect(source).toContain('onPointerDown={startResize}');
    expect(inputRule).toContain('resize: none');
    expect(inputRule).not.toContain('resize: vertical');
    expect(handleRule).toContain('cursor: ns-resize');
    expect(handleRule).toContain('left: 8px');
    expect(handleRule).toContain('right: 8px');
    expect(handleRule).toContain('top: -5px');
  });

  it('uses a fixed textarea baseline so typing does not clobber manual height', () => {
    expect(source).toContain('rows={2}');
    expect(source).not.toContain('Math.min(6, Math.max(2, text.split');
  });
});
