// Identity migration conformance (spec §10): sessionId grammar/minting, the
// submitState repair map (never import legacy as done), and the resumable phase
// FSM with correct rollback.

import { describe, expect, it } from 'vitest';
import {
  MIGRATION_ORDER,
  advanceMigration,
  assertMintable,
  checkGlobalUniqueness,
  importsAsDone,
  isValidSessionId,
  mintSessionId,
  negotiateClientSchema,
  planDrain,
  repairLegacySubmit,
  resumeMigration,
  type LegacyDurabilityExt
} from '../src/shared/migration/index.js';

// ---- sessionId grammar + minting (§10) --------------------------------------
describe('migration — sessionId grammar', () => {
  it('accepts valid ids and rejects invalid ones', () => {
    expect(isValidSessionId('web-1')).toBe(true);
    expect(isValidSessionId('abc')).toBe(true); // 3-char minimum
    expect(isValidSessionId('a'.repeat(64))).toBe(true);
    expect(isValidSessionId('ab')).toBe(false); // too short
    expect(isValidSessionId('a'.repeat(65))).toBe(false); // too long
    expect(isValidSessionId('1web')).toBe(false); // must start with a letter
    expect(isValidSessionId('Web-1')).toBe(false); // no uppercase
    expect(isValidSessionId('web_1')).toBe(false); // no underscore
    expect(isValidSessionId('-web')).toBe(false);
  });

  it('assertMintable rejects grammar and collision', () => {
    expect(assertMintable('web-1', new Set())).toEqual({ ok: true });
    expect(assertMintable('AB', new Set())).toEqual({ ok: false, reason: 'grammar' });
    expect(assertMintable('web-1', new Set(['web-1']))).toEqual({ ok: false, reason: 'collision' });
  });

  it('mints valid ids from arbitrary names, deduping collisions', () => {
    expect(mintSessionId('My Cool Session!', new Set())).toBe('my-cool-session');
    expect(isValidSessionId(mintSessionId('42', new Set()))).toBe(true); // leading digit fixed
    const taken = new Set(['agent', 'agent-2']);
    const minted = mintSessionId('agent', taken);
    expect(minted).toBe('agent-3');
    expect(isValidSessionId(minted)).toBe(true);
  });

  it('checkGlobalUniqueness finds the first duplicate (fail before commit)', () => {
    expect(checkGlobalUniqueness(['a-1', 'a-2', 'a-3'])).toEqual({ ok: true });
    expect(checkGlobalUniqueness(['a-1', 'a-2', 'a-1'])).toEqual({ ok: false, duplicate: 'a-1' });
  });
});

// ---- submitState repair map (§10 round-7A) ----------------------------------
describe('migration — submitState repair (never import legacy as done)', () => {
  const ALL: LegacyDurabilityExt[] = ['json', 'delivering', 'delivered', 'stuck-paste', 'stuck-submit', 'stuck-unobservable', 'delivery-ack-timeout'];

  it('NOTHING legacy imports as done', () => {
    for (const ext of ALL) {
      expect(importsAsDone(repairLegacySubmit(ext))).toBe(false);
    }
    expect(importsAsDone(repairLegacySubmit('delivered', true))).toBe(false); // even with proof → submit-confirmed, not done
  });

  it('json / delivering / stuck-paste reset to queued (safe re-deliver)', () => {
    expect(repairLegacySubmit('json').phase).toBe('queued');
    expect(repairLegacySubmit('delivering')).toMatchObject({ phase: 'queued', reissue: true });
    expect(repairLegacySubmit('stuck-paste')).toMatchObject({ phase: 'queued', reissue: true });
  });

  it('.delivered is held as semantic-unknown unless independently proven', () => {
    expect(repairLegacySubmit('delivered').phase).toBe('semantic-unknown');
    expect(repairLegacySubmit('delivered', true).phase).toBe('submit-confirmed');
  });

  it('stuck-submit / stuck-unobservable / ack-timeout → semantic-unknown, no resubmit', () => {
    for (const ext of ['stuck-submit', 'stuck-unobservable', 'delivery-ack-timeout'] as LegacyDurabilityExt[]) {
      expect(repairLegacySubmit(ext)).toMatchObject({ phase: 'semantic-unknown', reissue: false });
    }
  });

  it('every legacy record gets a fresh txn', () => {
    for (const ext of ALL) expect(repairLegacySubmit(ext).freshTxn).toBe(true);
  });

  it('drain planning: complete drain skips import, incomplete imports per-file', () => {
    expect(planDrain(true)).toEqual({ action: 'skip-import' });
    expect(planDrain(false)).toEqual({ action: 'import-per-file' });
  });
});

// ---- migration phase FSM (§10) ----------------------------------------------
describe('migration — resumable phase FSM', () => {
  it('advances through the ordered phases on success', () => {
    let cur = MIGRATION_ORDER[0];
    const seen = [cur];
    while (cur !== 'done') {
      cur = advanceMigration(cur, 'ok').next;
      seen.push(cur);
    }
    expect(seen).toEqual(['quiesce', 'backup', 'transform', 'validate', 'commit', 'done']);
  });

  it('failure before a backup exists rolls back by unquiescing', () => {
    expect(advanceMigration('quiesce', 'fail')).toEqual({ next: 'aborted', rollback: 'unquiesce' });
    expect(advanceMigration('backup', 'fail')).toEqual({ next: 'aborted', rollback: 'unquiesce' });
  });

  it('failure after a backup exists rolls back by restoring it', () => {
    for (const p of ['transform', 'validate', 'commit'] as const) {
      expect(advanceMigration(p, 'fail')).toEqual({ next: 'aborted', rollback: 'restore-backup' });
    }
  });

  it('done and aborted are terminal', () => {
    expect(advanceMigration('done', 'ok').next).toBe('done');
    expect(advanceMigration('aborted', 'fail').next).toBe('aborted');
  });

  it('resume re-runs the last-journaled phase; terminal phases are flagged', () => {
    expect(resumeMigration('transform')).toEqual({ rerun: 'transform', terminal: false });
    expect(resumeMigration('done')).toEqual({ rerun: 'done', terminal: true });
    expect(resumeMigration('aborted')).toEqual({ rerun: 'aborted', terminal: true });
  });

  it('client schema negotiation: match / one-behind / older', () => {
    expect(negotiateClientSchema(5, 5)).toBe('ok');
    expect(negotiateClientSchema(4, 5)).toBe('migrate-on-read');
    expect(negotiateClientSchema(2, 5)).toBe('clear-and-rederive');
  });
});
