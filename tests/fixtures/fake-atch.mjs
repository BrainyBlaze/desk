// Minimal fake atch master for the spawn-contract test. Reads the injected
// ATCH_GENERATION env var, writes it to the given file (so the test can assert
// the daemon injected the ledger value), and opens the session socket so the
// daemon's socket-wait + attach succeed. Codec-free on purpose.
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';

const sockPath = process.argv[2];
const genOutFile = process.argv[3];
const gen = Number.parseInt(process.env.ATCH_GENERATION ?? '0', 10);
writeFileSync(genOutFile, String(gen));

const server = createServer((sock) => {
  // Accept the daemon's HELLO/ATTACH; no reply needed for the spawn-contract test.
  sock.on('error', () => sock.destroy());
});
server.listen(sockPath);

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
