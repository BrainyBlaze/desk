import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileDeskEventJournal } from '../src/server/runtime/fileDeskEventJournal.js';
import {
  type SessionStateSnapshot,
  type SessionStateTransition
} from '../src/shared/controlPlane/index.js';
import { canonicalAgentSnapshot } from './helpers/canonicalAgentState.js';

const LEGACY_V1_FIXTURE = new URL(
  './fixtures/file-desk-event-journal-v1.ndjson',
  import.meta.url
);
const LEGACY_V1_FIXTURE_SHA256 =
  '9d2ad70cb7beb4edc5fe03475d53d31a615a284e5ff2a894e33a2b35d6af9642';
const LEGACY_V1_CHECKPOINT_FIXTURE = new URL(
  './fixtures/file-desk-event-journal-v1-checkpoint.ndjson',
  import.meta.url
);
const LEGACY_V1_CHECKPOINT_FIXTURE_SHA256 =
  'da000dacf56a99d8fd572cf79223384237115d7d288d1c0e72c23d9e02c9b634';

function transition(
  from: SessionStateSnapshot,
  to: SessionStateSnapshot,
  overrides: Partial<SessionStateTransition> = {}
): SessionStateTransition {
  return {
    schemaVersion: to.schemaVersion,
    revision: to.revision,
    sessionId: to.sessionId,
    generation: to.generation,
    at: to.updatedAt,
    cause: 'agent-event',
    actionable: false,
    from,
    to,
    ...overrides
  };
}

function idleTransition(revision = 41): SessionStateTransition {
  const from = canonicalAgentSnapshot('agent-a', {
    activity: 'working',
    now: 20_000,
    revision: revision - 1
  });
  const to = canonicalAgentSnapshot('agent-a', {
    activity: 'idle',
    now: 21_000,
    revision
  });
  return transition(from, to);
}

