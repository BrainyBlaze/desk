import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSpec } from '../src/core/types.js';
import { readProviderSessionContinuityStatus } from '../src/server/providerSessionContinuityStatus.js';
import { FileProviderSessionContinuityLedger } from '../src/server/runtime/providerSessionContinuityLedger.js';
import { FileProviderSessionLaunchLedger } from '../src/server/runtime/providerSessionLaunchLedger.js';

const OLD_CODEX_ID = '11111111-1111-4111-8111-111111111111';
const NEW_CODEX_ID = '22222222-2222-4222-8222-222222222222';
const OLD_CLAUDE_ID = '33333333-3333-4333-8333-333333333333';
const NEW_CLAUDE_ID = '44444444-4444-4444-8444-444444444444';

function session(
  sessionId: string,
  agent: 'claude' | 'codex',
  resume?: string
): SessionSpec {
  return {
    groupId: 'main',
    groupLabel: 'Main',
    name: sessionId,
    cwd: `/workspace/${sessionId}`,
    agent,
    ...(resume === undefined ? {} : { resume }),
    sessionId,
    command: agent,
    uiMode: 'terminal'
  };
}

describe('provider session continuity status', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function ledgerPath(): string {
    const root = mkdtempSync(join(tmpdir(), 'desk-provider-status-'));
    roots.push(root);
    return join(root, '_engine', 'provider-session-continuity.ndjson');
  }

  it('projects equivalent Codex and Claude pending transitions with exact recovery commands', () => {
    const path = ledgerPath();
    const ledger = new FileProviderSessionContinuityLedger(path);
    ledger.stageTransition({
      deskSessionId: 'codex-agent',
      provider: 'codex',
      generation: 3,
      expectedProviderSessionId: OLD_CODEX_ID,
      observedProviderSessionId: NEW_CODEX_ID,
      evidencePath: '/workspace/codex-agent/session.jsonl'
    });
    ledger.stageTransition({
      deskSessionId: 'claude-agent',
      provider: 'claude',
      generation: 7,
      expectedProviderSessionId: OLD_CLAUDE_ID,
      observedProviderSessionId: NEW_CLAUDE_ID,
      evidencePath: '/workspace/claude-agent/session.jsonl'
    });
    ledger.close();

    const status = readProviderSessionContinuityStatus(
      [
        session('codex-agent', 'codex', OLD_CODEX_ID),
        session('claude-agent', 'claude', OLD_CLAUDE_ID)
      ],
      { ledgerPath: path }
    );

    expect(status.issues).toEqual([
      {
        sessionId: 'codex-agent',
        cwd: '/workspace/codex-agent',
        code: 'provider-session-rebind-required',
        message:
          'Codex provider session changed; relaunch is blocked until the durable binding is explicitly rebound',
        provider: 'codex',
        durableProviderSessionId: OLD_CODEX_ID,
        observedProviderSessionId: NEW_CODEX_ID,
        action: `desk rebind-provider-session codex-agent --to ${NEW_CODEX_ID} --force`
      },
      {
        sessionId: 'claude-agent',
        cwd: '/workspace/claude-agent',
        code: 'provider-session-rebind-required',
        message:
          'Claude provider session changed; relaunch is blocked until the durable binding is explicitly rebound',
        provider: 'claude',
        durableProviderSessionId: OLD_CLAUDE_ID,
        observedProviderSessionId: NEW_CLAUDE_ID,
        action: `desk rebind-provider-session claude-agent --to ${NEW_CLAUDE_ID} --force`
      }
    ]);
  });

  it('keeps a resolved-but-unapplied authorization actionable until the manifest is NEW', () => {
    const path = ledgerPath();
    const ledger = new FileProviderSessionContinuityLedger(path);
    const pending = ledger.stageTransition({
      deskSessionId: 'codex-agent',
      provider: 'codex',
      generation: 3,
      expectedProviderSessionId: OLD_CODEX_ID,
      observedProviderSessionId: NEW_CODEX_ID,
      evidencePath: '/workspace/codex-agent/session.jsonl'
    });
    ledger.resolveTransition({
      deskSessionId: 'codex-agent',
      transitionId: pending.transitionId,
      targetProviderSessionId: NEW_CODEX_ID
    });
    ledger.close();

    expect(
      readProviderSessionContinuityStatus(
        [session('codex-agent', 'codex', OLD_CODEX_ID)],
        { ledgerPath: path }
      ).issues
    ).toEqual([
      expect.objectContaining({
        code: 'provider-session-rebind-required',
        durableProviderSessionId: OLD_CODEX_ID,
        observedProviderSessionId: NEW_CODEX_ID,
        action: `desk rebind-provider-session codex-agent --to ${NEW_CODEX_ID} --force`
      })
    ]);
    expect(
      readProviderSessionContinuityStatus(
        [session('codex-agent', 'codex', NEW_CODEX_ID)],
        { ledgerPath: path }
      ).issues
    ).toEqual([]);

    expect(
      readProviderSessionContinuityStatus([], { ledgerPath: path }).issues
    ).toEqual([]);

    expect(
      readProviderSessionContinuityStatus(
        [session('codex-agent', 'codex')],
        { ledgerPath: path }
      ).issues
    ).toEqual([
      expect.objectContaining({
        code: 'provider-session-reset-incomplete',
        message:
          'Codex provider session reset was interrupted before transition cancellation; relaunch remains blocked until the durable transition is cancelled',
        action: 'desk reset-provider-session codex-agent --force'
      })
    ]);

    const launchLedger = new FileProviderSessionLaunchLedger(
      join(dirname(path), 'provider-session-launch.ndjson'),
      { createAuthorizationId: () => 'reset-after-restart' }
    );
    launchLedger.prepare({
      deskSessionId: 'codex-agent',
      provider: 'codex',
      expectedPriorBinding: null,
      generation: 3
    });
    launchLedger.close();

    const reopened = new FileProviderSessionContinuityLedger(path);
    reopened.cancelTransitionByReset({
      deskSessionId: 'codex-agent',
      transitionId: pending.transitionId,
      resetAuthorizationId: 'reset-after-restart'
    });
    reopened.close();

    expect(
      readProviderSessionContinuityStatus(
        [session('codex-agent', 'codex')],
        { ledgerPath: path }
      ).issues
    ).toEqual([
      expect.objectContaining({
        code: 'provider-session-reset-incomplete',
        message:
          'Codex provider session reset was interrupted after transition cancellation; relaunch remains blocked until the durable fresh-launch authorization is completed',
        action: 'desk reset-provider-session codex-agent --force'
      })
    ]);

    const authorizedLaunch = new FileProviderSessionLaunchLedger(
      join(dirname(path), 'provider-session-launch.ndjson')
    );
    authorizedLaunch.authorize('reset-after-restart');
    authorizedLaunch.close();

    expect(
      readProviderSessionContinuityStatus(
        [session('codex-agent', 'codex')],
        { ledgerPath: path }
      ).issues
    ).toEqual([]);

    const claimedLaunch = new FileProviderSessionLaunchLedger(
      join(dirname(path), 'provider-session-launch.ndjson')
    );
    expect(
      claimedLaunch.claim({
        deskSessionId: 'codex-agent',
        provider: 'codex',
        currentGeneration: 3,
        nextGeneration: 4
      })
    ).toMatchObject({ ok: true });
    claimedLaunch.close();

    expect(
      readProviderSessionContinuityStatus(
        [session('codex-agent', 'codex')],
        { ledgerPath: path }
      ).issues
    ).toEqual([]);

    const completedLaunch = new FileProviderSessionLaunchLedger(
      join(dirname(path), 'provider-session-launch.ndjson')
    );
    expect(
      completedLaunch.complete({
        deskSessionId: 'codex-agent',
        provider: 'codex',
        providerSessionId: NEW_CODEX_ID,
        generation: 4
      })
    ).toMatchObject({ ok: true, kind: 'completed' });
    completedLaunch.close();

    expect(
      readProviderSessionContinuityStatus(
        [session('codex-agent', 'codex')],
        { ledgerPath: path }
      ).issues
    ).toEqual([]);
  });

  it.each([
    {
      name: 'missing launch authorization',
      authorization: undefined
    },
    {
      name: 'different authorization id',
      authorization: {
        authorizationId: 'unrelated-reset',
        provider: 'codex' as const,
        generation: 3
      }
    },
    {
      name: 'different provider',
      authorization: {
        authorizationId: 'linked-reset',
        provider: 'claude' as const,
        generation: 3
      }
    },
    {
      name: 'different generation',
      authorization: {
        authorizationId: 'linked-reset',
        provider: 'codex' as const,
        generation: 7
      }
    }
  ])('fails closed on a cancelled transition with $name', ({ authorization }) => {
    const path = ledgerPath();
    const ledger = new FileProviderSessionContinuityLedger(path);
    const pending = ledger.stageTransition({
      deskSessionId: 'codex-agent',
      provider: 'codex',
      generation: 3,
      expectedProviderSessionId: OLD_CODEX_ID,
      observedProviderSessionId: NEW_CODEX_ID,
      evidencePath: '/workspace/codex-agent/session.jsonl'
    });
    ledger.cancelTransitionByReset({
      deskSessionId: 'codex-agent',
      transitionId: pending.transitionId,
      resetAuthorizationId: 'linked-reset'
    });
    ledger.close();

    if (authorization !== undefined) {
      const launchLedger = new FileProviderSessionLaunchLedger(
        join(dirname(path), 'provider-session-launch.ndjson'),
        { createAuthorizationId: () => authorization.authorizationId }
      );
      launchLedger.prepare({
        deskSessionId: 'codex-agent',
        provider: authorization.provider,
        expectedPriorBinding: null,
        generation: authorization.generation
      });
      launchLedger.authorize(authorization.authorizationId);
      launchLedger.close();
    }

    expect(
      readProviderSessionContinuityStatus(
        [session('codex-agent', 'codex')],
        { ledgerPath: path }
      ).issues
    ).toEqual([
      expect.objectContaining({
        sessionId: 'codex-agent',
        code: 'continuity-store-corrupt',
        message: expect.stringContaining(
          'provider session reset authorization is inconsistent'
        )
      })
    ]);
  });

  it('fails closed on a corrupt ledger without repairing or exposing its contents', () => {
    const path = ledgerPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"secret":"do-not-expose"}\n', { mode: 0o600 });
    const before = readFileSync(path);

    const status = readProviderSessionContinuityStatus(
      [session('codex-agent', 'codex', OLD_CODEX_ID)],
      { ledgerPath: path }
    );

    expect(status.issues).toEqual([
      expect.objectContaining({
        code: 'continuity-store-corrupt',
        message: expect.stringContaining(
          'Provider session continuity status is unreadable'
        )
      })
    ]);
    expect(JSON.stringify(status)).not.toContain('do-not-expose');
    expect(readFileSync(path)).toEqual(before);
  });
});
