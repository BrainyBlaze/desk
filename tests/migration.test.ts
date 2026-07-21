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
  migrateDurabilityQueue,
  migrateManifestSessions,
  migratePausedStore,
  mintSessionId,
  negotiateClientSchema,
  planDrain,
  repairLegacySubmit,
  resumeMigration,
  validateManifestMigration,
  type LegacyDurabilityExt,
  type LegacyPausedEntry,
  type LegacyQueueItem,
  type LegacySessionEntry
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

// ---- manifest session-identity transform (§10 phase 3 + 4) ------------------
describe('migration — manifest transform (tmuxSession → sessionId)', () => {
  const ok = (m: ReturnType<typeof migrateManifestSessions>, entries: LegacySessionEntry[]) => {
    const v = validateManifestMigration(entries, m);
    expect(v.ok, JSON.stringify(v)).toBe(true);
    return m;
  };

  it('mints a grammar-valid sessionId per session and preserves the tmux map', () => {
    const entries: LegacySessionEntry[] = [
      { name: 'Claude Agent', tmuxSession: 'desk-claude-7f3a' },
      { name: 'Server', tmuxSession: 'desk-server-11b2' }
    ];
    const m = ok(migrateManifestSessions(entries), entries);
    expect(m.entries.map((e) => e.sessionId)).toEqual(['claude-agent', 'server']);
    for (const e of m.entries) expect(isValidSessionId(e.sessionId)).toBe(true);
    expect(m.tmuxToSessionId.get('desk-claude-7f3a')).toBe('claude-agent');
    expect(m.tmuxToSessionId.get('desk-server-11b2')).toBe('server');
  });

  it('dedupes colliding names with a numeric suffix, keeping each tmux mapping distinct', () => {
    const entries: LegacySessionEntry[] = [
      { name: 'Claude', tmuxSession: 'tmux-a' },
      { name: 'Claude', tmuxSession: 'tmux-b' },
      { name: 'Claude', tmuxSession: 'tmux-c' }
    ];
    const m = ok(migrateManifestSessions(entries), entries);
    expect(m.entries.map((e) => e.sessionId)).toEqual(['claude', 'claude-2', 'claude-3']);
    expect(m.tmuxToSessionId.get('tmux-b')).toBe('claude-2');
    expect(m.tmuxToSessionId.size).toBe(3);
  });

  it('a never-started session (no tmuxSession) still gets a sessionId but no map entry', () => {
    const entries: LegacySessionEntry[] = [{ name: 'Fresh Session' }];
    const m = ok(migrateManifestSessions(entries), entries);
    expect(m.entries[0]).toMatchObject({ sessionId: 'fresh-session' });
    expect(m.entries[0].tmuxSession).toBeUndefined();
    expect(m.tmuxToSessionId.size).toBe(0);
  });

  it('slugs weird names (emoji / leading digit / symbols) to the grammar', () => {
    const entries: LegacySessionEntry[] = [
      { name: '  🚀 Deploy!! ' },
      { name: '2nd Window' },
      { name: '' }
    ];
    const m = migrateManifestSessions(entries);
    expect(validateManifestMigration(entries, m).ok).toBe(true);
    for (const e of m.entries) expect(isValidSessionId(e.sessionId)).toBe(true);
  });

  it('validate is fail-closed on a duplicate legacy tmuxSession (map must be injective)', () => {
    const entries: LegacySessionEntry[] = [
      { name: 'One', tmuxSession: 'dup' },
      { name: 'Two', tmuxSession: 'dup' }
    ];
    const m = migrateManifestSessions(entries);
    const v = validateManifestMigration(entries, m);
    expect(v).toEqual({ ok: false, reason: 'duplicate-tmux-session', value: 'dup' });
  });

  it('is deterministic in entry order (a resumed transform re-mints identically)', () => {
    const entries: LegacySessionEntry[] = [
      { name: 'Alpha', tmuxSession: 'a' },
      { name: 'Alpha', tmuxSession: 'b' }
    ];
    const first = migrateManifestSessions(entries).entries.map((e) => e.sessionId);
    const second = migrateManifestSessions(entries).entries.map((e) => e.sessionId);
    expect(second).toEqual(first);
  });
});

