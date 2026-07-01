import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';

describe('vite build config', () => {
  it('writes UI assets outside compiled server/CLI output', () => {
    expect(viteConfig.build?.outDir).toBe('dist/public');
    expect(viteConfig.build?.emptyOutDir).toBe(true);
  });
});
