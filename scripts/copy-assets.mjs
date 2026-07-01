import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const assets = [
  {
    from: join(root, 'src', 'core', 'opencode'),
    to: join(root, 'dist', 'core', 'opencode')
  }
];

for (const asset of assets) {
  mkdirSync(dirname(asset.to), { recursive: true });
  cpSync(asset.from, asset.to, { recursive: true });
}
