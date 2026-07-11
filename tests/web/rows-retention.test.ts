import { describe, expect, it } from 'vitest';
import type { AgentSurfaceEvent } from '../../src/core/agentSurfaceProtocol';
import {
  DEFAULT_MAX_RETAINED_ROWS,
  MAX_PENDING_ASSISTANT_CHARS,
  MAX_PENDING_ASSISTANT_TURNS,
  MAX_TOOL_RESULT_CHARS,
  appendPendingAssistant,
  applyEvent,
  clampTail,
  enforceRowRetention,
  initialRowModel,
  rowsFromSnapshot,
  type AgentRow,
  type RowModel
} from '../../src/web/agentSurface/rowsModel';

const TS = '2026-07-09T12:00:00.000Z';
const ev = (partial: Omit<AgentSurfaceEvent, 'ts'>): AgentSurfaceEvent => ({ ts: TS, ...partial } as AgentSurfaceEvent);

/** Append one completed turn: a user-message then a turn-complete (2 rows). */
function completedTurn(model: RowModel, n: number): void {
  applyEvent(model, ev({ seq: n * 2, kind: 'user-message', id: `u${n}`, text: `q${n}`, source: 'external' }));
  applyEvent(model, ev({ seq: n * 2 + 1, kind: 'turn-complete', turnId: `t${n}` }));
}

describe('enforceRowRetention whole-turn eviction then hard fallback', () => {
  it('drops the minimum number of oldest whole turns to reach the cap', () => {
    const model = initialRowModel();
    completedTurn(model, 1);
    completedTurn(model, 2);
    completedTurn(model, 3);
    applyEvent(model, ev({ seq: 99, kind: 'user-message', id: 'live', text: 'now', source: 'external' }));
    expect(model.rows).toHaveLength(7);

    enforceRowRetention(model, 4);

    // t1 and t2 fully evicted on turn boundaries; t3 + the in-progress row survive.
    expect(model.rows.map((r) => r.id)).toEqual(['u3', 'tc-t3', 'live']);
    expect(model.prunedRowCount).toBe(4); // 4 top-level rows dropped
  });

  it('hard-bounds a single oversized ACTIVE turn (the original leak)', () => {
    const model = initialRowModel();
    completedTurn(model, 1);
    // in-progress turn with 5 live rows, no turn-complete
    for (let i = 0; i < 5; i += 1) {
      applyEvent(model, ev({ seq: 100 + i, kind: 'user-message', id: `live${i}`, text: 'x', source: 'external' }));
    }
    expect(model.rows).toHaveLength(7);

    enforceRowRetention(model, 3);

    // Coherence yields to the ceiling: the completed turn goes, then oldest active
    // rows are dropped until the cap holds — the newest rows are kept.
    expect(model.rows.length).toBeLessThanOrEqual(3);
    expect(model.rows.some((r) => r.id === 'live4')).toBe(true); // newest retained
    expect(model.rows.some((r) => r.id === 'live0')).toBe(false); // oldest dropped
  });

  it('bounds even a run with no completed turn (drops oldest, keeps one)', () => {
    const model = initialRowModel();
    for (let i = 0; i < 3; i += 1) {
      applyEvent(model, ev({ seq: i, kind: 'user-message', id: `only${i}`, text: 'x', source: 'external' }));
    }
    enforceRowRetention(model, 1);
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]!.id).toBe('only2'); // newest kept
  });

  it('is a no-op when already at or under the cap', () => {
    const model = initialRowModel();
    completedTurn(model, 1);
    completedTurn(model, 2);
    const before = model.rows.map((r) => r.id);
    enforceRowRetention(model, 10);
    expect(model.rows.map((r) => r.id)).toEqual(before);
    expect(model.prunedRowCount).toBe(0);
  });

  it('counts nested child rows and bounds them when one row exceeds the cap (phase 3)', () => {
    const model = initialRowModel();
    applyEvent(model, ev({ seq: 1, kind: 'tool-start', toolUseId: 't1', name: 'Task', summary: 'spawn' }));
    const tool = model.rows[0]!;
    tool.children = [];
    for (let i = 0; i < 10; i += 1) {
      tool.children.push({ kind: 'system', id: `c${i}`, authorLabel: 'subagent', createdAt: TS, text: 'x' } as AgentRow);
    }
    // total = 1 tool + 10 children = 11, all under one top-level row
    enforceRowRetention(model, 4);
    expect(model.rows).toHaveLength(1); // the lone top-level row is never dropped to zero
    expect(1 + (model.rows[0]!.children?.length ?? 0)).toBeLessThanOrEqual(4);
    expect(model.rows[0]!.children?.some((c) => c.id === 'c9')).toBe(true); // newest child kept
    expect(model.rows[0]!.children?.some((c) => c.id === 'c0')).toBe(false); // oldest dropped
  });

  it('applyEvent enforces the default ceiling so live history stays bounded', () => {
    const model = initialRowModel();
    for (let n = 1; n <= 1400; n += 1) {
      completedTurn(model, n);
    }
    expect(model.rows.length).toBeLessThanOrEqual(DEFAULT_MAX_RETAINED_ROWS);
    expect(model.rows.some((r) => r.id === 'tc-t1400')).toBe(true); // newest turn intact
    expect(model.rows.some((r) => r.id === 'u1')).toBe(false); // oldest evicted
    expect(model.rows[0]!.kind).toBe('user-message'); // eviction landed on a turn boundary
    expect(model.prunedRowCount).toBeGreaterThan(0);
  });
});

