#!/usr/bin/env node

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function selectDeskCliEntry(root) {
  const sourceEntry = join(root, 'src', 'cli', 'main.ts');
  if (existsSync(join(root, 'vite.config.ts')) && existsSync(sourceEntry)) {
    return { kind: 'source', entry: sourceEntry };
  }

  const builtEntry = join(root, 'dist', 'cli', 'main.js');
  if (existsSync(builtEntry)) {
    return { kind: 'built', entry: builtEntry };
  }

  throw new Error('Desk package has neither a complete source checkout nor a built CLI');
}

export async function runDeskCli(root = dirname(dirname(fileURLToPath(import.meta.url)))) {
  const selected = selectDeskCliEntry(root);
  if (selected.kind === 'source') {
    try {
      await import('tsx/esm');
    } catch (error) {
      throw new Error('Desk source checkout requires the local tsx dependency; run npm install', {
        cause: error
      });
    }
  }
  const cli = await import(pathToFileURL(selected.entry).href);
  if (typeof cli.dispatchDeskCli !== 'function') {
    throw new Error(`Desk CLI entry does not export dispatchDeskCli: ${selected.entry}`);
  }
  process.exitCode = await cli.dispatchDeskCli(process.argv.slice(2));
}

function isDirectExecution() {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined || !existsSync(invokedPath)) {
    return false;
  }
  return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  runDeskCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
