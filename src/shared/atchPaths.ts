// The atch socket root — ONE resolution shared by every consumer (daemon
// provisioning, running-set probes, snapshot, native channels transport). A
// diverging default in any consumer makes the running-set lie about MISSING.
//
// The default is UID-keyed: a global /tmp/desk-atch collides across OS users
// on a shared host (and a foreign-owned directory there would be an ambush).

import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { findPackageRoot } from './packageRoot.js';

export function resolveAtchSocketRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DESK_ATCH_SOCKET_ROOT?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'nouid';
  return join(tmpdir(), `desk-atch-${uid}`);
}

/**
 * Create + validate the socket root before any health/reconcile/provision:
 * atch's master bind()s <root>/<sessionId>.sock and fails ENOENT when the
 * parent is absent (slash-bearing names skip atch's own mkdir). Fail closed on
 * anything that is not a private directory owned by this user — on a shared
 * /tmp a planted symlink or foreign-owned directory must never be adopted.
 */
export function ensurePrivateSocketRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root); // lstat: a planted symlink fails the directory check
  if (!stat.isDirectory()) {
    throw new Error(`atch socket root is not a directory: ${root}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`atch socket root ${root} is owned by uid ${stat.uid}, not this user — refusing to use it`);
  }
  chmodSync(root, 0o700);
}

/**
 * The release root: the module's package root when the module lives on a real
 * release filesystem, else the process cwd when IT is a release root. The
 * second branch exists for the Bun-compiled standalone, whose import.meta.url
 * is a bundle-internal path — `desk serve` launches it with cwd = the release
 * root (serveCommand), so cwd is the authoritative fallback there.
 */
export function resolveReleaseRoot(fromUrl: string, cwd: string = process.cwd()): string {
  try {
    return findPackageRoot(fromUrl);
  } catch {
    if (existsSync(join(cwd, 'package.json')) && existsSync(join(cwd, 'dist', 'cli', 'main.js'))) {
      return cwd;
    }
    throw new Error('cannot locate the desk release root for the terminal daemon — set DESK_DAEMON_CMD');
  }
}

export function isExecutableFile(path: string): boolean {
  try {
    // X_OK alone passes for a DIRECTORY (execute = traverse) — a libexec/atch
    // or runtime/node directory would preflight as a binary and fail only at
    // spawn. Require a regular file too.
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The atch binary for the daemon child: DESK_ATCH_BIN wins, then the
 * same-release bundled libexec/atch when present and executable, then PATH.
 * The licensing/packaging decision (bundle vs user-installed) changes only
 * which branch fires, never the runtime semantics.
 */
export function resolveAtchBinPath(fromUrl: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const explicit = env.DESK_ATCH_BIN?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    // An explicit setting is preflighted, not trusted: a daemon that reports
    // healthy with an unusable atch would fail only at first provision.
    if (!isExecutableFile(explicit)) {
      throw new Error(`DESK_ATCH_BIN is not an executable file: ${explicit}`);
    }
    return explicit;
  }
  try {
    const bundled = join(resolveReleaseRoot(fromUrl, cwd), 'libexec', 'atch');
    if (isExecutableFile(bundled)) {
      return bundled;
    }
  } catch {
    // no resolvable release root — PATH is still a legitimate source
  }
  // PATH scan yields an ABSOLUTE preflighted path (never the bare string
  // 'atch', which would defer the failure to the first provision).
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, 'atch');
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  throw new Error('no atch binary found: set DESK_ATCH_BIN, ship libexec/atch, or install atch on PATH');
}
