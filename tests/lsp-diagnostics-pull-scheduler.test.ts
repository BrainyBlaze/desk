import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiagnosticsPullScheduler } from '../src/web/editor/lsp/appLspWiring';

const TUNING = { debounceMs: 2, timeoutMs: 20, retryDelayMs: 2, maxRetries: 3 };

function fullReport(items: unknown[]) {
  return { kind: 'full', items };
}
function flush(ms = 60) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeDeps(over: Partial<Parameters<typeof createDiagnosticsPullScheduler>[0]> = {}) {
  const applyPull = vi.fn();
  const clearBuiltInMarkers = vi.fn();
  const open = new Set<string>(['file:///a.ts']);
  const deps = {
    request: vi.fn(async () => fullReport([{ message: 'x' }])),
    whenReady: vi.fn(async () => ({ diagnosticProvider: true })),
    diagnostics: { applyPull, clearBuiltInMarkers },
    isOpen: (uri: string) => open.has(uri),
    openUris: () => [...open],
    ...TUNING,
    ...over
  };
  return { deps, applyPull, clearBuiltInMarkers, open };
}

describe('createDiagnosticsPullScheduler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pulls a uri and routes a full report to applyPull', async () => {
    const { deps, applyPull } = makeDeps();
    const s = createDiagnosticsPullScheduler(deps);
    s.pull('file:///a.ts');
    await flush();
    expect(deps.request).toHaveBeenCalledWith('textDocument/diagnostic', { textDocument: { uri: 'file:///a.ts' } }, expect.anything());
    expect(applyPull).toHaveBeenCalledWith('file:///a.ts', [{ message: 'x' }]);
    s.dispose();
  });

  it('no-ops when the server lacks diagnosticProvider capability', async () => {
    const { deps, applyPull } = makeDeps({ whenReady: vi.fn(async () => ({})) });
    const s = createDiagnosticsPullScheduler(deps);
    s.pull('file:///a.ts');
    await flush();
    expect(deps.request).not.toHaveBeenCalled();
    expect(applyPull).not.toHaveBeenCalled();
    s.dispose();
  });

  it('applies an empty full report and does NOT retry', async () => {
    const { deps, applyPull } = makeDeps({ request: vi.fn(async () => fullReport([])) });
    const s = createDiagnosticsPullScheduler(deps);
    s.pull('file:///a.ts');
    await flush();
    expect(applyPull).toHaveBeenCalledWith('file:///a.ts', []);
    expect(deps.request).toHaveBeenCalledTimes(1); // no retry after a valid full
    s.dispose();
  });

  it('retries (bounded) after a failure, never clearing markers, and stops at maxRetries', async () => {
    const { deps, applyPull } = makeDeps({ request: vi.fn(async () => { throw new Error('timeout'); }) });
    const s = createDiagnosticsPullScheduler(deps);
    s.pull('file:///a.ts');
    await flush(150);
    expect(applyPull).not.toHaveBeenCalled(); // failure never applies/clears
    expect(deps.request).toHaveBeenCalledTimes(1 + TUNING.maxRetries); // initial + bounded retries
    s.dispose();
  });

  it('stops retrying once a full report arrives', async () => {
    let n = 0;
    const request = vi.fn(async () => { n += 1; if (n < 2) throw new Error('not ready'); return fullReport([{ message: 'late' }]); });
    const { deps, applyPull } = makeDeps({ request });
    const s = createDiagnosticsPullScheduler(deps);
    s.pull('file:///a.ts');
    await flush(150);
    expect(applyPull).toHaveBeenCalledWith('file:///a.ts', [{ message: 'late' }]);
    expect(request).toHaveBeenCalledTimes(2); // failed once, then succeeded, then stop
    s.dispose();
  });

  it('does not retry/apply for a uri closed before the response', async () => {
    const { deps, applyPull, open } = makeDeps({ request: vi.fn(async () => { open.delete('file:///a.ts'); throw new Error('timeout'); }) });
    const s = createDiagnosticsPullScheduler(deps);
    s.pull('file:///a.ts');
    await flush(120);
    expect(applyPull).not.toHaveBeenCalled();
    expect(deps.request).toHaveBeenCalledTimes(1); // closed -> no retry
    s.dispose();
  });

  it('refreshAll pulls every open uri', async () => {
    const { deps, applyPull, open } = makeDeps();
    open.add('file:///b.ts');
    const s = createDiagnosticsPullScheduler(deps);
    s.refreshAll();
    await flush();
    expect(applyPull).toHaveBeenCalledWith('file:///a.ts', expect.anything());
    expect(applyPull).toHaveBeenCalledWith('file:///b.ts', expect.anything());
    s.dispose();
  });

  it('debounces rapid pulls of the same uri into one request', async () => {
    const { deps } = makeDeps();
    const s = createDiagnosticsPullScheduler(deps);
    s.pull('file:///a.ts'); s.pull('file:///a.ts'); s.pull('file:///a.ts');
    await flush();
    expect(deps.request).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('dispose cancels pending work: no request/applyPull after dispose, refreshAll is a no-op', async () => {
    const { deps, applyPull } = makeDeps();
    const s = createDiagnosticsPullScheduler(deps);
    s.pull('file:///a.ts');
    s.dispose();
    s.refreshAll();
    await flush();
    expect(deps.request).not.toHaveBeenCalled();
    expect(applyPull).not.toHaveBeenCalled();
  });

  it('does not apply or retry an unchanged (non-full) report', async () => {
    const { deps, applyPull } = makeDeps({ request: vi.fn(async () => ({ kind: 'unchanged', resultId: 'r1' })) });
    const s = createDiagnosticsPullScheduler(deps);
    s.pull('file:///a.ts');
    await flush(120);
    expect(applyPull).not.toHaveBeenCalled();
    expect(deps.request).toHaveBeenCalledTimes(1); // valid response -> no retry
    s.dispose();
  });
});
