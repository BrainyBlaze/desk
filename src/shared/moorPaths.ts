// The moor socket root — ONE resolution shared by every consumer (daemon
// provisioning, running-set probes, snapshot, native channels transport). A
// diverging default in any consumer makes the running-set lie about MISSING.
//
// The default is UID-keyed: a global /tmp/desk-moor collides across OS users
// on a shared host (and a foreign-owned directory there would be an ambush).

import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve as resolvePath } from 'node:path';
import { findPackageRoot } from './packageRoot.js';

export function resolveMoorSocketRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const explicit = env.DESK_MOOR_SOCKET_ROOT?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'nouid';
  return join(moorSocketRootBase(platform), `desk-moor-${uid}`);
}

// The default socket root's base directory. Unix-domain rendezvous paths are
// bounded by sockaddr_un.sun_path (see unixSocketPathCapacity). os.tmpdir() on
// macOS is /var/folders/<...>/T -- about 50 bytes before Desk adds
// `desk-moor-<uid>` and then `/<sessionId>`, which the 3-64 char sessionId
// grammar overruns past the 103-byte macOS ceiling, producing a holder that
// binds by leaf (spec 2.2) but that Desk's absolute node:net connect can never
// reach. /tmp (short, standard, present on both platforms) keeps the worst-case
// rendezvous within the ceiling; the per-uid root is still created 0700 and
// owner-checked by ensurePrivateSocketRoot, so the shared-/tmp hardening is
// unchanged. Linux already resolved here via os.tmpdir() === /tmp; only macOS
// moves off /var/folders for the socket root.
function moorSocketRootBase(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? '/tmp' : tmpdir();
}

/**
 * Usable Unix-domain pathname bytes before the terminating NUL. sun_path is 104
 * bytes on macOS and 108 on Linux, so a bound or connected ABSOLUTE rendezvous
 * path may be at most 103 (macOS) or 107 (Linux) bytes. libuv copies a connect
 * path into sun_path with a bounded strncpy, so a longer absolute path is
 * silently truncated and connect(2) then fails ENOENT on a spelling no holder
 * published. Moor binds/connects relative to the rendezvous parent (spec 2.2),
 * so only its final component must fit there; Desk's node:net client addresses
 * the absolute path and is the party this ceiling binds.
 */
export function unixSocketPathCapacity(platform: NodeJS.Platform = process.platform): number {
  return platform === 'darwin' ? 103 : 107;
}

/**
 * Whether an absolute rendezvous path is addressable by node:net on this
 * platform. Measured in BYTES (sun_path is a byte buffer; a multibyte session
 * name costs more than its character count).
 */
export function rendezvousPathWithinCapacity(
  rendezvousPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return Buffer.byteLength(rendezvousPath, 'utf8') <= unixSocketPathCapacity(platform);
}

/**
 * A session's moor rendezvous: `<root>/<sessionId>`, no suffix — the exact
 * name the holder publishes. Four consumers derived this independently (the
 * daemon's provisioning, the reconcile target scan, the CLI's attach, the
 * holder-presence probe); one of them drifting is one of them asking about a
 * path no holder ever bound.
 */
export function moorRendezvousPath(root: string, sessionId: string): string {
  return join(root, sessionId);
}

/**
 * Is the rendezvous NAMESPACE itself usable right now — a directory this user
 * owns, at the path the daemon binds under?
 *
 * Read-only, and it exists to make a NEGATIVE answer honest rather than to
 * make a positive one. A connect(2) that fails inside a live socket root is
 * evidence about the session; the identical failure with the root swept away,
 * misconfigured, or replaced by a foreign-owned node is evidence about the
 * root. Callers use this only to downgrade a would-be absence proof to
 * "unknown" — never to upgrade anything.
 */
export function moorSocketRootUsable(root: string): boolean {
  try {
    // lstat, matching ensurePrivateSocketRoot: a planted symlink is not the
    // namespace this daemon binds under, whatever it points at.
    const stat = lstatSync(root);
    if (!stat.isDirectory()) {
      return false;
    }
    if (typeof process.getuid !== 'function') {
      return true;
    }
    return stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o700;
  } catch {
    return false;
  }
}

/**
 * Create + validate the socket root before any health/reconcile/provision:
 * the moor holder bind()s <root>/<sessionId> and fails ENOENT when the
 * parent is absent (slash-bearing names skip the holder's own mkdir). Fail closed on
 * anything that is not a private directory owned by this user — on a shared
 * /tmp a planted symlink or foreign-owned directory must never be adopted.
 */
