import { describe, expect, test } from 'vitest';
import { constants, type BigIntStats } from 'node:fs';
import { mkdir, mkdtemp, open, opendir, realpath, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Pins the OS-level descriptor-alias semantics that providerSessionEvidence's
// trusted-directory traversal depends on, and prints them on whichever runner
// executes (both macOS architectures included). It is the standing, in-suite
// form of the one-run Darwin diagnostic requested during PR review: capture the
// original directory stat versus the fd-alias reopen (every field), the
// alias-as-directory opendir result, and child traversal through the alias.
//
// Load-bearing invariants (asserted on every platform):
//  * The fd alias reopened read-only observes the SAME directory inode
//    (dev+ino) -- this is the capability identity the alias probe relies on,
//    and it must hold even where the size/mtime snapshot legitimately differs.
//  * The real validated path is fully traversable -- opendir + child lstat/open
//    succeed. This is the traversal base macOS now uses (Node exposes no
//    openat, and the macOS fdesc alias cannot be traversed).
// The alias-as-directory traversal is asserted only on Linux, where the alias
// is a magic symlink and the code keeps using it. The darwin result is printed
// (to confirm the fdesc non-traversability root cause) but not hard-asserted,
// so a future OS change cannot fail a build whose code is already correct.

interface StatFields {
  isDirectory: boolean;
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

function statFields(metadata: BigIntStats): StatFields {
  return {
    isDirectory: metadata.isDirectory(),
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    size: metadata.size.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
    ctimeNs: metadata.ctimeNs.toString()
  };
}

async function probe<T>(action: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : String(error);
    return { ok: false, code };
  }
}

describe('descriptor-alias platform semantics', () => {
  test('fd alias keeps directory inode identity; real path is traversable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'desk-fdesc-probe-'));
    const childName = 'child';
    const childPath = path.join(root, childName);
    await mkdir(childPath);

    const handle = await open(
      root,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0)
    );
    const aliasPath = `/dev/fd/${handle.fd}`;
    const aliasChildPath = `${aliasPath}/${childName}`;

    try {
      const original = statFields(await lstat(root, { bigint: true }));

      const aliasReopen = await probe(async () => {
        const reopened = await open(aliasPath, constants.O_RDONLY);
        try {
          return statFields(await reopened.stat({ bigint: true }));
        } finally {
          await reopened.close();
        }
      });

      const aliasOpendir = await probe(async () => {
        const dir = await opendir(aliasPath);
        await dir.close();
        return 'opened';
      });
      const aliasChildLstat = await probe(async () => {
        const meta = await lstat(aliasChildPath, { bigint: true });
        return { dev: meta.dev.toString(), ino: meta.ino.toString() };
      });
      const aliasChildRealpath = await probe(() => realpath(aliasChildPath));
      const aliasChildOpen = await probe(async () => {
        const opened = await open(aliasChildPath, constants.O_RDONLY);
        await opened.close();
        return 'opened';
      });

      const realOpendir = await probe(async () => {
        const dir = await opendir(root);
        await dir.close();
        return 'opened';
      });
      const realChildLstat = await probe(async () => {
        const meta = await lstat(childPath, { bigint: true });
        return { dev: meta.dev.toString(), ino: meta.ino.toString() };
      });
      const realChildOpen = await probe(async () => {
        const opened = await open(
          childPath,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0)
        );
        await opened.close();
        return 'opened';
      });

      // Emit the full diagnostic so the CI log of any runner (both macOS
      // architectures included) records the ground-truth semantics.
      console.error(
        `[descriptor-alias-probe] ${JSON.stringify({
          platform: process.platform,
          arch: process.arch,
          aliasPath,
          original,
          aliasReopen,
          aliasOpendir,
          aliasChildLstat,
          aliasChildRealpath,
          aliasChildOpen,
          realOpendir,
          realChildLstat,
          realChildOpen
        })}`
      );

      // Capability identity: the alias reopen names the same directory inode.
      expect(aliasReopen.ok).toBe(true);
      if (aliasReopen.ok) {
        expect(aliasReopen.value.isDirectory).toBe(true);
        expect(aliasReopen.value.dev).toBe(original.dev);
        expect(aliasReopen.value.ino).toBe(original.ino);
      }

      // The real validated path is the traversal base macOS relies on.
      expect(realOpendir.ok).toBe(true);
      expect(realChildLstat.ok).toBe(true);
      expect(realChildOpen.ok).toBe(true);
      if (realChildLstat.ok) {
        expect(realChildLstat.value.dev).toBe(original.dev);
      }

      // On Linux the alias is a magic symlink the code still traverses.
      if (process.platform === 'linux') {
        expect(aliasOpendir.ok).toBe(true);
        expect(aliasChildOpen.ok).toBe(true);
      }
    } finally {
      await handle.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
