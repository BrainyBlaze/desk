// Prebuilt UI location — Bun STANDALONE implementation.
//
// The compiled binary embeds the Vite UI bundle (dist/public) as a tarball
// (scripts/make-assets.mjs). On first use it's extracted to a cache dir and
// served via the existing sirv static handler. Selected at build time only
// (scripts/build-standalone.ts redirects `./uiAsset.js` here); excluded from
// tsconfig (Bun-only import attribute).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import uiTar from './assets/ui.tar.gz' with { type: 'file' };

let cachedDir: string | undefined;

export function resolveEmbeddedUiDir(): string {
  if (cachedDir) {
    return cachedDir;
  }
  const dir = join(homedir(), '.cache', 'desk', 'ui', String(statSync(uiTar).size));
  if (!existsSync(join(dir, '.complete'))) {
    mkdirSync(dir, { recursive: true });
    const result = spawnSync('tar', ['-xzf', '-', '-C', dir], {
      input: readFileSync(uiTar),
      maxBuffer: 1 << 30
    });
    if (result.status !== 0) {
      throw new Error(`desk: embedded UI extract failed: ${result.stderr || result.error}`);
    }
    writeFileSync(join(dir, '.complete'), '');
  }
  cachedDir = dir;
  return dir;
}
