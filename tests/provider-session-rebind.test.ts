import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readManifestFile } from '../src/core/config.js';
import { replaceProviderSessionIdentity } from '../src/server/providerSessionBinding.js';
import {
  FileProviderSessionContinuityLedger,
  type ProviderSessionContinuityProvider
} from '../src/server/runtime/providerSessionContinuityLedger.js';
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

const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const LATER_ID = '33333333-3333-4333-8333-333333333333';

type EvidenceVerifier = NonNullable<
  Parameters<typeof createTerminalDaemon>[0]['verifyProviderSessionEvidence']
>;
type ManifestReplacer = NonNullable<
  Parameters<typeof createTerminalDaemon>[0]['replaceProviderSessionIdentity']
>;

interface FixtureOverrides {
  continuityLedger?: (
    root: string
  ) => FileProviderSessionContinuityLedger;
  replaceProviderSessionIdentity?: ManifestReplacer;
}

function barrier(): {
  entered: Promise<void>;
  enter: () => void;
  wait: Promise<void>;
  release: () => void;
} {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    enter: () => enter(),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release()
  };
}

describe('provider session continuity coordinator', () => {
  const roots: string[] = [];
  const daemons: TerminalDaemon[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const daemon of daemons.splice(0)) daemon.dispose();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function fixture(
    provider: ProviderSessionContinuityProvider,
    resume?: string,
    verifyProviderSessionEvidence?: EvidenceVerifier,
    overrides: FixtureOverrides = {}
  ): { root: string; manifestPath: string; daemon: TerminalDaemon } {
    const root = mkdtempSync(join(tmpdir(), 'desk-provider-rebind-'));
    roots.push(root);
    const manifestPath = join(root, 'desk.yml');
    writeFileSync(
      manifestPath,
      `groups:\n  - id: main\n    sessions:\n      - name: alpha\n        cwd: ${root}\n        agent: ${provider}\n${
        resume === undefined ? '' : `        resume: ${resume}\n`
      }        uiMode: terminal\n        sessionId: alpha\n`
    );
    const daemon = createTerminalDaemon({
      homeRoot: root,
      moorBinPath: '/bin/false',
      moorSocketRoot: root,
      httpServer: new FakeUpgradeServer(),
      manifestPath,
      homeDir: root,
      now: () => Date.now() - 1_000,
      ...(verifyProviderSessionEvidence === undefined
        ? {}
        : { verifyProviderSessionEvidence }),
      ...(overrides.continuityLedger === undefined
        ? {}
        : {
            providerSessionContinuityLedger:
              overrides.continuityLedger(root)
          }),
      ...(overrides.replaceProviderSessionIdentity === undefined
        ? {}
        : {
            replaceProviderSessionIdentity:
              overrides.replaceProviderSessionIdentity
          })
    });
    daemons.push(daemon);
    return { root, manifestPath, daemon };
  }

  async function launch(
    daemon: TerminalDaemon,
    provider: ProviderSessionContinuityProvider,
    providerSessionId?: string
  ): Promise<{ generation: number; launchProof: string }> {
    let launchProof: string | undefined;
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementationOnce(
      async (sessionId, options) => {
        const decision = await options.preallocateSpawn?.({
          sessionId,
          currentGeneration: 0,
          nextGeneration: 2,
          subject: options.subject ?? { kind: 'terminal' }
        });
        if (decision !== undefined && !decision.ok) return decision;
        launchProof = decision?.launchContext?.providerLaunchProof;
        return daemon.router.sessions.ensure(
          sessionId,
          options.geometry,
          options.subject ?? { kind: 'terminal' }
        );
      }
    );
    const result = await daemon.provision('alpha', {
      command: [provider],
      geometry: { rows: 24, cols: 80 },
      subject: {
        kind: 'agent',
        provider,
        mode: 'terminal',
        producer: provider === 'codex' ? 'codex-hooks' : 'claude-hooks'
      },
      ...(providerSessionId === undefined ? {} : { providerSessionId })
    });
    expect(result).toMatchObject({ ok: true, generation: 2 });
    expect(launchProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    vi.spyOn(daemon.router.sessions, 'moorStatus').mockReturnValue({
      generation: 2,
      running: true
    } as never);
    return { generation: 2, launchProof: launchProof! };
  }

  function writeEvidence(
    root: string,
    provider: ProviderSessionContinuityProvider,
    providerSessionId: string
  ): void {
    if (provider === 'codex') {
      const path = join(
        root,
        '.codex',
        'sessions',
        '2026',
        '08',
        '14',
        `rollout-2026-08-14T00-00-00-${providerSessionId}.jsonl`
      );
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(
        path,
        `${JSON.stringify({
          type: 'session_meta',
          payload: { id: providerSessionId, cwd: root }
        })}\n`
      );
      return;
    }
    const path = join(
      root,
      '.claude',
      'projects',
      root.replace(/[^A-Za-z0-9._-]/g, '-'),
      `${providerSessionId}.jsonl`
    );
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'queue-operation', sessionId: providerSessionId }),
        JSON.stringify({ type: 'user', sessionId: providerSessionId, cwd: root })
      ].join('\n') + '\n'
    );
  }

  function manifestResume(manifestPath: string): string | undefined {
    return readManifestFile(manifestPath).groups[0]?.sessions[0]?.resume;
  }

  it.each(['codex', 'claude'] as const)(
    'binds a fresh %s identity only from current proof, live Moor, and durable evidence',
    async (provider) => {
      const { root, manifestPath, daemon } = fixture(provider);
      const launched = await launch(daemon, provider);
      writeEvidence(root, provider, NEW_ID);

      await expect(
        daemon.observeProviderSessionIdentity({
          deskSessionId: 'alpha',
          provider,
          providerSessionId: NEW_ID,
          generation: launched.generation,
          launchProof: launched.launchProof,
          hook: 'SessionStart'
        })
      ).resolves.toMatchObject({ ok: true, kind: 'bound' });
      expect(manifestResume(manifestPath)).toBe(NEW_ID);

      await expect(
        daemon.observeProviderSessionIdentity({
          deskSessionId: 'alpha',
          provider,
          providerSessionId: NEW_ID,
          generation: launched.generation,
          launchProof: launched.launchProof,
          hook: 'Stop'
        })
      ).resolves.toMatchObject({ ok: true, kind: 'matching' });
    }
  );

  it('keeps OLD and pending when the write-ahead authorization append fails, then retries safely', async () => {
    let failAuthorization = false;
    const verifier: EvidenceVerifier = async (raw) => {
      const input = raw as {
        provider: 'codex';
        providerSessionId: string;
      };
      return {
        ok: true,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        evidencePath: '/safe/codex/new.jsonl'
      };
    };
    const { root, manifestPath, daemon } = fixture('codex', OLD_ID, verifier, {
      continuityLedger: (ledgerRoot) => {
        const ledger = new FileProviderSessionContinuityLedger(
          join(
            ledgerRoot,
            '_engine',
            'provider-session-continuity.ndjson'
          )
        );
        const resolve = ledger.resolveTransition.bind(ledger);
        vi.spyOn(ledger, 'resolveTransition').mockImplementation((input) => {
          if (failAuthorization) {
            failAuthorization = false;
            throw new Error('simulated continuity fsync failure');
          }
          return resolve(input);
        });
        return ledger;
      }
    });
    const launched = await launch(daemon, 'codex', OLD_ID);
    await daemon.observeProviderSessionIdentity({
      deskSessionId: 'alpha',
      provider: 'codex',
      providerSessionId: NEW_ID,
      generation: launched.generation,
      launchProof: launched.launchProof,
      hook: 'SessionStart'
    });
    failAuthorization = true;

    await expect(
      daemon.rebindProviderSession({
        deskSessionId: 'alpha',
        targetProviderSessionId: NEW_ID
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: 'provider-session-store-failed'
    });
    expect(manifestResume(manifestPath)).toBe(OLD_ID);
    const replayed = new FileProviderSessionContinuityLedger(
      join(root, '_engine', 'provider-session-continuity.ndjson'),
      { readOnly: true }
    );
    expect(replayed.currentTransition('alpha')).toMatchObject({
      state: 'pending',
      expectedProviderSessionId: OLD_ID,
      observedProviderSessionId: NEW_ID
    });
    replayed.close();
    await expect(
      daemon.rebindProviderSession({
        deskSessionId: 'alpha',
        targetProviderSessionId: NEW_ID
      })
    ).resolves.toMatchObject({ ok: true, kind: 'rebound' });
    expect(manifestResume(manifestPath)).toBe(NEW_ID);
  });

  it('replays durable authorization after manifest failure, stays fenced, and applies on retry', async () => {
    let failManifest = true;
    const verifier: EvidenceVerifier = async (raw) => {
      const input = raw as {
        provider: 'codex';
        providerSessionId: string;
      };
      return {
        ok: true,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        evidencePath: '/safe/codex/new.jsonl'
      };
    };
    const replace: ManifestReplacer = vi.fn(async (input) => {
      if (failManifest) {
        failManifest = false;
        throw new Error('simulated manifest persistence failure');
      }
      return replaceProviderSessionIdentity(input);
    });
    const { root, manifestPath, daemon } = fixture(
      'codex',
      OLD_ID,
      verifier,
      { replaceProviderSessionIdentity: replace }
    );
    const launched = await launch(daemon, 'codex', OLD_ID);
    await daemon.observeProviderSessionIdentity({
      deskSessionId: 'alpha',
      provider: 'codex',
      providerSessionId: NEW_ID,
      generation: launched.generation,
      launchProof: launched.launchProof,
      hook: 'SessionStart'
    });
    await expect(
      daemon.rebindProviderSession({
        deskSessionId: 'alpha',
        targetProviderSessionId: NEW_ID
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: 'provider-session-store-failed'
    });
    expect(manifestResume(manifestPath)).toBe(OLD_ID);

    const authorized = new FileProviderSessionContinuityLedger(
      join(root, '_engine', 'provider-session-continuity.ndjson'),
      { readOnly: true }
    );
    expect(authorized.currentTransition('alpha')).toMatchObject({
      state: 'resolved',
      expectedProviderSessionId: OLD_ID,
      observedProviderSessionId: NEW_ID
    });
    authorized.close();
    daemon.dispose();

    const restarted = createTerminalDaemon({
      homeRoot: root,
      moorBinPath: '/bin/false',
      moorSocketRoot: root,
      httpServer: new FakeUpgradeServer(),
      manifestPath,
      homeDir: root,
      verifyProviderSessionEvidence: verifier,
      replaceProviderSessionIdentity: replace
    });
    daemons.push(restarted);
    vi.spyOn(
      restarted.router.sessions,
      'spawnAndAttachMoor'
    ).mockImplementationOnce(async (sessionId, options) => {
      const decision = await options.preallocateSpawn?.({
        sessionId,
        currentGeneration: 2,
        nextGeneration: 3,
        subject: options.subject ?? { kind: 'terminal' }
      });
      return decision ?? { ok: false, reason: 'spawn-failed' };
    });
    await expect(
      restarted.provision('alpha', {
        command: ['codex', 'resume', OLD_ID],
        geometry: { rows: 24, cols: 80 },
        subject: {
          kind: 'agent',
          provider: 'codex',
          mode: 'terminal',
          producer: 'codex-hooks'
        },
        providerSessionId: OLD_ID
      })
    ).resolves.toMatchObject({
      ok: false,
      detail: 'provider-session-rebind-required'
    });
    vi.spyOn(restarted.router.sessions, 'moorStatus').mockReturnValue({
      generation: 2,
      running: true
    } as never);
    await expect(
      restarted.rebindProviderSession({
        deskSessionId: 'alpha',
        targetProviderSessionId: NEW_ID
      })
    ).resolves.toMatchObject({ ok: true, kind: 'rebound' });
    expect(manifestResume(manifestPath)).toBe(NEW_ID);
  });

  it('rejects generation-only authority before evidence lookup or manifest mutation', async () => {
    const { root, manifestPath, daemon } = fixture('codex');
    const launched = await launch(daemon, 'codex');
    writeEvidence(root, 'codex', NEW_ID);

    const result = await daemon.observeProviderSessionIdentity({
      deskSessionId: 'alpha',
      provider: 'codex',
      providerSessionId: NEW_ID,
      generation: launched.generation,
      launchProof: 'A'.repeat(43),
      hook: 'SessionStart'
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'provider-session-proof-invalid'
    });
    expect(manifestResume(manifestPath)).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(launched.launchProof);
  });

  it.each(['codex', 'claude'] as const)(
    'stages a proven %s manual resume, blocks relaunch, and self-heals only through explicit rebind',
    async (provider) => {
    const { root, manifestPath, daemon } = fixture(provider, OLD_ID);
    const launched = await launch(daemon, provider, OLD_ID);
    writeEvidence(root, provider, NEW_ID);

    const mismatch = await daemon.observeProviderSessionIdentity({
      deskSessionId: 'alpha',
      provider,
      providerSessionId: NEW_ID,
      generation: launched.generation,
      launchProof: launched.launchProof,
      hook: 'SessionStart'
    });
    expect(mismatch).toMatchObject({
      ok: false,
      reason: 'provider-session-rebind-required',
      currentProviderSessionId: OLD_ID,
      targetProviderSessionId: NEW_ID
    });
    expect(manifestResume(manifestPath)).toBe(OLD_ID);

    vi.restoreAllMocks();
    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementationOnce(
      async (sessionId, options) => {
        const decision = await options.preallocateSpawn?.({
          sessionId,
          currentGeneration: 2,
          nextGeneration: 3,
          subject: options.subject ?? { kind: 'terminal' }
        });
        return decision ?? { ok: false, reason: 'spawn-failed' };
      }
    );
    await expect(
      daemon.provision('alpha', {
        command:
          provider === 'codex'
            ? ['codex', 'resume', OLD_ID]
            : ['claude', '--resume', OLD_ID],
        geometry: { rows: 24, cols: 80 },
        subject: {
          kind: 'agent',
          provider,
          mode: 'terminal',
          producer: provider === 'codex' ? 'codex-hooks' : 'claude-hooks'
        },
        providerSessionId: OLD_ID
      })
    ).resolves.toMatchObject({
      ok: false,
      detail: 'provider-session-rebind-required'
    });

    vi.spyOn(daemon.router.sessions, 'moorStatus').mockReturnValue({
      generation: 2,
      running: true
    } as never);
    const rebinding = await Promise.all([
      daemon.rebindProviderSession({
        deskSessionId: 'alpha',
        targetProviderSessionId: NEW_ID
      }),
      daemon.rebindProviderSession({
        deskSessionId: 'alpha',
        targetProviderSessionId: NEW_ID
      })
    ]);
    expect(rebinding).toEqual([
      expect.objectContaining({ ok: true, kind: 'rebound' }),
      expect.objectContaining({ ok: true, kind: 'already-rebound' })
    ]);
    expect(manifestResume(manifestPath)).toBe(NEW_ID);
    expect(readFileSync(manifestPath, 'utf8')).toContain(`resume: ${NEW_ID}`);
    }
  );

  it.each([
    ['wrong provider', 'claude', 2],
    ['stale generation', 'codex', 1],
    ['future generation', 'codex', 3]
  ] as const)(
    'rejects %s despite a live generation and otherwise valid evidence',
    async (_label, claimedProvider, claimedGeneration) => {
      const { root, manifestPath, daemon } = fixture('codex');
      const launched = await launch(daemon, 'codex');
      writeEvidence(root, 'codex', NEW_ID);

      const result = await daemon.observeProviderSessionIdentity({
        deskSessionId: 'alpha',
        provider: claimedProvider,
        providerSessionId: NEW_ID,
        generation: claimedGeneration,
        launchProof: launched.launchProof,
        hook: 'SessionStart'
      });

      expect(result).toMatchObject({ ok: false });
      expect(manifestResume(manifestPath)).toBeUndefined();
    }
  );

  it('serializes a mismatch observation before a racing rebind of that exact target', async () => {
    const gate = barrier();
    const verifier: EvidenceVerifier = async (raw) => {
      const input = raw as {
        provider: 'codex';
        providerSessionId: string;
      };
      gate.enter();
      await gate.wait;
      return {
        ok: true,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        evidencePath: '/safe/codex/new.jsonl'
      };
    };
    const { manifestPath, daemon } = fixture('codex', OLD_ID, verifier);
    const launched = await launch(daemon, 'codex', OLD_ID);

    const observed = daemon.observeProviderSessionIdentity({
      deskSessionId: 'alpha',
      provider: 'codex',
      providerSessionId: NEW_ID,
      generation: launched.generation,
      launchProof: launched.launchProof,
      hook: 'SessionStart'
    });
    await gate.entered;
    const rebound = daemon.rebindProviderSession({
      deskSessionId: 'alpha',
      targetProviderSessionId: NEW_ID
    });
    gate.release();

    await expect(observed).resolves.toMatchObject({
      ok: false,
      reason: 'provider-session-rebind-required'
    });
    await expect(rebound).resolves.toMatchObject({
      ok: true,
      kind: 'rebound'
    });
    expect(manifestResume(manifestPath)).toBe(NEW_ID);
  });

  it.each(['observe-first', 'rebind-first'] as const)(
    'serializes a superseding mismatch and prior rebind in %s order',
    async (order) => {
      let blockedTarget: string | undefined;
      let gate: ReturnType<typeof barrier> | undefined;
      const verifier: EvidenceVerifier = async (raw) => {
        const input = raw as {
          provider: 'codex';
          providerSessionId: string;
        };
        if (input.providerSessionId === blockedTarget && gate) {
          gate.enter();
          await gate.wait;
        }
        return {
          ok: true,
          provider: input.provider,
          providerSessionId: input.providerSessionId,
          evidencePath: `/safe/codex/${input.providerSessionId}.jsonl`
        };
      };
      const { manifestPath, daemon } = fixture('codex', OLD_ID, verifier);
      const launched = await launch(daemon, 'codex', OLD_ID);
      await daemon.observeProviderSessionIdentity({
        deskSessionId: 'alpha',
        provider: 'codex',
        providerSessionId: NEW_ID,
        generation: launched.generation,
        launchProof: launched.launchProof,
        hook: 'SessionStart'
      });

      gate = barrier();
      blockedTarget = order === 'observe-first' ? LATER_ID : NEW_ID;
      const observeLater = () =>
        daemon.observeProviderSessionIdentity({
          deskSessionId: 'alpha',
          provider: 'codex',
          providerSessionId: LATER_ID,
          generation: launched.generation,
          launchProof: launched.launchProof,
          hook: 'SessionStart'
        });
      const rebindNew = () =>
        daemon.rebindProviderSession({
          deskSessionId: 'alpha',
          targetProviderSessionId: NEW_ID
        });
      const first = order === 'observe-first' ? observeLater() : rebindNew();
      await gate.entered;
      const second = order === 'observe-first' ? rebindNew() : observeLater();
      gate.release();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      if (order === 'observe-first') {
        expect(firstResult).toMatchObject({
          ok: false,
          reason: 'provider-session-rebind-required'
        });
        expect(secondResult).toMatchObject({
          ok: false,
          reason: 'provider-session-transition-mismatch'
        });
        expect(manifestResume(manifestPath)).toBe(OLD_ID);
      } else {
        expect(firstResult).toMatchObject({ ok: true, kind: 'rebound' });
        expect(secondResult).toMatchObject({
          ok: false,
          reason: 'provider-session-rebind-required'
        });
        expect(manifestResume(manifestPath)).toBe(NEW_ID);
      }
    }
  );

  it.each(['observe-first', 'reset-first'] as const)(
    'serializes observation and provider reset in %s order',
    async (order) => {
      let blockEvidence = order === 'observe-first';
      const evidenceGate = barrier();
      const resetGate = barrier();
      const verifier: EvidenceVerifier = async (raw) => {
        const input = raw as {
          provider: 'codex';
          providerSessionId: string;
        };
        if (blockEvidence) {
          evidenceGate.enter();
          await evidenceGate.wait;
        }
        return {
          ok: true,
          provider: input.provider,
          providerSessionId: input.providerSessionId,
          evidencePath: '/safe/codex/new.jsonl'
        };
      };
      const { manifestPath, daemon } = fixture('codex', OLD_ID, verifier);
      const launched = await launch(daemon, 'codex', OLD_ID);
      let live = true;
      vi.mocked(daemon.router.sessions.moorStatus).mockImplementation(() => ({
        generation: 2,
        running: live
      }) as never);
      vi.spyOn(
        daemon.router.sessions,
        'resetForProviderSession'
      ).mockImplementation(async (_sessionId, _socketPath, transaction) => {
        if (order === 'reset-first') {
          live = false;
          resetGate.enter();
          await resetGate.wait;
        }
        const value = await transaction(2);
        return { ok: true, generation: 2, value };
      });
      const observe = () =>
        daemon.observeProviderSessionIdentity({
          deskSessionId: 'alpha',
          provider: 'codex',
          providerSessionId: NEW_ID,
          generation: launched.generation,
          launchProof: launched.launchProof,
          hook: 'SessionStart'
        });

      if (order === 'observe-first') {
        const observed = observe();
        await evidenceGate.entered;
        const reset = daemon.resetProviderSession('alpha');
        blockEvidence = false;
        evidenceGate.release();
        await expect(observed).resolves.toMatchObject({
          ok: false,
          reason: 'provider-session-rebind-required'
        });
        await expect(reset).resolves.toMatchObject({
          ok: true,
          state: 'authorized'
        });
      } else {
        const reset = daemon.resetProviderSession('alpha');
        await resetGate.entered;
        const observed = observe();
        await expect(observed).resolves.toMatchObject({
          ok: false,
          reason: 'provider-session-not-live'
        });
        resetGate.release();
        await expect(reset).resolves.toMatchObject({
          ok: true,
          state: 'authorized'
        });
      }
      expect(manifestResume(manifestPath)).toBeUndefined();
      await expect(
        daemon.rebindProviderSession({
          deskSessionId: 'alpha',
          targetProviderSessionId: NEW_ID
        })
      ).resolves.toMatchObject({
        ok: false,
        reason: 'provider-session-transition-missing'
      });
    }
  );

  it.each(['rebind-first', 'reset-first'] as const)(
    'serializes rebind and provider reset in %s order',
    async (order) => {
      let blockRebind = false;
      const rebindGate = barrier();
      const resetGate = barrier();
      const verifier: EvidenceVerifier = async (raw) => {
        const input = raw as {
          provider: 'codex';
          providerSessionId: string;
        };
        if (blockRebind) {
          rebindGate.enter();
          await rebindGate.wait;
        }
        return {
          ok: true,
          provider: input.provider,
          providerSessionId: input.providerSessionId,
          evidencePath: '/safe/codex/new.jsonl'
        };
      };
      const { manifestPath, daemon } = fixture('codex', OLD_ID, verifier);
      const launched = await launch(daemon, 'codex', OLD_ID);
      await daemon.observeProviderSessionIdentity({
        deskSessionId: 'alpha',
        provider: 'codex',
        providerSessionId: NEW_ID,
        generation: launched.generation,
        launchProof: launched.launchProof,
        hook: 'SessionStart'
      });
      let live = true;
      vi.mocked(daemon.router.sessions.moorStatus).mockImplementation(() => ({
        generation: 2,
        running: live
      }) as never);
      vi.spyOn(
        daemon.router.sessions,
        'resetForProviderSession'
      ).mockImplementation(async (_sessionId, _socketPath, transaction) => {
        if (order === 'reset-first') {
          live = false;
          resetGate.enter();
          await resetGate.wait;
        }
        const value = await transaction(2);
        return { ok: true, generation: 2, value };
      });
      blockRebind = order === 'rebind-first';
      const rebind = () =>
        daemon.rebindProviderSession({
          deskSessionId: 'alpha',
          targetProviderSessionId: NEW_ID
        });

      if (order === 'rebind-first') {
        const rebound = rebind();
        await rebindGate.entered;
        const reset = daemon.resetProviderSession('alpha');
        blockRebind = false;
        rebindGate.release();
        await expect(rebound).resolves.toMatchObject({
          ok: true,
          kind: 'rebound'
        });
        await expect(reset).resolves.toMatchObject({
          ok: true,
          state: 'authorized'
        });
      } else {
        const reset = daemon.resetProviderSession('alpha');
        await resetGate.entered;
        const rebound = rebind();
        await expect(rebound).resolves.toMatchObject({
          ok: false,
          reason: 'provider-session-not-live'
        });
        resetGate.release();
        await expect(reset).resolves.toMatchObject({
          ok: true,
          state: 'authorized'
        });
      }
      expect(manifestResume(manifestPath)).toBeUndefined();
      const replayed = new FileProviderSessionContinuityLedger(
        join(
          dirname(manifestPath),
          '_engine',
          'provider-session-continuity.ndjson'
        ),
        { readOnly: true }
      );
      expect(replayed.currentTransition('alpha')).toMatchObject({
        state: 'cancelled-by-reset',
        observedProviderSessionId: NEW_ID
      });
      replayed.close();
    }
  );

  it('keeps a resolved rebind reset-incomplete until cancellation is durable and retry authorizes fresh launch', async () => {
    let failCancellation = false;
    const verifier: EvidenceVerifier = async (raw) => {
      const input = raw as {
        provider: 'codex';
        providerSessionId: string;
      };
      return {
        ok: true,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        evidencePath: '/safe/codex/new.jsonl'
      };
    };
    const { root, manifestPath, daemon } = fixture('codex', OLD_ID, verifier, {
      continuityLedger: (ledgerRoot) => {
        const ledger = new FileProviderSessionContinuityLedger(
          join(
            ledgerRoot,
            '_engine',
            'provider-session-continuity.ndjson'
          )
        );
        const cancel = ledger.cancelTransitionByReset.bind(ledger);
        vi.spyOn(ledger, 'cancelTransitionByReset').mockImplementation(
          (input) => {
            if (failCancellation) {
              failCancellation = false;
              throw new Error(
                'simulated continuity cancellation fsync failure'
              );
            }
            return cancel(input);
          }
        );
        return ledger;
      }
    });
    const launched = await launch(daemon, 'codex', OLD_ID);
    await daemon.observeProviderSessionIdentity({
      deskSessionId: 'alpha',
      provider: 'codex',
      providerSessionId: NEW_ID,
      generation: launched.generation,
      launchProof: launched.launchProof,
      hook: 'SessionStart'
    });
    await daemon.rebindProviderSession({
      deskSessionId: 'alpha',
      targetProviderSessionId: NEW_ID
    });
    vi.spyOn(
      daemon.router.sessions,
      'resetForProviderSession'
    ).mockImplementation(async (_sessionId, _socketPath, transaction) => ({
      ok: true,
      generation: 2,
      value: await transaction(2)
    }));
    failCancellation = true;

    await expect(daemon.resetProviderSession('alpha')).resolves.toMatchObject({
      ok: false,
      reason: 'provider-session-store-failed'
    });
    expect(manifestResume(manifestPath)).toBeUndefined();
    const continuityPath = join(
      root,
      '_engine',
      'provider-session-continuity.ndjson'
    );
    let continuity = new FileProviderSessionContinuityLedger(continuityPath, {
      readOnly: true
    });
    expect(continuity.currentTransition('alpha')).toMatchObject({
      state: 'resolved',
      observedProviderSessionId: NEW_ID
    });
    continuity.close();
    let launchLedger = new FileProviderSessionLaunchLedger(
      join(root, '_engine', 'provider-session-launch.ndjson')
    );
    const prepared = launchLedger.current('alpha');
    expect(prepared).toMatchObject({ state: 'prepared', generation: 2 });
    launchLedger.close();

    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementationOnce(
      async (sessionId, options) => {
        const decision = await options.preallocateSpawn?.({
          sessionId,
          currentGeneration: 2,
          nextGeneration: 3,
          subject: options.subject ?? { kind: 'terminal' }
        });
        return decision ?? { ok: false, reason: 'spawn-failed' };
      }
    );
    await expect(
      daemon.provision('alpha', {
        command: ['codex'],
        geometry: { rows: 24, cols: 80 },
        subject: {
          kind: 'agent',
          provider: 'codex',
          mode: 'terminal',
          producer: 'codex-hooks'
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      detail: 'reset-incomplete'
    });

    await expect(daemon.resetProviderSession('alpha')).resolves.toMatchObject({
      ok: true,
      state: 'authorized',
      authorizationId: prepared?.authorizationId
    });
    continuity = new FileProviderSessionContinuityLedger(continuityPath, {
      readOnly: true
    });
    expect(continuity.currentTransition('alpha')).toMatchObject({
      state: 'cancelled-by-reset',
      resetAuthorizationId: prepared?.authorizationId
    });
    continuity.close();
    launchLedger = new FileProviderSessionLaunchLedger(
      join(root, '_engine', 'provider-session-launch.ndjson')
    );
    expect(launchLedger.current('alpha')).toMatchObject({
      state: 'authorized',
      authorizationId: prepared?.authorizationId
    });
    launchLedger.close();

    vi.spyOn(daemon.router.sessions, 'spawnAndAttachMoor').mockImplementationOnce(
      async (sessionId, options) => {
        const decision = await options.preallocateSpawn?.({
          sessionId,
          currentGeneration: 2,
          nextGeneration: 3,
          subject: options.subject ?? { kind: 'terminal' }
        });
        if (decision !== undefined && !decision.ok) return decision;
        return { ok: true, generation: 3, created: true };
      }
    );
    await expect(
      daemon.provision('alpha', {
        command: ['codex'],
        geometry: { rows: 24, cols: 80 },
        subject: {
          kind: 'agent',
          provider: 'codex',
          mode: 'terminal',
          producer: 'codex-hooks'
        }
      })
    ).resolves.toMatchObject({ ok: true, generation: 3 });
  });

  it.each([
    ['binds', undefined, 'bound'],
    ['stages', OLD_ID, 'provider-session-rebind-required']
  ] as const)(
    '%s a provider identity from a later hook only after stale SessionStart evidence becomes fresh',
    async (_label, resume, expectedOutcome) => {
      const { root, manifestPath, daemon } = fixture('claude', resume);
      const launched = await launch(daemon, 'claude', resume);
      writeEvidence(root, 'claude', NEW_ID);
      const evidencePath = join(
        root,
        '.claude',
        'projects',
        root.replace(/[^A-Za-z0-9._-]/g, '-'),
        `${NEW_ID}.jsonl`
      );
      const stale = new Date(Date.now() - 10_000);
      utimesSync(evidencePath, stale, stale);

      await expect(
        daemon.observeProviderSessionIdentity({
          deskSessionId: 'alpha',
          provider: 'claude',
          providerSessionId: NEW_ID,
          generation: launched.generation,
          launchProof: launched.launchProof,
          hook: 'SessionStart'
        })
      ).resolves.toMatchObject({
        ok: false,
        reason: 'provider-session-evidence-stale'
      });
      expect(manifestResume(manifestPath)).toBe(resume);

      await expect(
        daemon.observeProviderSessionIdentity({
          deskSessionId: 'alpha',
          provider: 'claude',
          providerSessionId: NEW_ID,
          generation: launched.generation,
          launchProof: launched.launchProof,
          hook: 'Stop'
        })
      ).resolves.toMatchObject({
        ok: false,
        reason: 'provider-session-evidence-stale'
      });
      expect(manifestResume(manifestPath)).toBe(resume);

      writeEvidence(root, 'claude', NEW_ID);
      const recovered = await daemon.observeProviderSessionIdentity({
        deskSessionId: 'alpha',
        provider: 'claude',
        providerSessionId: NEW_ID,
        generation: launched.generation,
        launchProof: launched.launchProof,
        hook: 'Stop'
      });
      if (expectedOutcome === 'bound') {
        expect(recovered).toMatchObject({ ok: true, kind: 'bound' });
        expect(manifestResume(manifestPath)).toBe(NEW_ID);
      } else {
        expect(recovered).toMatchObject({
          ok: false,
          reason: expectedOutcome,
          currentProviderSessionId: OLD_ID,
          targetProviderSessionId: NEW_ID
        });
        expect(manifestResume(manifestPath)).toBe(OLD_ID);
        await expect(
          daemon.rebindProviderSession({
            deskSessionId: 'alpha',
            targetProviderSessionId: NEW_ID
          })
        ).resolves.toMatchObject({ ok: true, kind: 'rebound' });
        expect(manifestResume(manifestPath)).toBe(NEW_ID);
      }
    }
  );
});
