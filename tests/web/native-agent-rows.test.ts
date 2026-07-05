import { describe, expect, it } from 'vitest';
import type { AgentSurfaceEvent } from '../../src/core/agentSurfaceProtocol';
import { applyEvent, initialRowModel, rowsFromSnapshot } from '../../src/web/agentSurface/rowsModel';

const TS = '2026-07-05T18:00:00.000Z';
function ev(seq: number, partial: Omit<AgentSurfaceEvent, 'seq' | 'ts'>): AgentSurfaceEvent {
  return { seq, ts: TS, ...partial } as AgentSurfaceEvent;
}

describe('rowsFromSnapshot', () => {
  it('projects a committed-only ring into ordered rows', () => {
    const events: AgentSurfaceEvent[] = [
      ev(1, { kind: 'user-message', id: 'u1', text: 'hi', source: 'external' }),
      ev(2, { kind: 'status', state: 'processing' }),
      ev(3, { kind: 'tool-start', toolUseId: 't1', name: 'Read', summary: 'foo.ts' }),
      ev(4, { kind: 'tool-end', toolUseId: 't1', status: 'ok', summary: 'read done' }),
      ev(5, { kind: 'assistant-message', id: 'm1', turnId: 'm1', markdown: 'hello' }),
      ev(6, { kind: 'turn-complete', turnId: 'm1' })
    ];
    const model = rowsFromSnapshot(events);
    expect(model.status).toBe('processing');
    expect(model.rows.map((r) => r.kind)).toEqual([
      'user-message',
      'tool',
      'assistant-message',
      'turn-complete'
    ]);
  });

  it('sets status from the most recent status event', () => {
    const events: AgentSurfaceEvent[] = [
      ev(1, { kind: 'status', state: 'starting' }),
      ev(2, { kind: 'status', state: 'idle' })
    ];
    expect(rowsFromSnapshot(events).status).toBe('idle');
  });

  it('uses the broker snapshot state when the committed ring has no status event', () => {
    const events: AgentSurfaceEvent[] = [ev(1, { kind: 'user-message', id: 'u1', text: 'ready?', source: 'external' })];
    expect(rowsFromSnapshot(events, 'idle').status).toBe('idle');
  });

  it('records a pending permission from permission-request', () => {
    const events: AgentSurfaceEvent[] = [
      ev(1, {
        kind: 'permission-request',
        requestId: 'p1',
        variant: 'command',
        title: 'Bash?',
        options: [
          { id: 'allow', label: 'Allow', treatment: 'allow' },
          { id: 'deny', label: 'Deny', treatment: 'deny' }
        ]
      })
    ];
    const model = rowsFromSnapshot(events);
    expect(model.pendingPermission).toMatchObject({ requestId: 'p1', title: 'Bash?' });
    expect(model.pendingPermission?.options.map((o) => o.treatment)).toEqual(['allow', 'deny']);
  });

  it('clears pending permission on permission-resolved', () => {
    const events: AgentSurfaceEvent[] = [
      ev(1, {
        kind: 'permission-request',
        requestId: 'p1',
        variant: 'command',
        title: 'Bash?',
        options: [{ id: 'allow', label: 'Allow', treatment: 'allow' }]
      }),
      ev(2, { kind: 'permission-resolved', requestId: 'p1', optionId: 'allow', via: 'ui' })
    ];
    expect(rowsFromSnapshot(events).pendingPermission).toBeNull();
  });
});

describe('applyEvent — idempotency', () => {
  it('does not duplicate an assistant-message with the same id', () => {
    const model = initialRowModel();
    const event: AgentSurfaceEvent = ev(5, { kind: 'assistant-message', id: 'm1', turnId: 'm1', markdown: 'hello' });
    applyEvent(model, event);
    applyEvent(model, event);
    expect(model.rows.filter((r) => r.kind === 'assistant-message')).toHaveLength(1);
  });

  it('does not duplicate a user-message with the same id', () => {
    const model = initialRowModel();
    const event: AgentSurfaceEvent = ev(5, { kind: 'user-message', id: 'u1', text: 'hi', source: 'ui' });
    applyEvent(model, event);
    applyEvent(model, event);
    expect(model.rows.filter((r) => r.kind === 'user-message')).toHaveLength(1);
  });

  it('does not duplicate a completed turn when restart backfill re-emits it with a new seq', () => {
    const model = initialRowModel();
    applyEvent(model, ev(5, { kind: 'turn-complete', turnId: 'turn-1' }));
    applyEvent(model, ev(12, { kind: 'turn-complete', turnId: 'turn-1' }));
    expect(model.rows.filter((r) => r.kind === 'turn-complete')).toHaveLength(1);
  });

  it('groups tool start, output, and end into one disclosure row', () => {
    const model = initialRowModel();
    applyEvent(model, ev(1, { kind: 'tool-start', toolUseId: 't1', name: 'Bash', summary: 'npm test', detail: '/repo' }));
    applyEvent(model, ev(2, { kind: 'tool-output-delta', toolUseId: 't1', text: 'running\n' }));
    applyEvent(model, ev(3, { kind: 'tool-end', toolUseId: 't1', status: 'ok', summary: 'exit 0', detail: 'done\n' }));
    expect(model.rows.filter((r) => r.kind === 'tool')).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({
      kind: 'tool',
      toolUseId: 't1',
      toolName: 'Bash',
      text: 'npm test',
      toolDetail: '/repo',
      toolStatus: 'ok',
      toolResult: 'done\n'
    });
  });
});

describe('applyEvent — transient events', () => {
  it('assistant-delta is a no-op on the row model (component handles delta accumulation)', () => {
    const model = initialRowModel();
    applyEvent(model, ev(1, { kind: 'assistant-delta', turnId: 't1', text: 'chunk' }));
    expect(model.rows).toHaveLength(0);
  });
});

describe('applyEvent — error + system rows', () => {
  it('agent-error becomes a system row', () => {
    const model = initialRowModel();
    applyEvent(model, ev(1, { kind: 'agent-error', message: 'oops', fatal: false }));
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ kind: 'system', text: 'oops' });
  });
});

describe('applyEvent — no-op kinds', () => {
  it('session-info, attention-hint, history-boundary do not affect the row model', () => {
    const model = initialRowModel();
    applyEvent(model, ev(1, { kind: 'session-info', agentSessionId: 'ses_x', model: 'gpt' }));
    applyEvent(model, ev(2, { kind: 'attention-hint', attention: 'session-status' }));
    applyEvent(model, ev(3, { kind: 'history-boundary', backfillComplete: true }));
    expect(model.rows).toHaveLength(0);
    expect(model.status).toBe('starting');
    expect(model.pendingPermission).toBeNull();
  });
});
