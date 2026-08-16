import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// Atomic text write: write to a uniquely-named temp file in the same directory,
// then rename it over the target. A rename is atomic on POSIX, so a crash mid-write
// can never leave the target truncated (the failure mode of a plain writeFileSync on
// a shared user file like ~/.claude/settings.json). The random suffix avoids the
// same-millisecond collision a pid+timestamp name would hit under concurrent writes.
export function writeTextFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

