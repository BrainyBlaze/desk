// Build the asset tarballs embedded into the Bun standalone binary:
//   • ui.tar.gz   — the Vite UI bundle (dist/public), served via sirv.
//   • lsp.tar.gz  — the TypeScript + Python language servers, in node_modules
//                   layout so tsp resolves `typescript` (tsserver.js) normally.
// Run after `vite build`, before `bun run scripts/build-standalone.ts`.
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assetsDir = join(root, 'src', 'server', 'assets');
const uiDir = join(root, 'dist', 'public');

if (!existsSync(join(uiDir, 'index.html'))) {
  throw new Error(`make-assets: ${uiDir}/index.html not found — run "vite build" first`);
}

mkdirSync(assetsDir, { recursive: true });

// UI: contents of dist/public at the tar root (extract → <dir>/index.html, …).
execFileSync('tar', ['-czf', join(assetsDir, 'ui.tar.gz'), '-C', uiDir, '.'], { stdio: 'inherit' });

// LSP: keep the node_modules/ prefix so node resolution finds `typescript`.
execFileSync(
  'tar',
  [
    '-czf',
    join(assetsDir, 'lsp.tar.gz'),
    '-C',
    root,
    'node_modules/typescript-language-server',
    'node_modules/typescript',
    'node_modules/pyright'
  ],
  { stdio: 'inherit' }
);

console.log('make-assets: wrote src/server/assets/{ui,lsp}.tar.gz');
