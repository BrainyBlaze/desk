import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

process.env.TMPDIR = realpathSync(tmpdir());
