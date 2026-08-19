import { createConnection } from 'node:net';

import type { MoorHolderPresence } from '../../shared/daemonControlClient.js';
import {
  moorRendezvousPath,
  moorSocketRootUsable,
  rendezvousPathWithinCapacity
} from '../../shared/moorPaths.js';

export type MoorRendezvousPresence = 'live' | 'stale' | 'indeterminate';

/**
 * Sole owner of non-adopting Moor rendezvous probes.
 *
 * Results are deliberately not cached: a completed probe is already stale.
 * Only concurrent requests for the same path are coalesced, which prevents
 * independent status consumers from multiplying kernel connections while
 * preserving a fresh observation for every later decision.
 */
export class MoorPresenceAuthority {
  private readonly inflight = new Map<string, Promise<MoorRendezvousPresence>>();

  async holderPresence(socketRoot: string, sessionId: string): Promise<MoorHolderPresence> {
    if (!moorSocketRootUsable(socketRoot)) return 'unknown';
    const outcome = await this.probeRendezvous(moorRendezvousPath(socketRoot, sessionId));
    return outcome === 'live' ? 'present' : outcome === 'stale' ? 'absent' : 'unknown';
  }

  probeRendezvous(path: string, timeoutMs = 250): Promise<MoorRendezvousPresence> {
    const current = this.inflight.get(path);
    if (current !== undefined) return current;

    const probe = this.performProbe(path, timeoutMs);
    this.inflight.set(path, probe);
    void probe.finally(() => {
      if (this.inflight.get(path) === probe) this.inflight.delete(path);
    });
    return probe;
  }

  private async performProbe(
    path: string,
    timeoutMs: number
  ): Promise<MoorRendezvousPresence> {
    if (!rendezvousPathWithinCapacity(path)) return 'indeterminate';
    return new Promise((resolve) => {
      const socket = createConnection({ path });
      const settle = (result: MoorRendezvousPresence): void => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(timeoutMs, () => settle('indeterminate'));
      socket.once('connect', () => settle('live'));
      socket.once('error', (error: NodeJS.ErrnoException) => {
        settle(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'stale' : 'indeterminate');
      });
    });
  }
}