describe('replay watermark (no resurrection of pruned rows)', () => {
  it('skips a replayed committed event whose row was already pruned', () => {
    const model = initialRowModel();
    for (let n = 1; n <= 5; n += 1) {
      completedTurn(model, n);
    }
    enforceRowRetention(model, 4); // prunes u1..u3 turns; watermark already at seq 11
    expect(model.rows.some((r) => r.id === 'u1')).toBe(false);
    const lenBefore = model.rows.length;

    // Reconnect backfill re-delivers the pruned u1 (seq 2 <= appliedThroughSeq).
    applyEvent(model, ev({ seq: 2, kind: 'user-message', id: 'u1', text: 'q1', source: 'external' }));

    expect(model.rows.some((r) => r.id === 'u1')).toBe(false); // NOT resurrected
    expect(model.rows).toHaveLength(lenBefore);
  });

  it('applies a genuinely new event with seq beyond the watermark', () => {
    const model = initialRowModel();
    completedTurn(model, 1); // seqs 2,3 -> watermark 3
    applyEvent(model, ev({ seq: 4, kind: 'user-message', id: 'fresh', text: 'new', source: 'external' }));
    expect(model.rows.some((r) => r.id === 'fresh')).toBe(true);
    expect(model.appliedThroughSeq).toBe(4);
  });

  it('seeds the watermark from snapshot lastSeq, not just max(retained events)', () => {
    // The ring only retains up to seq 5, but the broker has emitted through seq 20
    // (later events evicted, or transient-only). A replay in (5, 20] must be skipped.
    const events: AgentSurfaceEvent[] = [
      ev({ seq: 4, kind: 'user-message', id: 'u1', text: 'a', source: 'external' }),
      ev({ seq: 5, kind: 'turn-complete', turnId: 't1' })
    ];
    const model = rowsFromSnapshot(events, 'idle', 20);
    expect(model.appliedThroughSeq).toBe(20);

    applyEvent(model, ev({ seq: 12, kind: 'user-message', id: 'replayed', text: 'x', source: 'external' }));
    expect(model.rows.some((r) => r.id === 'replayed')).toBe(false); // within (5,20] -> skipped

    applyEvent(model, ev({ seq: 21, kind: 'user-message', id: 'fresh', text: 'y', source: 'external' }));
    expect(model.rows.some((r) => r.id === 'fresh')).toBe(true); // beyond lastSeq -> applied
  });

  it('falls back to max(events) when the snapshot omits lastSeq', () => {
    const events: AgentSurfaceEvent[] = [
      ev({ seq: 7, kind: 'user-message', id: 'u1', text: 'a', source: 'external' })
    ];
    expect(rowsFromSnapshot(events, 'idle').appliedThroughSeq).toBe(7);
  });
});

describe('pendingAssistant aggregate bound', () => {
  it('caps each streamed turn to its tail', () => {
    const big = 'x'.repeat(MAX_PENDING_ASSISTANT_CHARS + 5000);
    const map = appendPendingAssistant(new Map(), 't1', big);
    expect(map.get('t1')!.length).toBeLessThanOrEqual(MAX_PENDING_ASSISTANT_CHARS + 64);
  });

  it('evicts the oldest turn once over the entry cap (abandoned turnIds cannot accumulate)', () => {
    let map = new Map<string, string>();
    for (let i = 0; i < MAX_PENDING_ASSISTANT_TURNS + 10; i += 1) {
      map = appendPendingAssistant(map, `turn-${i}`, 'hi');
    }
    expect(map.size).toBeLessThanOrEqual(MAX_PENDING_ASSISTANT_TURNS);
    expect(map.has('turn-0')).toBe(false); // oldest evicted
    expect(map.has(`turn-${MAX_PENDING_ASSISTANT_TURNS + 9}`)).toBe(true); // newest kept
  });
});

describe('per-row string caps', () => {
  it('clampTail keeps the tail and marks the truncated prefix', () => {
    expect(clampTail('abcdef', 10)).toBe('abcdef'); // under cap: unchanged
    const out = clampTail('abcdefghij', 4);
    expect(out).toContain('truncated 6 chars');
    expect(out.endsWith('ghij')).toBe(true);
  });

  it('caps streamed tool output so one row cannot grow unbounded', () => {
    const model = initialRowModel();
    applyEvent(model, ev({ seq: 1, kind: 'tool-start', toolUseId: 't1', name: 'Bash', summary: 'run' }));
    const chunk = 'x'.repeat(5000);
    for (let i = 0; i < 10; i += 1) {
      applyEvent(model, ev({ seq: 2 + i, kind: 'tool-output-delta', toolUseId: 't1', text: chunk }));
    }
    const row = model.rows.find((r) => r.id === 'tool-t1');
    expect(row?.toolResult).toBeDefined();
    expect(row!.toolResult!.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 64); // + marker slack
    expect(row!.toolResult).toContain('truncated');
  });
});
