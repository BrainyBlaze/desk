import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileProviderSessionContinuityLedger } from '../src/server/runtime/providerSessionContinuityLedger.js';

const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const LATER_ID = '33333333-3333-4333-8333-333333333333';

describe('FileProviderSessionContinuityLedger', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function ledgerPath(): string {
    const root = mkdtempSync(join(tmpdir(), 'desk-provider-continuity-ledger-'));
    roots.push(root);
    return join(root, '_engine', 'provider-session-continuity.ndjson');
  }

  it('issues and replays launch proofs for every registry provider, not only claude/codex', () => {
    const path = ledgerPath();
    const ledger = new FileProviderSessionContinuityLedger(path);

    for (const [provider, sessionId] of [
      ['qwen', 'desk-qwen'],
      ['kimi', 'desk-kimi'],
      ['grok', 'desk-grok']
    ] as const) {
      const issued = ledger.issueLaunchProof({
        deskSessionId: sessionId,
        provider,
        generation: 3,
        issuedAt: 1_000
      });
      expect(
        ledger.verifyLaunchProof({
          deskSessionId: sessionId,
          provider,
          generation: 3,
          launchProof: issued.launchProof
        })
      ).toMatchObject({ ok: true });
    }
    ledger.close();

    const replayed = new FileProviderSessionContinuityLedger(path);
    expect(
      replayed.verifyLaunchProof({
        deskSessionId: 'desk-grok',
        provider: 'grok',
        generation: 3,
        launchProof: 'A'.repeat(43)
      })
    ).toMatchObject({ ok: false });
    replayed.close();
  });

  it('durably issues one private exact launch proof and supersedes an older same-generation proof', () => {
    const path = ledgerPath();
    const proofs = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
    const ledger = new FileProviderSessionContinuityLedger(path, {
      randomBytes: () => proofs.shift() ?? Buffer.alloc(32, 9)
    });

    const first = ledger.issueLaunchProof({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 7,
      issuedAt: 1_000
    });
    const second = ledger.issueLaunchProof({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 7,
      issuedAt: 1_001
    });

    expect(Buffer.from(first.launchProof, 'base64url')).toHaveLength(32);
    expect(ledger.verifyLaunchProof({ ...first })).toEqual({
      ok: false,
      reason: 'proof-mismatch'
    });
    expect(ledger.verifyLaunchProof({ ...second })).toEqual({
      ok: true,
      issuedAt: 1_001
    });
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(ledger.projection()).not.toContain(second.launchProof);
    ledger.close();

    const replayed = new FileProviderSessionContinuityLedger(path);
    expect(replayed.verifyLaunchProof({ ...second })).toEqual({
      ok: true,
      issuedAt: 1_001
    });
    expect(replayed.verifyLaunchProof({ ...first })).toEqual({
      ok: false,
      reason: 'proof-mismatch'
    });
    replayed.close();
  });

  it('stages, supersedes, resolves, and replays only an exact pending transition', () => {
    const path = ledgerPath();
    const transitionIds = ['transition-1', 'transition-2'];
    const ledger = new FileProviderSessionContinuityLedger(path, {
      createTransitionId: () => transitionIds.shift() ?? 'unexpected'
    });
    ledger.issueLaunchProof({
      deskSessionId: 'desk-alpha',
      provider: 'claude',
      generation: 4,
      issuedAt: 2_000
    });

    const first = ledger.stageTransition({
      deskSessionId: 'desk-alpha',
      provider: 'claude',
      generation: 4,
      expectedProviderSessionId: OLD_ID,
      observedProviderSessionId: NEW_ID,
      evidencePath: '/safe/claude/new.jsonl'
    });
    expect(ledger.stageTransition({
      deskSessionId: 'desk-alpha',
      provider: 'claude',
      generation: 4,
      expectedProviderSessionId: OLD_ID,
      observedProviderSessionId: NEW_ID,
      evidencePath: '/safe/claude/new.jsonl'
    })).toEqual(first);

    const superseding = ledger.stageTransition({
      deskSessionId: 'desk-alpha',
      provider: 'claude',
      generation: 4,
      expectedProviderSessionId: OLD_ID,
      observedProviderSessionId: LATER_ID,
      evidencePath: '/safe/claude/later.jsonl'
    });
    expect(superseding.transitionId).toBe('transition-2');
    expect(ledger.pending('desk-alpha')).toEqual(superseding);
    expect(() => ledger.resolveTransition({
      deskSessionId: 'desk-alpha',
      transitionId: first.transitionId,
      targetProviderSessionId: NEW_ID
    })).toThrow('not the current pending transition');

    const resolved = ledger.resolveTransition({
      deskSessionId: 'desk-alpha',
      transitionId: superseding.transitionId,
      targetProviderSessionId: LATER_ID
    });
    expect(resolved.state).toBe('resolved');
    expect(ledger.pending('desk-alpha')).toBeUndefined();
    ledger.close();

    const replayed = new FileProviderSessionContinuityLedger(path);
    expect(replayed.pending('desk-alpha')).toBeUndefined();
    expect(replayed.currentTransition('desk-alpha')).toEqual(resolved);
    replayed.close();
  });

  it('allows a proven successor after resolution without weakening a current pending generation', () => {
    const path = ledgerPath();
    const transitionIds = ['transition-1', 'transition-2'];
    const ledger = new FileProviderSessionContinuityLedger(path, {
      createTransitionId: () => transitionIds.shift() ?? 'unexpected'
    });
    const first = ledger.stageTransition({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 4,
      expectedProviderSessionId: OLD_ID,
      observedProviderSessionId: NEW_ID,
      evidencePath: '/safe/codex/new.jsonl'
    });
    ledger.resolveTransition({
      deskSessionId: 'desk-alpha',
      transitionId: first.transitionId,
      targetProviderSessionId: NEW_ID
    });

    const successor = ledger.stageTransition({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 5,
      expectedProviderSessionId: NEW_ID,
      observedProviderSessionId: LATER_ID,
      evidencePath: '/safe/codex/later.jsonl'
    });
    expect(successor).toMatchObject({
      state: 'pending',
      generation: 5,
      expectedProviderSessionId: NEW_ID,
      observedProviderSessionId: LATER_ID
    });
    expect(() =>
      ledger.stageTransition({
        deskSessionId: 'desk-alpha',
        provider: 'codex',
        generation: 6,
        expectedProviderSessionId: NEW_ID,
        observedProviderSessionId: OLD_ID,
        evidencePath: '/safe/codex/old.jsonl'
      })
    ).toThrow('pending transition identity changed');
    ledger.close();

    const replayed = new FileProviderSessionContinuityLedger(path);
    expect(replayed.pending('desk-alpha')).toEqual(successor);
    replayed.close();
  });

  it('rejects identity disagreement without replacing the current pending target', () => {
    const path = ledgerPath();
    const ledger = new FileProviderSessionContinuityLedger(path);
    const pending = ledger.stageTransition({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 8,
      expectedProviderSessionId: OLD_ID,
      observedProviderSessionId: NEW_ID,
      evidencePath: '/safe/codex/new.jsonl'
    });

    expect(() => ledger.stageTransition({
      deskSessionId: 'desk-alpha',
      provider: 'claude',
      generation: 8,
      expectedProviderSessionId: OLD_ID,
      observedProviderSessionId: LATER_ID,
      evidencePath: '/safe/claude/later.jsonl'
    })).toThrow('pending transition identity changed');
    expect(() => ledger.stageTransition({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 9,
      expectedProviderSessionId: OLD_ID,
      observedProviderSessionId: LATER_ID,
      evidencePath: '/safe/codex/later.jsonl'
    })).toThrow('pending transition identity changed');
    expect(ledger.pending('desk-alpha')).toEqual(pending);
    ledger.close();
  });

  it('durably cancels only the exact pending transition for an exact reset authorization', () => {
    const path = ledgerPath();
    const ledger = new FileProviderSessionContinuityLedger(path);
    const pending = ledger.stageTransition({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 3,
      expectedProviderSessionId: OLD_ID,
      observedProviderSessionId: NEW_ID,
      evidencePath: '/safe/codex/new.jsonl'
    });

    const cancelled = ledger.cancelTransitionByReset({
      deskSessionId: 'desk-alpha',
      transitionId: pending.transitionId,
      resetAuthorizationId: 'reset-1'
    });
    expect(cancelled).toMatchObject({
      state: 'cancelled-by-reset',
      resetAuthorizationId: 'reset-1'
    });
    expect(ledger.projectedTransitions()).toEqual([
      expect.objectContaining({
        deskSessionId: 'desk-alpha',
        state: 'cancelled-by-reset',
        resetAuthorizationId: 'reset-1'
      })
    ]);
    expect(ledger.cancelTransitionByReset({
      deskSessionId: 'desk-alpha',
      transitionId: pending.transitionId,
      resetAuthorizationId: 'reset-1'
    })).toEqual(cancelled);
    expect(() => ledger.cancelTransitionByReset({
      deskSessionId: 'desk-alpha',
      transitionId: pending.transitionId,
      resetAuthorizationId: 'reset-2'
    })).toThrow('reset authorization changed');
    ledger.close();
  });

  it('durably cancels and replays an exact resolved transition after reset', () => {
    const path = ledgerPath();
    let ledger = new FileProviderSessionContinuityLedger(path);
    const pending = ledger.stageTransition({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 3,
      expectedProviderSessionId: OLD_ID,
      observedProviderSessionId: NEW_ID,
      evidencePath: '/safe/codex/new.jsonl'
    });
    ledger.resolveTransition({
      deskSessionId: 'desk-alpha',
      transitionId: pending.transitionId,
      targetProviderSessionId: NEW_ID
    });
    expect(
      ledger.cancelTransitionByReset({
        deskSessionId: 'desk-alpha',
        transitionId: pending.transitionId,
        resetAuthorizationId: 'reset-resolved'
      })
    ).toMatchObject({
      state: 'cancelled-by-reset',
      resetAuthorizationId: 'reset-resolved'
    });
    ledger.close();

    ledger = new FileProviderSessionContinuityLedger(path, {
      readOnly: true
    });
    expect(ledger.currentTransition('desk-alpha')).toMatchObject({
      state: 'cancelled-by-reset',
      transitionId: pending.transitionId,
      resetAuthorizationId: 'reset-resolved'
    });
    ledger.close();
  });

  it('repairs a torn final record, rejects malformed interior history, and stays unhealthy after append failure', () => {
    const path = ledgerPath();
    const ledger = new FileProviderSessionContinuityLedger(path);
    ledger.issueLaunchProof({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 1,
      issuedAt: 1
    });
    ledger.close();
    appendFileSync(path, '{"version":1');

    const repaired = new FileProviderSessionContinuityLedger(path);
    repaired.close();
    appendFileSync(path, '{broken}\n');
    expect(() => new FileProviderSessionContinuityLedger(path)).toThrow(
      'malformed interior record'
    );

    const failedPath = ledgerPath();
    const failed = new FileProviderSessionContinuityLedger(failedPath);
    const internals = failed as unknown as { fd: number | null };
    closeSync(internals.fd!);
    internals.fd = openSync(failedPath, 'r');
    expect(() => failed.issueLaunchProof({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 1,
      issuedAt: 1
    })).toThrow();
    expect(() => failed.pending('desk-alpha')).toThrow('daemon restart required');
  });

  it('does not serialize launch proofs into the redacted public projection', () => {
    const path = ledgerPath();
    const ledger = new FileProviderSessionContinuityLedger(path, {
      randomBytes: () => Buffer.alloc(32, 7)
    });
    const issued = ledger.issueLaunchProof({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 2,
      issuedAt: 4_000
    });
    const pending = ledger.stageTransition({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 2,
      expectedProviderSessionId: OLD_ID,
      observedProviderSessionId: NEW_ID,
      evidencePath: '/private/provider/evidence.jsonl'
    });
    const serialized = ledger.projection();
    expect(serialized).not.toContain(issued.launchProof);
    expect(serialized).not.toContain('/private/provider/evidence.jsonl');
    expect(serialized).not.toContain(pending.transitionId);
    expect(serialized).toContain(OLD_ID);
    expect(serialized).toContain(NEW_ID);
    expect(readFileSync(path, 'utf8')).toContain(issued.launchProof);
    ledger.close();
  });

  it('reads projections without creating or repairing the durable ledger', () => {
    const path = ledgerPath();
    const missing = new FileProviderSessionContinuityLedger(path, {
      readOnly: true
    });
    expect(missing.projectedTransitions()).toEqual([]);
    missing.close();
    expect(existsSync(path)).toBe(false);

    const writer = new FileProviderSessionContinuityLedger(path);
    writer.issueLaunchProof({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 1,
      issuedAt: 1
    });
    writer.close();
    appendFileSync(path, '{"version":1');
    const before = readFileSync(path);

    const reader = new FileProviderSessionContinuityLedger(path, {
      readOnly: true
    });
    expect(reader.projectedTransitions()).toEqual([]);
    reader.close();
    expect(readFileSync(path)).toEqual(before);
  });

  it('validates private ownership before replay and never follows a ledger symlink', () => {
    const path = ledgerPath();
    const writer = new FileProviderSessionContinuityLedger(path);
    writer.issueLaunchProof({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      generation: 1,
      issuedAt: 1
    });
    writer.close();
    chmodSync(path, 0o644);
    appendFileSync(path, '{broken}\n');
    const permissiveBytes = readFileSync(path);

    expect(
      () =>
        new FileProviderSessionContinuityLedger(path, {
          readOnly: true
        })
    ).toThrow('permissions must be 0600');
    expect(readFileSync(path)).toEqual(permissiveBytes);

    chmodSync(path, 0o600);
    const linkPath = ledgerPath();
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(path, linkPath);
    const targetBytes = readFileSync(path);
    expect(
      () =>
        new FileProviderSessionContinuityLedger(linkPath, {
          readOnly: true
        })
    ).toThrow('must not be a symbolic link');
    expect(() => new FileProviderSessionContinuityLedger(linkPath)).toThrow(
      'must not be a symbolic link'
    );
    expect(readFileSync(path)).toEqual(targetBytes);
  });
});
