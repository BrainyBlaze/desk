// The desk package root, from any module inside the release (dev repo or an
// installed standalone). Owned by shared so both the CLI (serve launch) and
// the server (daemon supervisor spawning the same-release CLI entry) resolve
// the SAME root — a supervisor must never spawn an ambient `desk` from PATH,
// which can belong to a different release after an activation swap.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findPackageRoot(fromUrl: string): string {
  let directory = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      existsSync(join(directory, 'package.json')) &&
      (existsSync(join(directory, 'vite.config.ts')) || existsSync(join(directory, 'dist', 'cli', 'main.js')))
    ) {
      return directory;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error('cannot locate the desk package root (reinstall desk)');
}
