// LSP server resolution — DEV / default implementation (Node + Vite).
//
// Resolves the bundled TypeScript / Python language-server CLIs from the real
// node_modules tree. This is the variant the Vite dev server and `tsc`/Node use.
// The Bun standalone build swaps this module for `./lspResolver.standalone.ts`
// (see scripts/build-standalone.ts) which serves them from an embedded tarball.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let cachedTypescriptCli: string | null | undefined;
let cachedPyrightCli: string | null | undefined;

export function resolveTypescriptCli(): string | undefined {
  if (cachedTypescriptCli !== undefined) {
    return cachedTypescriptCli ?? undefined;
  }
  try {
    cachedTypescriptCli = require.resolve('typescript-language-server/lib/cli.mjs');
  } catch {
    cachedTypescriptCli = null;
  }
  return cachedTypescriptCli ?? undefined;
}

export function resolvePyrightCli(): string | undefined {
  if (cachedPyrightCli !== undefined) {
    return cachedPyrightCli ?? undefined;
  }
  try {
    cachedPyrightCli = require.resolve('pyright/langserver.index.js');
  } catch {
    cachedPyrightCli = null;
  }
  return cachedPyrightCli ?? undefined;
}

// Extra env merged into each language-server child process. Empty for Node/Vite
// (the CLIs are run by the host runtime directly).
export const lspChildEnv: Record<string, string> = {};
