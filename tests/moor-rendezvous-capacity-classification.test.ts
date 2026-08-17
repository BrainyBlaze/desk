import { describe, expect, test } from 'vitest';
import { probeRendezvous } from '../src/server/runtime/sessionManager.js';
import {
  MoorMasterClient,
  MoorRendezvousCapacityError
} from '../src/server/runtime/moorMasterClient.js';

// Every direct node:net Unix-socket client must classify an over-capacity
// absolute rendezvous as UNADDRESSABLE, never as positively absent. libuv
// truncates such a path into sockaddr_un and connect(2) fails ENOENT on a
// spelling no holder bound, so a naive client would report false absence and
// (for the presence probe) violate the three-valued liveness contract, or (for
// the reset cleanup) unlink a possibly-live holder's socket. Moor itself binds
// and connects relative to the rendezvous parent (spec 2.2), so these ceilings
// bind only Desk's absolute clients.

// >107 bytes exceeds even the Linux ceiling (macOS is 103); lexically resolved
// and absolute, so it clears identity validation and reaches the capacity gate.
const OVER_CAPACITY_PATH = `/tmp/${'d'.repeat(120)}/oversize-session`;

describe('over-capacity rendezvous classification', () => {
  test('probeRendezvous classifies an over-capacity path indeterminate, not stale', async () => {
    await expect(probeRendezvous(OVER_CAPACITY_PATH)).resolves.toBe('indeterminate');
  });

  test('probeRendezvous still proves POSITIVE staleness for a short absent path', async () => {
    // Control: the change is scoped to the capacity ceiling. A short path with
    // no listener is genuinely, positively stale via a real connect refusal.
    const shortAbsent = `/tmp/desk-capacity-control-${process.pid}.sock`;
    await expect(probeRendezvous(shortAbsent)).resolves.toBe('stale');
  });

  test('MoorMasterClient.connect refuses an over-capacity rendezvous before connecting', async () => {
    const client = new MoorMasterClient(OVER_CAPACITY_PATH, 2);
    await expect(client.connect()).rejects.toBeInstanceOf(MoorRendezvousCapacityError);
    // The code is NOT ENOENT/ECONNREFUSED, so callers that read those as
    // positive absence (probeMoorHolder) fall through to indeterminate.
    await expect(
      new MoorMasterClient(OVER_CAPACITY_PATH, 2).connect().catch((error) => (error as Error & { code?: string }).code)
    ).resolves.toBe('RENDEZVOUS_UNADDRESSABLE');
    client.close();
  });
});