// ---- channelsPaused store transform (§10) -----------------------------------
describe('migration — channelsPaused re-key', () => {
  const map = new Map<string, string>([
    ['tmux-a', 'claude'],
    ['tmux-b', 'server']
  ]);

  it('re-keys paused entries by the map, preserving pausedAt + reason', () => {
    const items: LegacyPausedEntry[] = [
      { tmuxSession: 'tmux-a', pausedAt: '2026-07-21T00:00:00.000Z', reason: 'sensitive work' },
      { tmuxSession: 'tmux-b', pausedAt: '2026-07-21T01:00:00.000Z' }
    ];
    const out = migratePausedStore(items, map);
    expect(out.items).toEqual([
      { sessionId: 'claude', pausedAt: '2026-07-21T00:00:00.000Z', reason: 'sensitive work' },
      { sessionId: 'server', pausedAt: '2026-07-21T01:00:00.000Z' }
    ]);
    expect(out.dropped).toEqual([]);
  });

  it('reports (never silently drops) a pause on a session gone from the manifest', () => {
    const items: LegacyPausedEntry[] = [{ tmuxSession: 'tmux-ghost', pausedAt: '2026-07-21T00:00:00.000Z' }];
    const out = migratePausedStore(items, map);
    expect(out.items).toEqual([]);
    expect(out.dropped).toEqual(items);
  });
});

// ---- durability/queue store transform (§10) ---------------------------------
describe('migration — durability queue re-key + submit repair', () => {
  const map = new Map<string, string>([['tmux-a', 'claude']]);

  it('an incomplete drain imports each item re-keyed + repaired, never as done', () => {
    const items: LegacyQueueItem[] = [
      { tmuxSession: 'tmux-a', seq: 1, ext: 'json' },
      { tmuxSession: 'tmux-a', seq: 2, ext: 'delivering' },
      { tmuxSession: 'tmux-a', seq: 3, ext: 'delivered' }
    ];
    const out = migrateDurabilityQueue(items, map, /*drainComplete*/ false);
    expect(out.skippedByDrain).toBe(false);
    expect(out.items.map((i) => [i.sessionId, i.seq, i.outcome.phase])).toEqual([
      ['claude', 1, 'queued'],
      ['claude', 2, 'queued'], // claimed-before-send → re-derive queued
      ['claude', 3, 'semantic-unknown'] // .delivered held, never done
    ]);
    for (const i of out.items) {
      expect(i.outcome.freshTxn).toBe(true);
      expect(importsAsDone(i.outcome)).toBe(false);
    }
  });

  it('a proven .delivered lifts to submit-confirmed (still not done)', () => {
    const items: LegacyQueueItem[] = [{ tmuxSession: 'tmux-a', seq: 5, ext: 'delivered', provenConfirmed: true }];
    const out = migrateDurabilityQueue(items, map, false);
    expect(out.items[0].outcome.phase).toBe('submit-confirmed');
    expect(importsAsDone(out.items[0].outcome)).toBe(false);
  });

  it('a fully-drained queue imports nothing', () => {
    const items: LegacyQueueItem[] = [{ tmuxSession: 'tmux-a', seq: 1, ext: 'json' }];
    const out = migrateDurabilityQueue(items, map, /*drainComplete*/ true);
    expect(out).toEqual({ items: [], dropped: [], skippedByDrain: true });
  });

  it('reports items for a session gone from the manifest', () => {
    const items: LegacyQueueItem[] = [{ tmuxSession: 'tmux-ghost', seq: 1, ext: 'delivering' }];
    const out = migrateDurabilityQueue(items, map, false);
    expect(out.items).toEqual([]);
    expect(out.dropped).toEqual(items);
  });
});
