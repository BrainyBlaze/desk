import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindProviderSessionIdentity,
  clearProviderSessionIdentity,
  readProviderSessionBinding
} from '../src/server/providerSessionBinding.js';
import { authorizeProviderSessionReset } from '../src/server/providerSessionReset.js';
import { FileProviderSessionLaunchLedger } from '../src/server/runtime/providerSessionLaunchLedger.js';

const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';

describe('provider-session reset transaction crash recovery', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function fixture(): {
    root: string;
    manifestPath: string;
    ledgerPath: string;
  } {
    const root = mkdtempSync(join(tmpdir(), 'desk-provider-reset-'));
    roots.push(root);
    const manifestPath = join(root, 'desk.yml');
    writeFileSync(
      manifestPath,
      `groups:\n  - id: main\n    sessions:\n      - name: alpha\n        cwd: ${root}\n        agent: codex\n        resume: ${OLD_ID}\n        uiMode: terminal\n        sessionId: alpha\n`
    );
    return {
      root,
      manifestPath,
      ledgerPath: join(root, 'provider-launch.ndjson')
    };
  }

  it('supersedes a same-daemon prepared failure on the next explicit reset', async () => {
    const { root, manifestPath, ledgerPath } = fixture();
    const ids = ['authorization-1', 'authorization-2'];
    const ledger = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => ids.shift() ?? 'unexpected'
    });
    await expect(
      authorizeProviderSessionReset(
        { deskSessionId: 'alpha', generation: 3, manifestPath, homeDir: root },
        {
          ledger,
          clearBinding: async () => {
            throw new Error('manifest transaction failed without daemon restart');
          }
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      reason: 'provider-session-store-failed'
    });

    await expect(
      authorizeProviderSessionReset(
        { deskSessionId: 'alpha', generation: 3, manifestPath, homeDir: root },
        { ledger }
      )
    ).resolves.toEqual({
      ok: true,
      authorizationId: 'authorization-2',
      generation: 3,
      state: 'authorized'
    });
    ledger.close();
  });

  it('reuses the same prepared authorization after a crash before manifest clear', async () => {
    const { root, manifestPath, ledgerPath } = fixture();
    let ledger = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => 'authorization-1'
    });
    const failed = await authorizeProviderSessionReset(
      { deskSessionId: 'alpha', generation: 3, manifestPath, homeDir: root },
      {
        ledger,
        clearBinding: async () => {
          throw new Error('crash before clear');
        }
      }
    );
    expect(failed).toMatchObject({
      ok: false,
      reason: 'provider-session-store-failed'
    });
    expect(ledger.current('alpha')).toMatchObject({
      authorizationId: 'authorization-1',
      state: 'prepared'
    });
    ledger.close();

    ledger = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => 'must-not-be-created'
    });
    await expect(
      authorizeProviderSessionReset(
        { deskSessionId: 'alpha', generation: 3, manifestPath, homeDir: root },
        { ledger }
      )
    ).resolves.toEqual({
      ok: true,
      authorizationId: 'authorization-1',
      generation: 3,
      state: 'authorized'
    });
    ledger.close();
  });

  it('reuses the same prepared authorization after clear but before authorize', async () => {
    const { root, manifestPath, ledgerPath } = fixture();
    let ledger = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => 'authorization-1'
    });
    await authorizeProviderSessionReset(
      { deskSessionId: 'alpha', generation: 3, manifestPath, homeDir: root },
      {
        ledger,
        clearBinding: async (input) => {
          await clearProviderSessionIdentity(input);
          throw new Error('crash after clear');
        }
      }
    );
    expect(
      readProviderSessionBinding({
        deskSessionId: 'alpha',
        manifestPath,
        homeDir: root
      })
    ).toMatchObject({ ok: true, providerSessionId: null });
    ledger.close();

    ledger = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => 'must-not-be-created'
    });
    await expect(
      authorizeProviderSessionReset(
        { deskSessionId: 'alpha', generation: 3, manifestPath, homeDir: root },
        { ledger }
      )
    ).resolves.toMatchObject({
      ok: true,
      authorizationId: 'authorization-1',
      state: 'authorized'
    });
    ledger.close();
  });

  it('keeps the exact authorization prepared until post-clear continuity work is durable', async () => {
    const { root, manifestPath, ledgerPath } = fixture();
    const seen: string[] = [];
    const ledger = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => 'authorization-continuity'
    });

    await expect(
      authorizeProviderSessionReset(
        { deskSessionId: 'alpha', generation: 3, manifestPath, homeDir: root },
        {
          ledger,
          afterBindingCleared: async (authorization) => {
            seen.push(authorization.authorizationId);
            throw new Error('continuity append failed');
          }
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      reason: 'provider-session-store-failed'
    });
    expect(ledger.current('alpha')).toMatchObject({
      authorizationId: 'authorization-continuity',
      state: 'prepared'
    });
    expect(
      readProviderSessionBinding({ deskSessionId: 'alpha', manifestPath, homeDir: root })
    ).toMatchObject({ ok: true, providerSessionId: null });

    await expect(
      authorizeProviderSessionReset(
        { deskSessionId: 'alpha', generation: 3, manifestPath, homeDir: root },
        {
          ledger,
          afterBindingCleared: async (authorization) => {
            seen.push(authorization.authorizationId);
          }
        }
      )
    ).resolves.toMatchObject({
      ok: true,
      authorizationId: 'authorization-continuity',
      state: 'authorized'
    });
    expect(seen).toEqual([
      'authorization-continuity',
      'authorization-continuity'
    ]);
    ledger.close();
  });

  it('completes a bound claimed launch before superseding it with a new reset', async () => {
    const { root, manifestPath, ledgerPath } = fixture();
    const ids = ['authorization-1', 'authorization-2'];
    const ledger = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => ids.shift() ?? 'unexpected'
    });
    const prepared = ledger.prepare({
      deskSessionId: 'alpha',
      provider: 'codex',
      expectedPriorBinding: OLD_ID,
      generation: 0
    });
    ledger.authorize(prepared.authorizationId);
    ledger.claim({
      deskSessionId: 'alpha',
      provider: 'codex',
      currentGeneration: 0,
      nextGeneration: 2 // OB-18: the fresh supervised claim owns generation 2
    });
    await clearProviderSessionIdentity({
      deskSessionId: 'alpha',
      provider: 'codex',
      expectedProviderSessionId: OLD_ID,
      manifestPath,
      homeDir: root
    });
    await bindProviderSessionIdentity({
      deskSessionId: 'alpha',
      provider: 'codex',
      providerSessionId: NEW_ID,
      manifestPath,
      homeDir: root
    });

    await expect(
      authorizeProviderSessionReset(
        { deskSessionId: 'alpha', generation: 2, manifestPath, homeDir: root },
        { ledger }
      )
    ).resolves.toEqual({
      ok: true,
      authorizationId: 'authorization-2',
      generation: 2,
      state: 'authorized'
    });
    expect(ledger.current('alpha')).toMatchObject({
      authorizationId: 'authorization-2',
      expectedPriorBinding: NEW_ID,
      state: 'authorized'
    });
    expect(readFileSync(ledgerPath, 'utf8')).toContain(
      '"authorizationId":"authorization-1","deskSessionId":"alpha","provider":"codex","expectedPriorBinding":"11111111-1111-4111-8111-111111111111","generation":2,"state":"completed"'
    );
    ledger.close();
  });
});
