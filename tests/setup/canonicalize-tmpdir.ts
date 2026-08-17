import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

// On macOS os.tmpdir() is a ~50-byte /var/folders/<...>/T path. A test fixture
// that builds its own Unix-domain listener under it -- <tmp>/.../<sessionId> --
// then overruns the 103-byte sockaddr_un.sun_path ceiling, so node:net truncates
// the address and the fixture's bind/chmod/connect target diverges from the file
// it created. Production is unaffected: it already resolves a short /tmp socket
// root on Darwin and guards the launch. A short per-user /tmp base keeps every
// fixture's socket path addressable at once; Linux os.tmpdir() is already short.
// The base is created private (0700) and canonicalized below like any other.
if (process.platform === 'darwin') {
  const base = `/tmp/desk-tests-${typeof process.getuid === 'function' ? process.getuid() : 'nouid'}`;
  mkdirSync(base, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = base;
}

process.env.TMPDIR = realpathSync(tmpdir());
