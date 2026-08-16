// Regression witness for the macOS supervised-launch bug (Desk-side): the
// /dev/fd descriptor alias must be re-opened WITHOUT O_DIRECTORY. On macOS
// open('/dev/fd/N', O_DIRECTORY) fails ENOTDIR even for a directory
// descriptor (the fdesc node is not a directory vnode), so every supervised
// launch failed there while Linux (/proc magic symlink) passed. The macOS
// native lane is the end-to-end guard; this source-level assertion catches a
// re-introduction on EVERY CI, not only the Mac lane, and states the property
// in one place. Intercepting the fs open flags at runtime is not reliable for
// a direct ESM named import, and a Linux run cannot reproduce the macOS
// ENOTDIR (Linux /dev/fd IS a symlink), so the property is pinned on the source
// of the one function that performs the alias re-open.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/server/runtime/moorGenerationStores.ts', import.meta.url)),
  'utf8'
);

describe('openBoundParent descriptor-alias re-open (macOS supervised-launch regression)', () => {
  it('opens moorDescriptorDirectoryAlias with O_RDONLY only, never O_DIRECTORY', () => {
    // The single call that re-opens the descriptor alias. It must not carry
    // O_DIRECTORY; identity is proven by the sameFile/requirePrivateDirectory
    // checks that follow, which work on both Linux and macOS.
    const aliasOpen = /open\(\s*moorDescriptorDirectoryAlias\([^)]*\)\s*,([^)]*)\)/m.exec(SOURCE);
    expect(aliasOpen, 'the alias re-open call must exist').not.toBeNull();
    const flags = aliasOpen![1];
    expect(flags).toContain('O_RDONLY');
    expect(flags).not.toContain('O_DIRECTORY');
  });

  it('still guards the real bound path with O_DIRECTORY (the alias change is scoped)', () => {
    // The bound-path open (not the /dev/fd alias) keeps O_DIRECTORY: it is a
    // real filesystem path where the directory-type check is correct on both
    // platforms. This pins that the fix did not weaken the path open.
    expect(SOURCE).toMatch(/\bpath,\s*constants\.O_RDONLY[^;]*O_DIRECTORY/m);
  });
});
