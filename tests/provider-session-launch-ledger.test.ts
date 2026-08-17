import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileProviderSessionLaunchLedger } from '../src/server/runtime/providerSessionLaunchLedger.js';

describe('FileProviderSessionLaunchLedger', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function ledgerPath(): string {
    const root = mkdtempSync(join(tmpdir(), 'desk-provider-launch-ledger-'));
    roots.push(root);
    return join(root, '_engine', 'provider-session-launch.ndjson');
  }

  it('skips whole chains from unknown providers and keeps known chains intact', () => {
    const path = ledgerPath();
    const first = new FileProviderSessionLaunchLedger(path, {
      createAuthorizationId: () => 'authorization-known'
    });
    const prepared = first.prepare({
      deskSessionId: 'desk-known',
      provider: 'claude',
      expectedPriorBinding: null,
      generation: 3
    });
    first.close();

    const foreign = (state: string, generation: number) =>
      JSON.stringify({
        authorizationId: 'authorization-foreign',
        deskSessionId: 'desk-foreign',
        provider: 'someday-provider',
        expectedPriorBinding: null,
        generation,
        state
      });
    appendFileSync(
      path,
      `${foreign('prepared', 1)}\n${foreign('authorized', 1)}\n${foreign('claimed', 2)}\n${foreign('completed', 2)}\n`
    );

    const second = new FileProviderSessionLaunchLedger(path);
    expect(second.current('desk-known')).toEqual(prepared);
    expect(second.current('desk-foreign')).toBeUndefined();
    second.close();
  });

  it('skips foreign records that carry unknown extra fields', () => {
    const path = ledgerPath();
    const first = new FileProviderSessionLaunchLedger(path, {
      createAuthorizationId: () => 'authorization-known'
    });
    const prepared = first.prepare({
      deskSessionId: 'desk-known',
      provider: 'claude',
      expectedPriorBinding: null,
      generation: 3
    });
    first.close();

    appendFileSync(
      path,
      `${JSON.stringify({
        authorizationId: 'authorization-foreign',
        deskSessionId: 'desk-foreign',
        provider: 'someday-provider',
        expectedPriorBinding: null,
        generation: 1,
        state: 'prepared',
        futureField: 'ignored'
      })}\n`
    );

    const second = new FileProviderSessionLaunchLedger(path);
    expect(second.current('desk-known')).toEqual(prepared);
    expect(second.current('desk-foreign')).toBeUndefined();
    second.close();
  });

  it('lets a skipped foreign prepared record supersede the chain it displaced', () => {
    const path = ledgerPath();
    const first = new FileProviderSessionLaunchLedger(path, {
      createAuthorizationId: () => 'authorization-known'
    });
    first.prepare({
      deskSessionId: 'desk-known',
      provider: 'claude',
      expectedPriorBinding: null,
      generation: 3
    });
    first.close();

    appendFileSync(
      path,
      `${JSON.stringify({
        authorizationId: 'authorization-foreign',
        deskSessionId: 'desk-known',
        provider: 'someday-provider',
        expectedPriorBinding: null,
        generation: 4,
        state: 'prepared'
      })}\n`
    );

    const second = new FileProviderSessionLaunchLedger(path);
    expect(second.current('desk-known')).toBeUndefined();
    second.close();
  });

  it('still fails loud on malformed records for known providers', () => {
    const path = ledgerPath();
    const first = new FileProviderSessionLaunchLedger(path);
    first.close();

    appendFileSync(
      path,
      `${JSON.stringify({ provider: 'claude', deskSessionId: 'desk-known', state: 'prepared' })}\n`
    );

    expect(() => new FileProviderSessionLaunchLedger(path)).toThrow(/invalid authorization record/);
  });

  it('replays read-only without creating or repairing the durable ledger', () => {
    const path = ledgerPath();
    const absent = new FileProviderSessionLaunchLedger(path, {
      readOnly: true
    });
    expect(absent.current('desk-alpha')).toBeUndefined();
    absent.close();
    expect(existsSync(path)).toBe(false);

    const writer = new FileProviderSessionLaunchLedger(path, {
      createAuthorizationId: () => 'authorization-1'
    });
    writer.prepare({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      expectedPriorBinding: null,
      generation: 7
    });
    writer.close();
    appendFileSync(path, '{"version":1');
    const before = readFileSync(path);

    const reader = new FileProviderSessionLaunchLedger(path, {
      readOnly: true
    });
    expect(reader.current('desk-alpha')).toMatchObject({
      authorizationId: 'authorization-1',
      state: 'prepared'
    });
    reader.close();
    expect(readFileSync(path)).toEqual(before);
  });

  it('durably replays prepared and authorized reset states', () => {
    const path = ledgerPath();
    const first = new FileProviderSessionLaunchLedger(path, {
      createAuthorizationId: () => 'authorization-1'
    });
    const prepared = first.prepare({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      expectedPriorBinding: '11111111-1111-4111-8111-111111111111',
      generation: 7
    });

    expect(prepared).toEqual({
      authorizationId: 'authorization-1',
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      expectedPriorBinding: '11111111-1111-4111-8111-111111111111',
      generation: 7,
      state: 'prepared'
    });
    first.close();

    const second = new FileProviderSessionLaunchLedger(path);
    expect(second.current('desk-alpha')).toEqual(prepared);
    const authorized = second.authorize(prepared.authorizationId);
    expect(authorized).toEqual({ ...prepared, state: 'authorized' });
    second.close();

    const third = new FileProviderSessionLaunchLedger(path);
    expect(third.current('desk-alpha')).toEqual(authorized);
    third.close();
  });

  it('allows one exact next-generation claim and never reuses it after restart', () => {
    const path = ledgerPath();
    const first = new FileProviderSessionLaunchLedger(path, {
      createAuthorizationId: () => 'authorization-1'
    });
    const prepared = first.prepare({
      deskSessionId: 'desk-alpha',
      provider: 'opencode',
      expectedPriorBinding: null,
      generation: 3
    });
    first.authorize(prepared.authorizationId);

    const claimed = first.claim({
      deskSessionId: 'desk-alpha',
      provider: 'opencode',
      currentGeneration: 3,
      nextGeneration: 4
    });
    expect(claimed).toEqual({
      ok: true,
      authorization: {
        ...prepared,
        generation: 4,
        state: 'claimed'
      }
    });
    first.close();

    const second = new FileProviderSessionLaunchLedger(path);
    expect(
      second.claim({
        deskSessionId: 'desk-alpha',
        provider: 'opencode',
        currentGeneration: 3,
        nextGeneration: 4
      })
    ).toEqual({ ok: false, reason: 'authorization-consumed' });
    second.close();
  });

  it('supersedes every earlier non-completed authorization with one latest prepared record', () => {
    const path = ledgerPath();
    const ids = ['authorization-1', 'authorization-2'];
    const ledger = new FileProviderSessionLaunchLedger(path, {
      createAuthorizationId: () => ids.shift() ?? 'unexpected'
    });
    const first = ledger.prepare({
      deskSessionId: 'desk-alpha',
      provider: 'claude',
      expectedPriorBinding: '11111111-1111-4111-8111-111111111111',
      generation: 8
    });
    ledger.authorize(first.authorizationId);
    const second = ledger.prepare({
      deskSessionId: 'desk-alpha',
      provider: 'claude',
      expectedPriorBinding: null,
      generation: 8
    });

    expect(ledger.current('desk-alpha')).toEqual(second);
    const historicalFirst = ledger.authorization(first.authorizationId);
    expect(historicalFirst).toEqual({
      ...first,
      state: 'authorized'
    });
    if (historicalFirst !== undefined) historicalFirst.state = 'completed';
    expect(ledger.authorization(first.authorizationId)).toEqual({
      ...first,
      state: 'authorized'
    });
    expect(ledger.authorization(second.authorizationId)).toEqual(second);
    expect(ledger.authorization('unknown-authorization')).toBeUndefined();
    expect(() => ledger.authorize(first.authorizationId)).toThrow(
      'is not the current authorization'
    );
    expect(
      ledger.claim({
        deskSessionId: 'desk-alpha',
        provider: 'claude',
        currentGeneration: 8,
        nextGeneration: 9
      })
    ).toEqual({ ok: false, reason: 'reset-incomplete' });
    ledger.close();

    const replayed = new FileProviderSessionLaunchLedger(path, {
      readOnly: true
    });
    expect(replayed.authorization(first.authorizationId)).toEqual({
      ...first,
      state: 'authorized'
    });
    expect(replayed.authorization(second.authorizationId)).toEqual(second);
    replayed.close();
  });

  it('completes only the exact claimed generation after a valid provider binding', () => {
    const path = ledgerPath();
    const ledger = new FileProviderSessionLaunchLedger(path, {
      createAuthorizationId: () => 'authorization-1'
    });
    const prepared = ledger.prepare({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      expectedPriorBinding: '11111111-1111-4111-8111-111111111111',
      generation: 11
    });
    ledger.authorize(prepared.authorizationId);
    ledger.claim({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      currentGeneration: 11,
      nextGeneration: 12
    });

    expect(
      ledger.complete({
        deskSessionId: 'desk-alpha',
        provider: 'codex',
        providerSessionId: '22222222-2222-4222-8222-222222222222',
        generation: 13
      })
    ).toEqual({ ok: false, reason: 'generation-mismatch' });
    expect(
      ledger.complete({
        deskSessionId: 'desk-alpha',
        provider: 'codex',
        providerSessionId: '22222222-2222-4222-8222-222222222222',
        generation: 12
      })
    ).toEqual({
      ok: true,
      kind: 'completed',
      authorization: {
        ...prepared,
        generation: 12,
        state: 'completed'
      }
    });
    ledger.close();

    const replayed = new FileProviderSessionLaunchLedger(path);
    expect(replayed.current('desk-alpha')?.state).toBe('completed');
    expect(
      replayed.complete({
        deskSessionId: 'desk-alpha',
        provider: 'codex',
        providerSessionId: '22222222-2222-4222-8222-222222222222',
        generation: 12
      })
    ).toEqual({ ok: true, kind: 'not-required' });
    replayed.close();
  });

  it('completes a stale prepared reset only for its exact durable resumed binding', () => {
    const path = ledgerPath();
    const ledger = new FileProviderSessionLaunchLedger(path, {
      createAuthorizationId: () => 'authorization-1'
    });
    const prepared = ledger.prepare({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      expectedPriorBinding: '11111111-1111-4111-8111-111111111111',
      generation: 7
    });

    expect(
      ledger.completeForResumedLaunch({
        deskSessionId: 'desk-alpha',
        provider: 'codex',
        providerSessionId: '22222222-2222-4222-8222-222222222222',
        generation: 7
      })
    ).toEqual({ ok: false, reason: 'provider-session-mismatch' });
    expect(ledger.current('desk-alpha')).toEqual(prepared);

    expect(
      ledger.completeForResumedLaunch({
        deskSessionId: 'desk-alpha',
        provider: 'codex',
        providerSessionId: '11111111-1111-4111-8111-111111111111',
        generation: 7
      })
    ).toEqual({
      ok: true,
      kind: 'completed',
      authorization: { ...prepared, state: 'completed' }
    });
    ledger.close();

    const replayed = new FileProviderSessionLaunchLedger(path);
    expect(replayed.current('desk-alpha')).toEqual({
      ...prepared,
      state: 'completed'
    });
    replayed.close();
  });

  it('replays a completed resumed launch at generation zero', () => {
    const path = ledgerPath();
    const first = new FileProviderSessionLaunchLedger(path, {
      createAuthorizationId: () => 'authorization-1'
    });
    const prepared = first.prepare({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      expectedPriorBinding: '11111111-1111-4111-8111-111111111111',
      generation: 0
    });

    expect(
      first.completeForResumedLaunch({
        deskSessionId: 'desk-alpha',
        provider: 'codex',
        providerSessionId: '11111111-1111-4111-8111-111111111111',
        generation: 0
      })
    ).toEqual({
      ok: true,
      kind: 'completed',
      authorization: { ...prepared, state: 'completed' }
    });
    first.close();

    const replayed = new FileProviderSessionLaunchLedger(path);
    expect(replayed.current('desk-alpha')).toEqual({
      ...prepared,
      state: 'completed'
    });
    replayed.close();
  });

  it('completes a stale authorized reset for the exact still-bound resumed identity', () => {
    const path = ledgerPath();
    const ledger = new FileProviderSessionLaunchLedger(path, {
      createAuthorizationId: () => 'authorization-1'
    });
    const prepared = ledger.prepare({
      deskSessionId: 'desk-alpha',
      provider: 'claude',
      expectedPriorBinding: '11111111-1111-4111-8111-111111111111',
      generation: 3
    });
    ledger.authorize(prepared.authorizationId);

    expect(
      ledger.completeForResumedLaunch({
        deskSessionId: 'desk-alpha',
        provider: 'claude',
        providerSessionId: '11111111-1111-4111-8111-111111111111',
        generation: 3
      })
    ).toMatchObject({
      ok: true,
      kind: 'completed',
      authorization: { state: 'completed', generation: 3 }
    });
    ledger.close();
  });

  it('keeps resumed launches fail-closed after any append failure', () => {
    const path = ledgerPath();
    const ledger = new FileProviderSessionLaunchLedger(path);
    const internals = ledger as unknown as { fd: number | null };
    closeSync(internals.fd!);
    internals.fd = openSync(path, 'r');

    expect(() =>
      ledger.prepare({
        deskSessionId: 'desk-alpha',
        provider: 'codex',
        expectedPriorBinding: null,
        generation: 0
      })
    ).toThrow();
    expect(() =>
      ledger.completeForResumedLaunch({
        deskSessionId: 'desk-alpha',
        provider: 'codex',
        providerSessionId: '11111111-1111-4111-8111-111111111111',
        generation: 0
      })
    ).toThrow('daemon restart required');
  });

  it('repairs a torn final append but rejects malformed interior history', () => {
    const path = ledgerPath();
    const ledger = new FileProviderSessionLaunchLedger(path, {
      createAuthorizationId: () => 'authorization-1'
    });
    ledger.prepare({
      deskSessionId: 'desk-alpha',
      provider: 'codex',
      expectedPriorBinding: null,
      generation: 0
    });
    ledger.close();
    appendFileSync(path, '{"authorizationId":"torn"');

    const repaired = new FileProviderSessionLaunchLedger(path);
    expect(repaired.current('desk-alpha')?.state).toBe('prepared');
    repaired.close();
    appendFileSync(path, '{broken}\n');

    expect(() => new FileProviderSessionLaunchLedger(path)).toThrow(
      'malformed interior record'
    );
  });
});
