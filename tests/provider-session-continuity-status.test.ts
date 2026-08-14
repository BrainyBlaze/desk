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

const OLD_CODEX_ID = '11111111-1111-4111-8111-111111111111';
const NEW_CODEX_ID = '22222222-2222-4222-8222-222222222222';
const OLD_CLAUDE_ID = '33333333-3333-4333-8333-333333333333';
const NEW_CLAUDE_ID = '44444444-4444-4444-8444-444444444444';

function session(
  sessionId: string,
  agent: 'claude' | 'codex',
  resume: string
): SessionSpec {
  return {
    groupId: 'main',
    groupLabel: 'Main',
    name: sessionId,
    cwd: `/workspace/${sessionId}`,
    agent,
    resume,
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
