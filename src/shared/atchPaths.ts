// The atch socket root — ONE resolution shared by every consumer (daemon
// provisioning, running-set probes, snapshot, native channels transport). A
// diverging default in any consumer makes the running-set lie about MISSING.
//
// The default is UID-keyed: a global /tmp/desk-atch collides across OS users
// on a shared host (and a foreign-owned directory there would be an ambush).

import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