describe('FileDeskEventJournal', () => {
  let dir: string;
  let path: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-event-journal-'));
    path = join(dir, 'events.ndjson');
    now = 100_000;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('durably journals raw transitions and allocates an independent feed sequence', () => {
    const journal = new FileDeskEventJournal(path, { now: () => now });
    const canonical = idleTransition(41);
    const agentEvents = journal.appendTransition(canonical);
    now += 1;
    const channel = journal.appendChannel({
      channel: 'desk',
      messageId: 'msg-1',
      author: 'human',
      mentionsOperator: true,
      message: 'Please review'
    });

    expect(agentEvents).toMatchObject([
      {
        id: 'desk-event-1',
        seq: 1,
        authorityRevision: 41,
        kind: 'agent-idle',
        read: false
      }
    ]);
    expect(channel).toMatchObject({
      kind: 'appended',
      event: { id: 'desk-event-2', seq: 2, kind: 'channel-message' }
    });
    expect(journal.snapshot()).toMatchObject({
      schemaVersion: 1,
      latestSeq: 2,
      unread: 2,
      items: [{ seq: 2 }, { seq: 1 }]
    });
    expect(journal.auditTransitions()).toEqual([canonical]);

    const records = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({
      recordVersion: 2,
      journalSeq: 1,
      type: 'transition',
      transition: canonical
    });
    journal.close();

    const restarted = new FileDeskEventJournal(path, { now: () => now });
    expect(restarted.snapshot()).toMatchObject({
      latestSeq: 2,
      unread: 2,
      items: [{ seq: 2 }, { seq: 1 }]
    });
    expect(restarted.auditTransitions()).toEqual([canonical]);
    restarted.close();
  });

  it('carries exit provenance through journal, restart replay and compaction (desk#59)', () => {
    // The whole point of desk#59 is that the record can still answer "who
    // ended this session, how did the child die, and what could observation
    // not establish" AFTER a restart. A field that survives in memory but is
    // dropped by replay or compaction answers nothing.
    const before = canonicalAgentSnapshot('agent-a', { activity: 'working', now: 20_000, revision: 40 });
    const retired = {
      ...canonicalAgentSnapshot('agent-a', { activity: 'unknown', now: 21_000, revision: 41 }),
      lifecycle: 'exited' as const,
      lifecycleSince: 21_000,
      exit: {
        at: 21_000,
        code: null,
        signal: null,
        origin: 'retired' as const,
        reason: 'master-link-closed',
        outcome: { kind: 'unknown' as const },
        diagnostic: { code: 'moor-event-drain-unobservable' as const }
      }
    };
    const strengthened = {
      ...retired,
      revision: 42,
      updatedAt: 21_028,
      exit: {
        at: 21_028,
        code: 143,
        signal: '15',
        origin: 'observed' as const,
        reason: null,
        outcome: { kind: 'signalled' as const, signal: 15, method: 'forced' as const },
        diagnostic: null
      }
    };

    // Compact aggressively so the round trip actually exercises rewriting.
    const journal = new FileDeskEventJournal(path, { now: () => now, compactEveryRecords: 1 });
    journal.appendTransition(transition(before, retired, { cause: 'lifecycle-exited', revision: 41 }));
    now += 1;
    journal.appendTransition(
      transition(retired, strengthened, { cause: 'lifecycle-exited', revision: 42 })
    );
    journal.close();

    const restarted = new FileDeskEventJournal(path, { now: () => now, compactEveryRecords: 1 });
    const audited = restarted.auditTransitions();

    expect(audited.at(-2)?.to.exit).toMatchObject({
      origin: 'retired',
      reason: 'master-link-closed',
      outcome: { kind: 'unknown' },
      diagnostic: { code: 'moor-event-drain-unobservable' }
    });
    // And the correction that replaced the placeholder is still visible as its
    // own transition, not silently folded into the first.
    expect(audited.at(-1)?.to.exit).toMatchObject({
      origin: 'observed',
      code: 143,
      signal: '15',
      outcome: { kind: 'signalled', signal: 15, method: 'forced' }
    });
    restarted.close();
  });

  it('migrates pre-transition v1 exit outcomes and rewrites the journal as v2', () => {
    // Generated by FileDeskEventJournal at pre-transition head
    // 85a6099db9118d836d7a079d2d46b3d5a771c270.
    const fixture = readFileSync(LEGACY_V1_FIXTURE);
    expect(createHash('sha256').update(fixture).digest('hex')).toBe(
      LEGACY_V1_FIXTURE_SHA256
    );
    writeFileSync(path, fixture);

    const migrated = new FileDeskEventJournal(path, { now: () => now });
    expect(migrated.health()).toEqual({ status: 'healthy' });
    expect(
      migrated.auditTransitions().map((item) => item.to.exit?.outcome)
    ).toEqual([
      { kind: 'exited', code: 7, method: 'forced' },
      { kind: 'exited', code: 0, method: 'none' },
      { kind: 'signalled', signal: 15, method: 'none' }
    ]);
    expect(
      migrated.snapshot().items.map((item) =>
        item.kind === 'agent-exited' ? item.exit.outcome : undefined
      )
    ).toEqual([
      { kind: 'signalled', signal: 15, method: 'none' },
      { kind: 'exited', code: 0, method: 'none' },
      { kind: 'exited', code: 7, method: 'forced' }
    ]);

    const before = canonicalAgentSnapshot('current-v4', {
      activity: 'working',
      now: 104_000,
      revision: 1
    });
    const exited = {
      ...canonicalAgentSnapshot('current-v4', {
        activity: 'unknown',
        now: 105_000,
        revision: 2
      }),
      lifecycle: 'exited' as const,
      lifecycleSince: 105_000,
      exit: {
        at: 105_000,
        code: 9,
        signal: null,
        origin: 'observed' as const,
        reason: null,
        outcome: {
          kind: 'exited' as const,
          code: 9,
          method: 'graceful' as const
        },
        diagnostic: null
      },
      updatedAt: 105_000
    };
    migrated.appendTransition(
      transition(before, exited, { cause: 'lifecycle-exited' })
    );
    migrated.close();

    const durable = readFileSync(path, 'utf8');
    const records = durable
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { recordVersion: number });
    expect(records.every((record) => record.recordVersion === 2)).toBe(true);
    expect(durable).not.toContain('"kind":"terminated"');
    expect(durable).toContain(
      '"outcome":{"kind":"exited","code":9,"method":"graceful"}'
    );

    const restarted = new FileDeskEventJournal(path, { now: () => now });
    expect(restarted.health()).toEqual({ status: 'healthy' });
    expect(restarted.auditTransitions()).toHaveLength(4);
    restarted.close();
  });

  it('migrates retained events and transition sources from a v1 checkpoint', () => {
    const fixture = readFileSync(LEGACY_V1_CHECKPOINT_FIXTURE);
    expect(createHash('sha256').update(fixture).digest('hex')).toBe(
      LEGACY_V1_CHECKPOINT_FIXTURE_SHA256
    );
    writeFileSync(path, fixture);

    const migrated = new FileDeskEventJournal(path, { now: () => now });
    expect(migrated.health()).toEqual({ status: 'healthy' });
    expect(
      migrated.auditTransitions().map((item) => item.to.exit?.outcome)
    ).toEqual([
      { kind: 'exited', code: 7, method: 'forced' },
      { kind: 'exited', code: 0, method: 'none' },
      { kind: 'signalled', signal: 15, method: 'none' }
    ]);
    expect(migrated.snapshot()).toMatchObject({ latestSeq: 3, unread: 3 });
    migrated.close();

    const durable = readFileSync(path, 'utf8');
    expect(JSON.parse(durable)).toMatchObject({
      recordVersion: 2,
      journalSeq: 3,
      type: 'checkpoint'
    });
    expect(durable).not.toContain('"kind":"terminated"');

    const restarted = new FileDeskEventJournal(path, { now: () => now });
    expect(restarted.health()).toEqual({ status: 'healthy' });
    expect(restarted.auditTransitions()).toHaveLength(3);
    restarted.close();
  });

  it('quarantines legacy outcomes that the v1 event grammar rejected', () => {
    const lines = readFileSync(LEGACY_V1_FIXTURE, 'utf8').trim().split('\n');
    const cases = [
      {
        line: lines[0]!,
        outcome: { kind: 'terminated', code: 7 }
      },
      {
        line: lines[2]!,
        outcome: { kind: 'signalled', signal: 15, method: 'forced' }
      }
    ];

    for (const [index, item] of cases.entries()) {
      const invalidPath = join(dir, `invalid-v1-${index}.ndjson`);
      const record = JSON.parse(item.line) as {
        transition: { to: { exit: { outcome: Record<string, unknown> } } };
        events: Array<{ exit: { outcome: Record<string, unknown> } }>;
      };
      record.transition.to.exit.outcome = item.outcome;
      record.events[0]!.exit.outcome = structuredClone(item.outcome);
      writeFileSync(invalidPath, `${JSON.stringify(record)}\n`);

      const recovered = new FileDeskEventJournal(invalidPath, { now: () => now });
      const health = recovered.health();
      expect(health).toMatchObject({
        status: 'degraded',
        reasons: [
          {
            reason: 'event-journal-corrupt',
            detail: expect.stringContaining(
              'legacy v1 exit outcome violates grammar'
            )
          }
        ]
      });
      expect(health.status).toBe('degraded');
      if (health.status === 'degraded') {
        expect(existsSync(health.reasons[0]!.quarantinePath)).toBe(true);
      }
      expect(recovered.snapshot()).toMatchObject({ latestSeq: 0, items: [] });
      recovered.close();
    }
  });

  it('ages exit provenance out of the audit ring in order, never selectively (desk#59)', () => {
    // The audit ring is bounded, so a death's transition is not kept forever.
    // What matters is that eviction is plain FIFO: the record is not dropped
    // BECAUSE it carries provenance, and an operator reading the ring sees
    // either the whole transition or none of it -- never a half-answer that
    // says a session exited without saying how.
    const journal = new FileDeskEventJournal(path, { now: () => now, maxTransitions: 2 });
    const before = canonicalAgentSnapshot('agent-a', { activity: 'working', now: 20_000, revision: 40 });
    const exited = {
      ...canonicalAgentSnapshot('agent-a', { activity: 'unknown', now: 21_000, revision: 41 }),
      lifecycle: 'exited' as const,
      lifecycleSince: 21_000,
      exit: {
        at: 21_000,
        code: null,
        signal: null,
        origin: 'retired' as const,
        reason: 'confirmed-holder-absence',
        outcome: { kind: 'unknown' as const },
        diagnostic: null
      }
    };
    journal.appendTransition(transition(before, exited, { cause: 'lifecycle-exited', revision: 41 }));
    expect(journal.auditTransitions().at(-1)?.to.exit).toMatchObject({
      reason: 'confirmed-holder-absence'
    });

    // Two newer transitions push it past the bound.
    now += 1;
    journal.appendTransition(idleTransition(42));
    now += 1;
    journal.appendTransition(idleTransition(43));

    const audited = journal.auditTransitions();
    expect(audited).toHaveLength(2);
    expect(audited.some((entry) => entry.to.exit !== null)).toBe(false);
    journal.close();
  });

  it('retains non-visible transitions for audit without fabricating feed items', () => {
    const journal = new FileDeskEventJournal(path);
    const idle = canonicalAgentSnapshot('agent-a', {
      activity: 'idle',
      now: 20_000,
      revision: 10
    });
    const deliveryOnly: SessionStateSnapshot = {
      ...idle,
      revision: 11,
      delivery: { state: 'queued', since: 16_000 },
      updatedAt: 16_000
    };
    const canonical = transition(idle, deliveryOnly, { cause: 'delivery' });

    expect(journal.appendTransition(canonical)).toEqual([]);
    expect(journal.snapshot()).toEqual({
      schemaVersion: 1,
      latestSeq: 0,
      unread: 0,
      items: []
    });
    expect(journal.auditTransitions()).toEqual([canonical]);
    journal.close();
  });

  it('deduplicates exact channel retries and rejects a conflicting message identity', () => {
    const journal = new FileDeskEventJournal(path, { now: () => now });
    const input = {
      sessionId: 'agent-a',
      channel: 'desk',
      messageId: 'msg-1',
      author: 'claude-1',
      mentionsOperator: false,
      message: 'Done'
    };

    const first = journal.appendChannel(input);
    now += 10_000;
    const retry = journal.appendChannel(input);
    const conflict = journal.appendChannel({ ...input, message: 'Different' });

    expect(first.kind).toBe('appended');
    expect(retry).toEqual({ kind: 'duplicate', event: first.event });
    expect(conflict).toEqual({ kind: 'conflict' });
    expect(journal.snapshot()).toMatchObject({ latestSeq: 1, unread: 1 });
    journal.close();
  });

  it('persists read and clear acknowledgments without acknowledging future events', () => {
    const journal = new FileDeskEventJournal(path, { now: () => now });
    const idle = journal.appendTransition(idleTransition())[0]!;
    const firstChannel = journal.appendChannel({
      channel: 'desk',
      messageId: 'msg-1',
      author: 'human',
      mentionsOperator: true,
      message: 'First'
    });
    expect(firstChannel.kind).toBe('appended');

    expect(journal.markRead({ kinds: ['agent-idle'] })).toBe(1);
    expect(journal.snapshot()).toMatchObject({
      unread: 1,
      items: [{ kind: 'channel-message', read: false }, { id: idle.id, read: true }]
    });
    expect(journal.clear()).toBe(0);

    now += 1;
    const future = journal.appendChannel({
      channel: 'desk',
      messageId: 'msg-2',
      author: 'human',
      mentionsOperator: true,
      message: 'Future'
    });
    expect(future.kind).toBe('appended');
    expect(journal.snapshot()).toMatchObject({
      latestSeq: 3,
      unread: 1,
      items: [{ id: future.event.id, read: false }]
    });
    journal.close();

    const restarted = new FileDeskEventJournal(path, { now: () => now });
    expect(restarted.snapshot()).toMatchObject({
      latestSeq: 3,
      unread: 1,
      items: [{ id: future.event.id, read: false }]
    });
    expect(restarted.auditTransitions()).toHaveLength(1);
    restarted.close();
  });

  it('bounds retained events and transition audit across compaction and restart', () => {
    const options = {
      now: () => now,
      maxEvents: 2,
      maxTransitions: 2,
      maxChannelReceipts: 2,
      compactEveryRecords: 2
    };
    const journal = new FileDeskEventJournal(path, options);
    journal.appendTransition(idleTransition(41));
    journal.appendTransition(idleTransition(42));
    journal.appendTransition(idleTransition(43));

    expect(journal.snapshot()).toMatchObject({
      latestSeq: 3,
      unread: 2,
      items: [{ seq: 3 }, { seq: 2 }]
    });
    expect(journal.auditTransitions().map((item) => item.revision)).toEqual([
      42, 43
    ]);
    journal.close();
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);

    const restarted = new FileDeskEventJournal(path, options);
    expect(restarted.snapshot()).toMatchObject({
      latestSeq: 3,
      unread: 2,
      items: [{ seq: 3 }, { seq: 2 }]
    });
    expect(
      restarted.auditTransitions().map((item) => item.revision)
    ).toEqual([42, 43]);
    restarted.close();
  });

  it('bounds channel idempotency receipts and preserves the retained window on restart', () => {
    const options = {
      now: () => now,
      maxEvents: 10,
      maxTransitions: 2,
      maxChannelReceipts: 2,
      compactEveryRecords: 2
    };
    const input = (messageId: string) => ({
      channel: 'desk',
      messageId,
      author: 'human',
      mentionsOperator: true,
      message: messageId
    });
    const journal = new FileDeskEventJournal(path, options);
    journal.appendChannel(input('msg-1'));
    const second = journal.appendChannel(input('msg-2'));
    journal.appendChannel(input('msg-3'));
    journal.close();

    const restarted = new FileDeskEventJournal(path, options);
    expect(restarted.appendChannel(input('msg-2'))).toEqual({
      kind: 'duplicate',
      event: second.event
    });
    expect(restarted.appendChannel(input('msg-1'))).toMatchObject({
      kind: 'appended',
      event: { seq: 4 }
    });
    restarted.close();
  });

  it('truncates a torn final record and continues both journal and event sequences', () => {
    const first = new FileDeskEventJournal(path, { now: () => now });
    first.appendTransition(idleTransition());
    first.close();
    appendFileSync(path, '{"recordVersion":1,"type":"channel"');

    const recovered = new FileDeskEventJournal(path, { now: () => now });
    const result = recovered.appendChannel({
      channel: 'desk',
      messageId: 'msg-after-crash',
      author: 'human',
      mentionsOperator: false,
      message: 'Recovered'
    });
    expect(result).toMatchObject({
      kind: 'appended',
      event: { id: 'desk-event-2', seq: 2 }
    });
    recovered.close();

    expect(readFileSync(path, 'utf8')).not.toContain('"type":"channel"{"');
    const restarted = new FileDeskEventJournal(path, { now: () => now });
    expect(restarted.snapshot()).toMatchObject({
      latestSeq: 2,
      unread: 2,
      items: [{ seq: 2 }, { seq: 1 }]
    });
    restarted.close();
  });

  it('quarantines a transition record whose feed projection was tampered', () => {
    const journal = new FileDeskEventJournal(path);
    journal.appendTransition(idleTransition());
    journal.close();

    const record = JSON.parse(readFileSync(path, 'utf8').trim()) as {
      events: Array<{ authorityRevision: number }>;
    };
    record.events[0]!.authorityRevision -= 1;
    writeFileSync(path, `${JSON.stringify(record)}\n`);

    const recovered = new FileDeskEventJournal(path);
    const health = recovered.health();
    expect(health).toMatchObject({
      status: 'degraded',
      reasons: [
        {
          reason: 'event-journal-corrupt',
          detail: expect.stringContaining(
            'desk event transition projection mismatch'
          )
        }
      ]
    });
    expect(health.status).toBe('degraded');
    if (health.status === 'degraded') {
      expect(existsSync(health.reasons[0]!.quarantinePath)).toBe(true);
    }
    expect(recovered.snapshot()).toMatchObject({
      latestSeq: 0,
      unread: 0,
      items: []
    });
    recovered.close();
  });

  it('quarantines a channel record whose feed projection was tampered', () => {
    const journal = new FileDeskEventJournal(path, { now: () => now });
    journal.appendChannel({
      channel: 'desk',
      messageId: 'msg-1',
      author: 'human',
      mentionsOperator: true,
      message: 'Original'
    });
    journal.close();

    const record = JSON.parse(readFileSync(path, 'utf8').trim()) as {
      event: { message: string };
    };
    record.event.message = 'Tampered';
    writeFileSync(path, `${JSON.stringify(record)}\n`);

    const recovered = new FileDeskEventJournal(path, { now: () => now });
    expect(recovered.health()).toMatchObject({
      status: 'degraded',
      reasons: [
        {
          reason: 'event-journal-corrupt',
          detail: expect.stringContaining(
            'desk event channel projection mismatch'
          )
        }
      ]
    });
    recovered.close();
  });

  it('quarantines a compacted checkpoint whose retained projection was tampered', () => {
    const journal = new FileDeskEventJournal(path, {
      now: () => now,
      compactEveryRecords: 1
    });
    journal.appendTransition(idleTransition());
    journal.close();

    const checkpoint = JSON.parse(readFileSync(path, 'utf8').trim()) as {
      type: string;
      retainedEvents: Array<{ event: { authorityRevision: number } }>;
    };
    expect(checkpoint.type).toBe('checkpoint');
    checkpoint.retainedEvents[0]!.event.authorityRevision -= 1;
    writeFileSync(path, `${JSON.stringify(checkpoint)}\n`);

    const recovered = new FileDeskEventJournal(path, { now: () => now });
    const health = recovered.health();
    expect(health).toMatchObject({
      status: 'degraded',
      reasons: [
        {
          reason: 'event-journal-corrupt',
          detail: expect.stringContaining(
            'desk event checkpoint projection mismatch'
          )
        }
      ]
    });
    expect(health.status).toBe('degraded');
    if (health.status === 'degraded') {
      expect(existsSync(health.reasons[0]!.quarantinePath)).toBe(true);
    }
    expect(recovered.snapshot()).toMatchObject({
      latestSeq: 0,
      unread: 0,
      items: []
    });
    recovered.close();
  });

  it('quarantines a complete corrupt middle record instead of blocking startup', () => {
    const journal = new FileDeskEventJournal(path, { now: () => now });
    journal.appendTransition(idleTransition());
    journal.appendChannel({
      channel: 'desk',
      messageId: 'msg-1',
      author: 'human',
      mentionsOperator: true,
      message: 'Original'
    });
    journal.close();
    const [first, second] = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, `${first}\n{not-json}\n${second}\n`);

    const recovered = new FileDeskEventJournal(path, { now: () => now });
    const health = recovered.health();
    expect(health.status).toBe('degraded');
    expect(recovered.snapshot()).toMatchObject({
      latestSeq: 0,
      unread: 0,
      items: []
    });
    expect(
      recovered.appendChannel({
        channel: 'desk',
        messageId: 'msg-after-quarantine',
        author: 'human',
        mentionsOperator: false,
        message: 'Recovered'
      })
    ).toMatchObject({ kind: 'appended', event: { seq: 1 } });
    recovered.close();
  });
});
