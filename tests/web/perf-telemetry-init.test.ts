import { afterEach, describe, expect, it, vi } from 'vitest';

const g = globalThis as Record<string, unknown>;

class FakeObserver {
  static instances: FakeObserver[] = [];
  disconnected = false;
  constructor(_cb: unknown) {
    FakeObserver.instances.push(this);
  }
  observe(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
  FakeObserver.instances = [];
  delete g.DESK_LSP_PERF;
  delete g.__deskLspPerfRuntime;
  delete g.__deskLspPerfSnapshot;
  delete g.__deskLspPerfReset;
});

describe('initPerfTelemetry idempotency + HMR safety', () => {
  it('a second module instance (HMR) disposes the prior observer before installing a new one', async () => {
    g.DESK_LSP_PERF = true;
    vi.stubGlobal('PerformanceObserver', FakeObserver as unknown as typeof PerformanceObserver);
    vi.useFakeTimers();

    vi.resetModules();
    const modA = await import('../../src/web/editor/lsp/perfTelemetry');
    modA.initPerfTelemetry();
    expect(FakeObserver.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1); // one heartbeat timer

    // HMR: a fresh module instance (module-local `initialized` resets), but the globalThis
    // runtime slot persists, so init must dispose it before installing anew.
    vi.resetModules();
    const modB = await import('../../src/web/editor/lsp/perfTelemetry');
    modB.initPerfTelemetry();
    expect(FakeObserver.instances).toHaveLength(2);
    expect(FakeObserver.instances[0]!.disconnected).toBe(true); // prior observer torn down
    expect(FakeObserver.instances[1]!.disconnected).toBe(false); // current live
    expect(vi.getTimerCount()).toBe(1); // prior heartbeat cleared, not stacked
  });

  it('a same-instance double init installs only once', async () => {
    g.DESK_LSP_PERF = true;
    vi.stubGlobal('PerformanceObserver', FakeObserver as unknown as typeof PerformanceObserver);
    vi.useFakeTimers();

    vi.resetModules();
    const mod = await import('../../src/web/editor/lsp/perfTelemetry');
    mod.initPerfTelemetry();
    mod.initPerfTelemetry();
    expect(FakeObserver.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });
});
