import { describe, expect, it } from 'vitest';
import type { AgentSurfaceEvent } from '../../src/core/agentSurfaceProtocol';
import { applyEvent, buildAgentFeedItems, initialRowModel, rowsFromSnapshot } from '../../src/web/agentSurface/rowsModel';

const TS = '2026-07-05T18:00:00.000Z';
function ev(seq: number, partial: Omit<AgentSurfaceEvent, 'seq' | 'ts'>): AgentSurfaceEvent {
  return { seq, ts: TS, ...partial } as AgentSurfaceEvent;
}

function evAt(seq: number, ts: string, partial: Omit<AgentSurfaceEvent, 'seq' | 'ts'>): AgentSurfaceEvent {
  return { seq, ts, ...partial } as AgentSurfaceEvent;
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
  it('session-info and history-boundary do not affect the row model; attention-hint renders as system row (BUG-14)', () => {
    const model = initialRowModel();
    applyEvent(model, ev(1, { kind: 'session-info', agentSessionId: 'ses_x', model: 'gpt' }));
    applyEvent(model, ev(3, { kind: 'history-boundary', backfillComplete: true }));
    expect(model.rows).toHaveLength(0);
    expect(model.status).toBe('starting');
    expect(model.pendingPermission).toBeNull();

    // BUG-14: attention-hint MUST be visible (was silently skipped → user saw nothing during retry).
    // seq 4: events are delivered in monotonic seq order, so the hint follows the seq-3 boundary.
    applyEvent(model, ev(4, { kind: 'attention-hint', attention: 'session-status', detail: 'retry: rate limited' }));
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ kind: 'system', text: 'status: retry: rate limited' });
  });
});

describe('applyEvent — collapsible payload metadata', () => {
  it('marks long channel onboarding user payloads collapsible with a short preview', () => {
    const model = initialRowModel();
    const text = [
      'You have been added to the desk channel #test as @validation-val-1.',
      'This is a multi-agent collaboration room — you are expected to participate actively, not observe.',
      'Channel goal: (not set — ask @human if direction is unclear)',
      'Members: @human (human operator)',
      'How it works:',
      '- New messages addressed to you arrive in this terminal automatically.',
      '- Read the room first: desk channels read test',
      '- Post: desk channels post test --as validation-val-1 "<message>"'
    ].join(' ');

    applyEvent(model, ev(1, { kind: 'user-message', id: 'u-channel', text, source: 'channel' }));

    expect(model.rows[0]).toMatchObject({
      kind: 'user-message',
      collapse: {
        defaultCollapsed: true,
        reason: 'channel-onboarding'
      }
    });
    expect(model.rows[0].collapse?.preview.length).toBeLessThan(180);
    expect(model.rows[0].text).toBe(text);
  });

  it('recognizes channel onboarding payloads even when the source is external', () => {
    const model = initialRowModel();
    const text = [
      'You have been added to the desk channel #test as @validation-val-2.',
      'This is a multi-agent collaboration room — you are expected to participate actively, not observe.',
      'How it works:',
      '- New messages addressed to you arrive in this terminal automatically.',
      '- Read the room first: desk channels read test'
    ].join(' ');

    applyEvent(model, ev(1, { kind: 'user-message', id: 'u-external', text, source: 'external' }));

    expect(model.rows[0].collapse?.reason).toBe('channel-onboarding');
  });
});

describe('applyEvent — row anatomy metadata', () => {
  it('records author labels and timestamps for message rows', () => {
    const model = initialRowModel();

    applyEvent(model, ev(1, { kind: 'user-message', id: 'u1', text: 'hi', source: 'ui' }));
    applyEvent(model, ev(2, { kind: 'assistant-message', id: 'a1', turnId: 'turn-1', markdown: 'hello' }));

    expect(model.rows[0]).toMatchObject({
      kind: 'user-message',
      authorLabel: 'you',
      createdAt: TS
    });
    expect(model.rows[1]).toMatchObject({
      kind: 'assistant-message',
      authorLabel: 'assistant',
      createdAt: TS
    });
  });
});

describe('applyEvent — tool state display metadata', () => {
  it('marks a started tool as actively running with a clear display label', () => {
    const model = initialRowModel();

    applyEvent(model, ev(1, { kind: 'tool-start', toolUseId: 't1', name: 'Bash', summary: 'npm test' }));

    expect(model.rows[0]).toMatchObject({
      kind: 'tool',
      authorLabel: 'tool',
      createdAt: TS,
      toolState: {
        label: 'Running',
        tone: 'running',
        active: true,
        startedAt: TS
      }
    });
  });

  it('marks a completed error tool with finish time and elapsed duration', () => {
    const model = initialRowModel();
    const startTs = '2026-07-05T18:00:00.000Z';
    const endTs = '2026-07-05T18:00:01.250Z';

    applyEvent(model, evAt(1, startTs, { kind: 'tool-start', toolUseId: 't1', name: 'Bash', summary: 'npm test' }));
    applyEvent(model, evAt(2, endTs, { kind: 'tool-end', toolUseId: 't1', status: 'error', summary: 'exit 1' }));

    expect(model.rows[0]).toMatchObject({
      kind: 'tool',
      toolStatus: 'error',
      updatedAt: endTs,
      toolState: {
        label: 'Failed',
        tone: 'error',
        active: false,
        startedAt: startTs,
        finishedAt: endTs,
        durationMs: 1250
      }
    });
  });
});

