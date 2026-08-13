import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  WorkerSupervisor
} from '../src/shared/runtime/workerSupervisor.js';
import { FileProviderSessionLaunchLedger } from '../src/server/runtime/providerSessionLaunchLedger.js';
import {
  createTerminalDaemon,
  type TerminalDaemon
} from '../src/server/runtime/terminalDaemon.js';

type UpgradeListener = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => void;

class FakeUpgradeServer {
  private listeners: UpgradeListener[] = [];

  on(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners.push(listener);
  }

  off(_event: 'upgrade', listener: UpgradeListener): void {
    this.listeners = this.listeners.filter((current) => current !== listener);
  }
}

const PRIOR_ID = '11111111-1111-4111-8111-111111111111';
const NEXT_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT = {
  kind: 'agent' as const,
  provider: 'codex' as const,
  mode: 'terminal' as const,
  producer: 'codex-hooks' as const
};

describe('provider-session provision fence', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function fixture(resume?: string): {
    root: string;
    manifestPath: string;
    ledgerPath: string;
  } {
    const root = mkdtempSync(join(tmpdir(), 'desk-provider-fence-'));
    roots.push(root);
    const manifestPath = join(root, 'desk.yml');
    writeFileSync(
      manifestPath,
      `groups:\n  - id: main\n    sessions:\n      - name: alpha\n        cwd: ${root}\n        agent: codex\n${
          resume === undefined ? '' : `        resume: ${resume}\n`
        }        uiMode: terminal\n        sessionId: alpha\n`
    );
    return {
      root,
      manifestPath,
      ledgerPath: join(root, '_engine', 'provider-session-launch.ndjson')
    };
  }

function daemonFor(
  root: string,
  manifestPath: string,
  supervisor?: WorkerSupervisor
): TerminalDaemon {
    return createTerminalDaemon({
      homeRoot: root,
      moorBinPath: '/bin/false',
      moorSocketRoot: root,
      httpServer: new FakeUpgradeServer(),
      manifestPath,
      homeDir: root,
      ...(supervisor === undefined ? {} : { supervisor })
    });
  }

  async function provisionAtGeneration(
    daemon: TerminalDaemon,
    currentGeneration: number,
    providerSessionId?: string
  ) {
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const decision = await options.preallocateSpawn?.({
          sessionId,
          currentGeneration,
          nextGeneration: currentGeneration + 1,
          subject: options.subject ?? { kind: 'terminal' }
        });
        if (decision !== undefined && !decision.ok) return decision;
        return {
          ok: true,
          generation: currentGeneration + 1,
          created: true
        };
      }
    );
    return daemon.provision('alpha', {
      command: ['codex'],
      geometry: { rows: 24, cols: 80 },
      subject: SUBJECT,
      ...(providerSessionId === undefined ? {} : { providerSessionId })
    });
  }

  it('lets a never-launched session start after a failed attempt moved the generation (desk#47)', async () => {
    // The generation ledger is monotonic (§4.8.1), so an attempt that died
    // before the child ever ran still advanced it. The session had no
    // conversation to protect (no binding, nothing in the launch ledger), so
    // the retry is a FIRST launch — it used to be refused forever, and
    // `reset-provider-session` could not help because the failed attempt had
    // rolled the session out of the manifest.
    const { root, manifestPath, ledgerPath } = fixture();
    const daemon = daemonFor(root, manifestPath);
    await expect(provisionAtGeneration(daemon, 2)).resolves.toMatchObject({
      ok: true,
      generation: 3
    });
    daemon.dispose();

    // Nothing was authorized or consumed: a first launch records no claim.
    const replayed = new FileProviderSessionLaunchLedger(ledgerPath);
    expect(replayed.current('alpha')).toBeUndefined();
    replayed.close();
  });

  it('still fences a relaunch once the launch ledger knows the session (desk#47 guard)', async () => {
    // The moment an authorization exists, the fence applies exactly as before:
    // an unauthorized relaunch is refused rather than silently starting a
    // second conversation.
    const { root, manifestPath, ledgerPath } = fixture();
    const seed = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => 'authorization-guard'
    });
    seed.prepare({
      deskSessionId: 'alpha',
      provider: 'codex',
      expectedPriorBinding: null,
      generation: 4
    });
    seed.close();

    const daemon = daemonFor(root, manifestPath);
    await expect(provisionAtGeneration(daemon, 9)).resolves.toMatchObject({
      ok: false,
      reason: 'provider-session-identity-missing'
    });
    daemon.dispose();
  });

  it('allows exact resume after a crash before manifest clear and terminalizes prepared', async () => {
    const { root, manifestPath, ledgerPath } = fixture(PRIOR_ID);
    const seed = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => 'authorization-1'
    });
    seed.prepare({
      deskSessionId: 'alpha',
      provider: 'codex',
      expectedPriorBinding: PRIOR_ID,
      generation: 7
    });
    seed.close();

    const daemon = daemonFor(root, manifestPath);
    await expect(
      provisionAtGeneration(daemon, 7, PRIOR_ID)
    ).resolves.toMatchObject({ ok: true, generation: 8 });
    daemon.dispose();

    const replayed = new FileProviderSessionLaunchLedger(ledgerPath);
    expect(replayed.current('alpha')).toMatchObject({
      state: 'completed',
      generation: 7,
      expectedPriorBinding: PRIOR_ID
    });
    replayed.close();
  });

  it('rejects a stale resume request after manifest clear and leaves prepared fenced', async () => {
    const { root, manifestPath, ledgerPath } = fixture();
    const seed = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => 'authorization-1'
    });
    const prepared = seed.prepare({
      deskSessionId: 'alpha',
      provider: 'codex',
      expectedPriorBinding: PRIOR_ID,
      generation: 7
    });
    seed.close();

    const daemon = daemonFor(root, manifestPath);
    await expect(provisionAtGeneration(daemon, 7, PRIOR_ID)).resolves.toEqual({
      ok: false,
      reason: 'provider-session-identity-missing',
      detail: 'binding-mismatch'
    });
    daemon.dispose();

    const replayed = new FileProviderSessionLaunchLedger(ledgerPath);
    expect(replayed.current('alpha')).toEqual(prepared);
    replayed.close();
  });

  it('claims one authorized fresh launch for the exact next generation and never reuses it', async () => {
    const { root, manifestPath, ledgerPath } = fixture();
    const seed = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => 'authorization-1'
    });
    const prepared = seed.prepare({
      deskSessionId: 'alpha',
      provider: 'codex',
      expectedPriorBinding: PRIOR_ID,
      generation: 3
    });
    seed.authorize(prepared.authorizationId);
    seed.close();

    const daemon = daemonFor(root, manifestPath);
    await expect(provisionAtGeneration(daemon, 3)).resolves.toMatchObject({
      ok: true,
      generation: 4
    });
    await expect(provisionAtGeneration(daemon, 4)).resolves.toEqual({
      ok: false,
      reason: 'provider-session-identity-missing',
      detail: 'authorization-consumed'
    });
    daemon.dispose();

    const replayed = new FileProviderSessionLaunchLedger(ledgerPath);
    expect(replayed.current('alpha')).toMatchObject({
      state: 'claimed',
      generation: 4
    });
    replayed.close();
  });

  it('keeps a claim consumed when admission fails before generation allocation', async () => {
    const { root, manifestPath, ledgerPath } = fixture();
    const seed = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => 'authorization-1'
    });
    const prepared = seed.prepare({
      deskSessionId: 'alpha',
      provider: 'codex',
      expectedPriorBinding: PRIOR_ID,
      generation: 0
    });
    seed.authorize(prepared.authorizationId);
    seed.close();

    const daemon = daemonFor(
      root,
      manifestPath,
      new WorkerSupervisor({
        ...DEFAULT_SUPERVISOR_CONFIG,
        maxLiveWorkers: 1,
        shardThreshold: 1
      })
    );
    let admitted = 0;
    for (;;) {
      const result = daemon.router.sessions.ensure(`filler-${admitted}`, {
        rows: 1,
        cols: 1
      });
      if (!result.ok) break;
      admitted += 1;
      if (admitted > 1_000) throw new Error('worker cap was not enforced');
    }
    expect(admitted).toBe(1);

    await expect(
      daemon.provision('alpha', {
        command: ['codex'],
        geometry: { rows: 24, cols: 80 },
        subject: SUBJECT
      })
    ).resolves.toEqual({ ok: false, reason: 'cap-exceeded' });
    await expect(
      daemon.provision('alpha', {
        command: ['codex'],
        geometry: { rows: 24, cols: 80 },
        subject: SUBJECT
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'provider-session-identity-missing',
      detail: 'authorization-consumed'
    });
    daemon.dispose();

    const replayed = new FileProviderSessionLaunchLedger(ledgerPath);
    expect(replayed.current('alpha')).toMatchObject({
      state: 'claimed',
      generation: 2 // OB-18: the fresh supervised claim owns generation 2
    });
    replayed.close();
  });

  it('refuses a later resume-less launch once an authorization exists, at any generation', async () => {
    // desk#47 narrowed this case. The fence used to refuse purely because the
    // generation had moved, which caught the session whose first attempt died
    // before the child ever ran and left nothing behind but a bumped counter.
    // What the fence protects is an ADDRESSABLE conversation, and Desk can
    // only address one it recorded: the manifest binding (covered by the
    // resume tests above) or the launch ledger (asserted here).
    const { root, manifestPath, ledgerPath } = fixture();
    const daemon = daemonFor(root, manifestPath);

    await expect(provisionAtGeneration(daemon, 0)).resolves.toMatchObject({
      ok: true,
      generation: 1
    });
    daemon.dispose();

    const seed = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => 'authorization-recorded'
    });
    seed.prepare({
      deskSessionId: 'alpha',
      provider: 'codex',
      expectedPriorBinding: null,
      generation: 1
    });
    seed.close();

    const fenced = daemonFor(root, manifestPath);
    // A prepared-but-unfinished reset fences with its own detail; either way
    // the launch is refused, which is the property under test.
    await expect(provisionAtGeneration(fenced, 2)).resolves.toEqual({
      ok: false,
      reason: 'provider-session-identity-missing',
      detail: 'reset-incomplete'
    });
    fenced.dispose();
  });

  it('completes a stale claimed launch after binding and permits the next exact resume', async () => {
    const { root, manifestPath, ledgerPath } = fixture(NEXT_ID);
    const seed = new FileProviderSessionLaunchLedger(ledgerPath, {
      createAuthorizationId: () => 'authorization-1'
    });
    const prepared = seed.prepare({
      deskSessionId: 'alpha',
      provider: 'codex',
      expectedPriorBinding: null,
      generation: 3
    });
    seed.authorize(prepared.authorizationId);
    seed.claim({
      deskSessionId: 'alpha',
      provider: 'codex',
      currentGeneration: 3,
      nextGeneration: 4
    });
    seed.close();

    const daemon = daemonFor(root, manifestPath);
    await expect(
      provisionAtGeneration(daemon, 4, NEXT_ID)
    ).resolves.toMatchObject({ ok: true, generation: 5 });
    daemon.dispose();

    const replayed = new FileProviderSessionLaunchLedger(ledgerPath);
    expect(replayed.current('alpha')).toMatchObject({
      state: 'completed',
      generation: 4
    });
    replayed.close();
  });

  it('requires the request identity to match the authoritative manifest binding', async () => {
    const { root, manifestPath } = fixture(PRIOR_ID);
    const daemon = daemonFor(root, manifestPath);

    await expect(provisionAtGeneration(daemon, 3)).resolves.toEqual({
      ok: false,
      reason: 'provider-session-identity-missing',
      detail: 'binding-mismatch'
    });
    daemon.dispose();
  });

  it('rejects provider identities outside the shared provider grammar', async () => {
    const { root, manifestPath } = fixture();
    const daemon = daemonFor(root, manifestPath);

    await expect(
      provisionAtGeneration(daemon, 0, 'not-a-provider-session-id')
    ).resolves.toEqual({
      ok: false,
      reason: 'provider-session-identity-missing',
      detail: 'invalid-provider-session-id'
    });
    daemon.dispose();
  });

  it('preserves non-agent provisioning at positive generations', async () => {
    const { root, manifestPath } = fixture();
    const daemon = daemonFor(root, manifestPath);
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementation(
      async (sessionId, options) => {
        const decision = await options.preallocateSpawn?.({
          sessionId,
          currentGeneration: 5,
          nextGeneration: 6,
          subject: options.subject ?? { kind: 'terminal' }
        });
        expect(decision).toEqual({ ok: true });
        return { ok: true, generation: 6, created: true };
      }
    );

    await expect(
      daemon.provision('alpha', {
        command: ['bash'],
        geometry: { rows: 24, cols: 80 },
        subject: { kind: 'terminal' }
      })
    ).resolves.toMatchObject({ ok: true, generation: 6 });
    daemon.dispose();
  });
});
