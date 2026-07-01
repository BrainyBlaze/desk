// LSP server resolution — Bun STANDALONE implementation.
//
// The compiled binary embeds the TypeScript / Python language-server trees as a
// tarball (built by scripts/make-assets.mjs, in node_modules layout so tsp
// resolves `typescript` for tsserver.js). On first use it's extracted to a
// cache dir and the CLIs are run by the desk binary itself with BUN_BE_BUN=1 —
// the binary acts as the bun runtime, inherited through tsp's fork of tsserver.
// No Node, no node_modules on disk.
//
// Selected at build time only: scripts/build-standalone.ts redirects imports of
// `./lspResolver.js` here. Excluded from tsconfig (the import attribute below is
// Bun-only). Keep the exported shape identical to ./lspResolver.ts.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import lspTar from '../assets/lsp.tar.gz' with { type: 'file' };

let cachedDir: string | undefined;

function extractedDir(): string {
  if (cachedDir) {
    return cachedDir;
  }
  // Version the cache by tarball size so a new binary (different LSP bundle)
  // never serves a stale extraction.
  const dir = join(homedir(), '.cache', 'desk', 'lsp', String(statSync(lspTar).size));
  if (!existsSync(join(dir, '.complete'))) {
    mkdirSync(dir, { recursive: true });
    // `tar` is an external process and cannot read the binary's embedded $bunfs
    // path — read the bytes here and feed them in via stdin.
    const result = spawnSync('tar', ['-xzf', '-', '-C', dir], {
      input: readFileSync(lspTar),
      maxBuffer: 1 << 30
    });
    if (result.status !== 0) {
      throw new Error(`desk: embedded LSP extract failed: ${result.stderr || result.error}`);
    }
    writeFileSync(join(dir, '.complete'), '');
  }
  cachedDir = dir;
  return dir;
}

function cli(...segments: string[]): string | undefined {
  const path = join(extractedDir(), ...segments);
  return existsSync(path) ? path : undefined;
}

export function resolveTypescriptCli(): string | undefined {
  return cli('node_modules', 'typescript-language-server', 'lib', 'cli.mjs');
}

export function resolvePyrightCli(): string | undefined {
  return cli('node_modules', 'pyright', 'langserver.index.js');
}

// Run the embedded CLIs (and their forks, e.g. tsserver) on the desk binary as a
// bun runtime. Merged into the language-server child env by stdioVirtualSession.
export const lspChildEnv: Record<string, string> = { BUN_BE_BUN: '1' };
