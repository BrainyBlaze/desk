import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { MoorPresenceAuthority } from '../src/server/runtime/moorPresenceAuthority.js';

describe('MoorPresenceAuthority', () => {
  const roots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('coalesces concurrent holder checks onto one fresh rendezvous probe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desk-moor-presence-'));
    roots.push(root);
    const path = join(root, 'session-a');
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });

    const authority = new MoorPresenceAuthority();
    const [first, second] = await Promise.all([
      authority.holderPresence(root, 'session-a'),
      authority.holderPresence(root, 'session-a')
    ]);

    expect([first, second]).toEqual(['present', 'present']);
    expect(connections).toBe(1);

    expect(await authority.holderPresence(root, 'session-a')).toBe('present');
    expect(connections).toBe(2);
  });
});