describe('buildAgentFeedItems — turn collapse', () => {
  function appendTurn(model: ReturnType<typeof initialRowModel>, turnNumber: number): void {
    const turnId = `turn-${turnNumber}`;
    applyEvent(model, ev(turnNumber * 10 + 1, { kind: 'user-message', id: `u-${turnNumber}`, text: `question ${turnNumber}`, source: 'ui' }));
    applyEvent(model, ev(turnNumber * 10 + 2, { kind: 'tool-start', toolUseId: `tool-${turnNumber}`, name: 'Bash', summary: `cmd ${turnNumber}` }));
    applyEvent(model, ev(turnNumber * 10 + 3, { kind: 'tool-end', toolUseId: `tool-${turnNumber}`, status: 'ok', summary: 'ok' }));
    applyEvent(model, ev(turnNumber * 10 + 4, { kind: 'assistant-message', id: `a-${turnNumber}`, turnId, markdown: `answer ${turnNumber}` }));
    applyEvent(model, ev(turnNumber * 10 + 5, { kind: 'turn-complete', turnId }));
  }

  it('keeps short transcripts expanded', () => {
    const model = initialRowModel();
    appendTurn(model, 1);
    appendTurn(model, 2);

    const items = buildAgentFeedItems(model.rows, { collapseAfterRows: 20, keepRecentTurns: 1 });

    expect(items).toHaveLength(model.rows.length);
    expect(items.every((item) => item.kind === 'row')).toBe(true);
  });

  it('collapses older completed turns once the transcript is long', () => {
    const model = initialRowModel();
    appendTurn(model, 1);
    appendTurn(model, 2);
    appendTurn(model, 3);

    const items = buildAgentFeedItems(model.rows, { collapseAfterRows: 4, keepRecentTurns: 1 });

    expect(items[0]).toMatchObject({
      kind: 'turn-summary',
      turnId: 'turn-1',
      rowCount: 4,
      toolCount: 1,
      assistantCount: 1,
      preview: 'question 1'
    });
    expect(items[1]).toMatchObject({ kind: 'turn-summary', turnId: 'turn-2' });
    expect(items.slice(2).every((item) => item.kind === 'row')).toBe(true);
  });

  it('expands a collapsed turn when its id is in the expanded set', () => {
    const model = initialRowModel();
    appendTurn(model, 1);
    appendTurn(model, 2);
    appendTurn(model, 3);

    const items = buildAgentFeedItems(model.rows, {
      collapseAfterRows: 4,
      keepRecentTurns: 1,
      expandedTurnIds: new Set(['turn-1'])
    });

    expect(items[0]).toMatchObject({ kind: 'row', row: { id: 'u-1' } });
    expect(items.some((item) => item.kind === 'turn-summary' && item.turnId === 'turn-1')).toBe(false);
    expect(items.some((item) => item.kind === 'turn-summary' && item.turnId === 'turn-2')).toBe(true);
  });
});

describe('applyEvent — child-agent nesting (item 11)', () => {
  it('nests attributed events under the spawning tool row without growing top-level rows', () => {
    const model = { rows: [], status: 'idle', pendingPermission: null } as never as import('../../src/web/agentSurface/rowsModel').RowModel;
    applyEvent(model, { kind: 'tool-start', seq: 1, ts: '2026-07-06T22:00:00.000Z', toolUseId: 'task-1', name: 'Task', summary: 'spawn subagent' } as never);
    const before = model.rows.length;
    applyEvent(model, {
      kind: 'assistant-message', seq: 2, ts: '2026-07-06T22:00:01.000Z', id: 'child-a1', turnId: 't1', markdown: 'child says hi', parentToolUseId: 'task-1'
    } as never);
    expect(model.rows.length).toBe(before);
    const parent = model.rows.find((r) => r.toolUseId === 'task-1')!;
    expect(parent.children).toHaveLength(1);
    expect(parent.children![0]).toMatchObject({ kind: 'assistant-message', text: 'child says hi' });
  });

  it('renders orphaned child events flat with a subagent author instead of dropping them', () => {
    const model = { rows: [], status: 'idle', pendingPermission: null } as never as import('../../src/web/agentSurface/rowsModel').RowModel;
    applyEvent(model, {
      kind: 'assistant-message', seq: 1, ts: '2026-07-06T22:00:00.000Z', id: 'orphan-1', turnId: 't1', markdown: 'lost child', parentToolUseId: 'task-gone'
    } as never);
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ kind: 'assistant-message', authorLabel: 'subagent' });
  });

  it('child event replay stays idempotent inside the nested transcript', () => {
    const model = { rows: [], status: 'idle', pendingPermission: null } as never as import('../../src/web/agentSurface/rowsModel').RowModel;
    applyEvent(model, { kind: 'tool-start', seq: 1, ts: '2026-07-06T22:00:00.000Z', toolUseId: 'task-1', name: 'Task', summary: 's' } as never);
    const child = { kind: 'assistant-message', seq: 2, ts: '2026-07-06T22:00:01.000Z', id: 'child-a1', turnId: 't1', markdown: 'once', parentToolUseId: 'task-1' } as never;
    applyEvent(model, child);
    applyEvent(model, child);
    expect(model.rows.find((r) => r.toolUseId === 'task-1')!.children).toHaveLength(1);
  });
});

describe('duplicate hint/error idempotency', () => {
  it('does not create a duplicate row when an attention-hint replays', () => {
    const model = initialRowModel();
    const hint = ev(7, { kind: 'attention-hint', attention: 'session-status', detail: 'retrying' });
    applyEvent(model, hint);
    applyEvent(model, hint); // replay via rowsFromSnapshot or a live reconnect overlap
    expect(model.rows.filter((r) => r.id === 'hint-7')).toHaveLength(1);
  });

  it('does not create a duplicate row when an agent-error replays', () => {
    const model = initialRowModel();
    const err = ev(8, { kind: 'agent-error', message: 'boom' });
    applyEvent(model, err);
    applyEvent(model, err);
    expect(model.rows.filter((r) => r.id === 'err-8')).toHaveLength(1);
  });
});
