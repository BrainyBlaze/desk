import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileProviderSessionLaunchLedger } from '../src/server/runtime/providerSessionLaunchLedger.js';

describe('provider launch ledger OB-18 adversarial review', () => {
  it('refuses u32 generation exhaustion without committing an out-of-range claim', () => {
    const root = mkdtempSync(join(tmpdir(), 'provider-launch-review-'));
    const path = join(root, 'provider-session-launch.ndjson');
    const ledger = new FileProviderSessionLaunchLedger(path, {
      createAuthorizationId: () => 'authorization-1'
    });
    try {
      const prepared = ledger.prepare({
        deskSessionId: 'desk-alpha',
        provider: 'codex',
        expectedPriorBinding: null,
        generation: 0xffff_ffff
      });
      ledger.authorize(prepared.authorizationId);

      expect(
        ledger.claim({
          deskSessionId: 'desk-alpha',
          provider: 'codex',
          currentGeneration: 0xffff_ffff,
          nextGeneration: 0x1_0000_0000
        })
      ).toEqual({ ok: false, reason: 'generation-mismatch' });
      expect(ledger.current('desk-alpha')).toEqual({
        ...prepared,
        state: 'authorized'
      });
    } finally {
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
