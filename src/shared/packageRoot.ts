// The desk package root, from any module inside the release (dev repo or an
// installed standalone). Owned by shared so both the CLI (serve launch) and
// the server (daemon supervisor spawning the same-release CLI entry) resolve
// the SAME root — a supervisor must never spawn an ambient `desk` from PATH,
// which can belong to a different release after an activation swap.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DeskPackageKind = 'source' | 'distribution';

function detectPackageKind(directory: string): DeskPackageKind | undefined {
  if (!existsSync(join(directory, 'package.json'))) {
    return undefined;
  }
  if (
    existsSync(join(directory, 'vite.config.ts')) &&
    existsSync(join(directory, 'src', 'cli', 'main.ts'))
  ) {
    return 'source';
  }
  if (existsSync(join(directory, 'dist', 'cli', 'main.js'))) {
    return 'distribution';
  }
  return undefined;
}

export function classifyPackageRoot(root: string): DeskPackageKind {
  const kind = detectPackageKind(root);
  if (kind === undefined) {
    throw new Error(`incomplete desk package root at ${root}`);
  }
  return kind;
}

export function findPackageRoot(fromUrl: string): string {
  let directory = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    if (detectPackageKind(directory) !== undefined) {
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

export function resolvePackageRoot(
  fromUrl: string,
  cwd: string = process.cwd()
): string {
  try {
    return findPackageRoot(fromUrl);
  } catch (error) {
    if (
      fromUrl.startsWith('file:///$bunfs/') &&
      detectPackageKind(cwd) !== undefined
    ) {
      return cwd;
    }
    throw error;
  }
}
