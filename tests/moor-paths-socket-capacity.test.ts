import { describe, expect, test } from 'vitest';
import path from 'node:path';
import {
  moorRendezvousPath,
  rendezvousPathWithinCapacity,
  resolveMoorSocketRoot,
  unixSocketPathCapacity
} from '../src/shared/moorPaths.js';

// The Unix-domain rendezvous is addressed by Desk's absolute node:net connect,
// so its byte length must fit sockaddr_un.sun_path: 104 bytes on macOS
// (capacity 103) and 108 on Linux (capacity 107). Moor itself binds/connects
// relative to the parent (spec 2.2), so the ceiling binds only the absolute
// client -- Desk. These are pure checks over the shared derivation, runnable on
// any host; the hosted macOS native lane is the end-to-end witness.

const SESSION_ID_MAX_LEN = 64; // sessionId grammar: ^[a-z][a-z0-9-]{2,63}$

describe('unix socket rendezvous capacity', () => {
  test('capacity is the platform sun_path bound minus the NUL', () => {
    expect(unixSocketPathCapacity('darwin')).toBe(103);
    expect(unixSocketPathCapacity('linux')).toBe(107);
  });

  test('accepts a path at the ceiling and rejects one byte over, per platform', () => {
    const at103 = 'a'.repeat(103);
    const at104 = 'a'.repeat(104);
    const at107 = 'a'.repeat(107);
    const at108 = 'a'.repeat(108);

    expect(rendezvousPathWithinCapacity(at103, 'darwin')).toBe(true);
    expect(rendezvousPathWithinCapacity(at104, 'darwin')).toBe(false);
    // The extra Linux headroom is real: 104 fits on Linux, not on macOS.
    expect(rendezvousPathWithinCapacity(at104, 'linux')).toBe(true);
    expect(rendezvousPathWithinCapacity(at107, 'linux')).toBe(true);
    expect(rendezvousPathWithinCapacity(at108, 'linux')).toBe(false);
  });

  test('measures bytes, not characters (multibyte names cost more)', () => {
    // A 60-code-point name of 2-byte characters is 120 bytes -- over both ceilings.
    const multibyte = 'ä'.repeat(60);
    expect(multibyte.length).toBe(60);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBe(120);
    expect(rendezvousPathWithinCapacity(multibyte, 'linux')).toBe(false);
    expect(rendezvousPathWithinCapacity(multibyte, 'darwin')).toBe(false);
  });

  test('the macOS default root is a short /tmp base, not os.tmpdir()/var/folders', () => {
    const root = resolveMoorSocketRoot({}, 'darwin');
    expect(root.startsWith('/tmp/desk-moor-')).toBe(true);
    expect(root).not.toContain('/var/folders');
  });

  test('an explicit DESK_MOOR_SOCKET_ROOT is honored verbatim on every platform', () => {
    const explicit = '/run/user/1000/desk-sockets';
    expect(resolveMoorSocketRoot({ DESK_MOOR_SOCKET_ROOT: explicit }, 'darwin')).toBe(explicit);
    expect(resolveMoorSocketRoot({ DESK_MOOR_SOCKET_ROOT: explicit }, 'linux')).toBe(explicit);
  });

  test('the full sessionId grammar fits under the default macOS root', () => {
    // The darwin base is a fixed /tmp, so this computation is identical to the
    // real macOS production path (same base, same per-uid segment) and proves
    // the worst-case 64-char session id stays addressable there.
    const root = resolveMoorSocketRoot({}, 'darwin');
    const worstCaseId = `a${'a'.repeat(SESSION_ID_MAX_LEN - 1)}`;
    expect(worstCaseId.length).toBe(SESSION_ID_MAX_LEN);
    const rendezvous = moorRendezvousPath(root, worstCaseId);
    expect(rendezvousPathWithinCapacity(rendezvous, 'darwin')).toBe(true);
  });

  test('the retired /var/folders macOS root overran the ceiling for long ids', () => {
    // Documents why the root moved: os.tmpdir() on macOS is a ~50-byte
    // /var/folders/<...>/T path, which with the per-uid segment and a long
    // session id exceeds the 103-byte ceiling -- the ready-but-unaddressable
    // split this disposition removes.
    const legacyRoot = path.join(
      '/var/folders/xy/abcdefghijklmnopqrstuvwx0000/T',
      'desk-moor-501'
    );
    const rendezvous = moorRendezvousPath(legacyRoot, `a${'a'.repeat(SESSION_ID_MAX_LEN - 1)}`);
    expect(rendezvousPathWithinCapacity(rendezvous, 'darwin')).toBe(false);
  });
});
