import { delimiter, dirname } from 'node:path';

import { rgPath } from '@vscode/ripgrep';

const ripgrepDirectory = dirname(rgPath);
const pathEntries = (process.env.PATH ?? '').split(delimiter);
if (!pathEntries.includes(ripgrepDirectory)) {
  process.env.PATH = [ripgrepDirectory, ...pathEntries].join(delimiter);
}
