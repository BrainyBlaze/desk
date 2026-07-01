import { describe, it, expect, vi } from 'vitest';
import { createSessionStatusTracker } from '../src/web/editor/lsp/sessionStatusTracker.js';
import type { LspLifecycleStatus } from '../src/web/editor/lsp/connection.js';

const status = (over: Partial<LspLifecycleStatus>): LspLifecycleStatus => ({
  state: 'ready',
  serverConfigId: 'rust-analyzer',
  workspaceRoot: '/repo',
  languageId: 'rust',
  ...over
});

describe('createSessionStatusTracker', () => {
  it('reports nothing until the first lifecycle status arrives', () => {
    const onChange = vi.fn();
    const tracker = createSessionStatusTracker({ languageId: 'rust', onChange });
    expect(tracker.current()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('maps a lifecycle state to a session-status phase and emits it', () => {
    const onChange = vi.fn();
    const tracker = createSessionStatusTracker({ languageId: 'rust', onChange });
    tracker.acceptStatus(status({ state: 'warming' }));
    expect(tracker.current()).toMatchObject({ languageId: 'rust', phase: 'warming', serverName: 'rust-analyzer' });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('prefers an explicit serverName over the serverConfigId', () => {
    const onChange = vi.fn();
    const tracker = createSessionStatusTracker({ languageId: 'rust', serverName: 'RA', onChange });
    tracker.acceptStatus(status({ state: 'ready' }));
    expect(tracker.current()!.serverName).toBe('RA');
  });

  it('carries the reason on a degraded status', () => {
    const onChange = vi.fn();
    const tracker = createSessionStatusTracker({ languageId: 'rust', onChange });
    tracker.acceptStatus(status({ state: 'degraded', reason: 'warm start failed' }));
    expect(tracker.current()).toMatchObject({ phase: 'degraded', reason: 'warm start failed' });
  });

  it('overlays $/progress begin/report and clears it on end', () => {
    const onChange = vi.fn();
    const tracker = createSessionStatusTracker({ languageId: 'rust', onChange });
    tracker.acceptStatus(status({ state: 'ready' }));

    tracker.acceptProgress({ token: 'idx', value: { kind: 'begin', title: 'indexing', percentage: 0 } });
    expect(tracker.current()!.progress).toEqual({ title: 'indexing', percentage: 0 });

    tracker.acceptProgress({ token: 'idx', value: { kind: 'report', percentage: 50, message: 'crate 4/8' } });
    // report keeps the begin title and updates percentage/message
    expect(tracker.current()!.progress).toEqual({ title: 'indexing', percentage: 50, message: 'crate 4/8' });

    tracker.acceptProgress({ token: 'idx', value: { kind: 'end', message: 'done' } });
    expect(tracker.current()!.progress).toBeUndefined();
  });

  it('drops a stale progress overlay when the session goes degraded/restarting/stopped', () => {
    const onChange = vi.fn();
    const tracker = createSessionStatusTracker({ languageId: 'rust', onChange });
    tracker.acceptStatus(status({ state: 'ready' }));
    tracker.acceptProgress({ token: 'idx', value: { kind: 'begin', title: 'indexing', percentage: 20 } });
    expect(tracker.current()!.progress).toBeDefined();

    tracker.acceptStatus(status({ state: 'restarting' }));
    expect(tracker.current()).toMatchObject({ phase: 'restarting' });
    expect(tracker.current()!.progress).toBeUndefined();
  });

  it('reflects a restart-annotated exit as a restarting/stopped phase', () => {
    const onChange = vi.fn();
    const tracker = createSessionStatusTracker({ languageId: 'rust', onChange });
    tracker.acceptStatus(status({ state: 'ready' }));
    onChange.mockClear();

    tracker.acceptExit({ code: null, signal: 'SIGKILL', restart: { state: 'stopped', attempt: 5, maxAttempts: 5 } });
    expect(tracker.current()).toMatchObject({ phase: 'stopped' });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ignores a plain exit with no restart metadata (no phase churn)', () => {
    const onChange = vi.fn();
    const tracker = createSessionStatusTracker({ languageId: 'rust', onChange });
    tracker.acceptStatus(status({ state: 'ready' }));
    onChange.mockClear();

    tracker.acceptExit({ code: 0, signal: null });
    expect(tracker.current()).toMatchObject({ phase: 'ready' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