export function ensurePrivateSocketRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root); // lstat: a planted symlink fails the directory check
  if (!stat.isDirectory()) {
    throw new Error(`moor socket root is not a directory: ${root}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`moor socket root ${root} is owned by uid ${stat.uid}, not this user — refusing to use it`);
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
    // X_OK alone passes for a DIRECTORY (execute = traverse) — a libexec/moor
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
 * The exact holder version this Desk release speaks (the wire/store contract
 * was proven against this build). Attestation pins the probe output to it.
 */
export const MOOR_ATTESTED_VERSION = 'moor 0.1.0';

/**
 * #10 protocol/build attestation: an executable file at the resolved path is
 * NOT yet a moor holder — a stale fork, a renamed tool, or an arbitrary PATH
 * squatter would pass the X_OK preflight and fail (or worse, half-work) at
 * the first provision. The probe runs the candidate's own `--version` and
 * requires the exact attested answer; anything else — wrong output, nonzero
 * exit, spawn failure, hang past the deadline — rejects the candidate.
 */
export function attestMoorBinary(
  path: string,
  probe: (
    path: string
  ) => { status: number | null; stdout: string; error?: Error } = defaultVersionProbe
): { ok: true } | { ok: false; reason: string } {
  let result: { status: number | null; stdout: string; error?: Error };
  try {
    result = probe(path);
  } catch (error) {
    return { ok: false, reason: `version probe failed to run: ${(error as Error).message}` };
  }
  if (result.error !== undefined) {
    return { ok: false, reason: `version probe failed to run: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `version probe exited ${result.status}` };
  }
  const answer = result.stdout.trim();
  if (answer !== MOOR_ATTESTED_VERSION) {
    return {
      ok: false,
      reason: `version probe answered ${JSON.stringify(answer)}, expected ${JSON.stringify(MOOR_ATTESTED_VERSION)}`
    };
  }
  return { ok: true };
}

function defaultVersionProbe(path: string): { status: number | null; stdout: string; error?: Error } {
  // The moor spec (§3) derives the --version answer from the INVOKED
  // basename, so probing a candidate under any other filename (an operator's
  // DESK_MOOR_BIN=/opt/tools/moor-v1) would answer `moor-v1 0.1.0` and fail
  // the fixed-literal attestation on the exact attested build (desk#40).
  // Probe through a canonical-basename symlink in a private temp directory:
  // execve of `<tmp>/moor` makes the binary see the canonical name. If the
  // symlink cannot be made, fall back to probing the path directly — exact
  // for every path whose basename is already `moor`.
  let probePath = path;
  let linkDir: string | undefined;
  try {
    linkDir = mkdtempSync(join(tmpdir(), '.moor-attest-'));
    const link = join(linkDir, 'moor');
    symlinkSync(resolvePath(path), link);
    probePath = link;
  } catch {
    probePath = path;
  }
  try {
    const result = spawnSync(probePath, ['--version'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      ...(result.error === undefined ? {} : { error: result.error })
    };
  } finally {
    if (linkDir !== undefined) {
      rmSync(linkDir, { recursive: true, force: true });
    }
  }
}

/**
 * The moor binary for the daemon child: DESK_MOOR_BIN wins, then the
 * same-release bundled libexec/moor when present and executable, then PATH.
 * Operator and development overrides change only which branch fires, never
 * the runtime semantics. EVERY branch is attestation-gated (#10): the
 * selected candidate must answer the exact attested `--version`, so an
 * arbitrary executable can never become the daemon's holder. An explicit
 * DESK_MOOR_BIN that fails attestation is a hard error (the operator named
 * it; silently ignoring it would mask a misconfiguration), while a failed
 * bundled/PATH candidate falls through to the next SOURCE in the fixed
 * chain — never to a weaker check.
 */
export function resolveMoorBinPath(
  fromUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  attest: typeof attestMoorBinary = attestMoorBinary
): string {
  const explicit = env.DESK_MOOR_BIN?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    // An explicit setting is preflighted, not trusted: a daemon that reports
    // healthy with an unusable moor would fail only at first provision.
    if (!isExecutableFile(explicit)) {
      throw new Error(`DESK_MOOR_BIN is not an executable file: ${explicit}`);
    }
    const attested = attest(explicit);
    if (!attested.ok) {
      throw new Error(`DESK_MOOR_BIN failed moor attestation: ${attested.reason} (${explicit})`);
    }
    return explicit;
  }
  try {
    const bundled = join(resolveReleaseRoot(fromUrl, cwd), 'libexec', 'moor');
    if (isExecutableFile(bundled) && attest(bundled).ok) {
      return bundled;
    }
  } catch {
    // no resolvable release root — PATH is still a legitimate source
  }
  // PATH scan yields an ABSOLUTE preflighted path (never the bare string
  // 'moor', which would defer the failure to the first provision).
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, 'moor');
    if (isExecutableFile(candidate) && attest(candidate).ok) {
      return candidate;
    }
  }
  throw new Error('no attested moor binary found: set DESK_MOOR_BIN, ship libexec/moor, or install moor on PATH');
}
