import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderScheduler, providerDelayBounds, ProviderSupersededError } from '../src/web/editor/lsp/providerScheduler';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createProviderScheduler (leading-edge + trailing-latest)', () => {
  it('LEADING: the first call for an idle key runs immediately (no debounce delay)', async () => {
    const sched = createProviderScheduler({ delayMs: 20 });
    let ran = 0;
    const p = sched.run('semanticTokens|a.rs', async () => {
      ran += 1;
      return 'tokens';
    });
    expect(ran).toBe(1); // ran synchronously on the leading edge -- no first-paint delay
    await expect(p).resolves.toBe('tokens');
  });

  it('coalesces a burst to LEADING + one trailing-latest; the middle caller is cancelled', async () => {
    const sched = createProviderScheduler({ delayMs: 20 });
    const order: string[] = [];
    const leading = sched.run('semanticTokens|a.rs', async () => {
      order.push('leading');
      return 'leading';
    });
    const middle = sched.run('semanticTokens|a.rs', async () => {
      order.push('middle');
      return 'middle';
    });
    const latest = sched.run('semanticTokens|a.rs', async () => {
      order.push('latest');
      return 'latest';
    });
    await expect(leading).resolves.toBe('leading'); // leading delivered immediately
    await vi.advanceTimersByTimeAsync(20); // trailing-quiet window elapses -> trailing-latest runs
    const settled = await Promise.allSettled([middle, latest]);
    expect(order).toEqual(['leading', 'latest']); // middle exec NEVER ran (superseded)
    expect(settled[1]).toEqual({ status: 'fulfilled', value: 'latest' });
    expect(settled[0].status).toBe('rejected');
    expect(settled[0].status === 'rejected' && settled[0].reason instanceof ProviderSupersededError).toBe(true);
  });

  it('coarse-key churn: each DELIVERED caller gets its OWN data; superseded callers get no data', async () => {
    // Models scroll churn for a range provider keyed coarsely by method+uri: leading + latest deliver
    // data for their own range; the middle (stale range) is cancelled, never returns wrong-range data.
    const sched = createProviderScheduler({ delayMs: 20 });
    const r1 = sched.run('inlayHint|a.rs', async () => 'range1');
    const r2 = sched.run('inlayHint|a.rs', async () => 'range2');
    const r3 = sched.run('inlayHint|a.rs', async () => 'range3');
    await expect(r1).resolves.toBe('range1'); // leading delivers its own range
    await vi.advanceTimersByTimeAsync(20);
    await Promise.allSettled([r2, r3]);
    await expect(r3).resolves.toBe('range3'); // trailing-latest delivers the LATEST range
    await expect(r2).rejects.toBeInstanceOf(ProviderSupersededError); // stale middle range cancelled
  });

  it('runs distinct keys independently (each leads immediately)', async () => {
    const sched = createProviderScheduler({ delayMs: 10 });
    const a = sched.run('semanticTokens|a.rs', async () => 'A');
    const b = sched.run('codeLens|b.rs', async () => 'B');
    expect([await a, await b]).toEqual(['A', 'B']);
  });

  it('dispose aborts the in-flight run, rejects the queued caller, and prevents late runs', async () => {
    const sched = createProviderScheduler({ delayMs: 20 });
    let leadingAborted = false;
    const leading = sched.run('foldingRange|a.rs', async (signal) => {
      await new Promise((r) => setTimeout(r, 50));
      if (signal.aborted) leadingAborted = true;
      return 'leading';
    });
    const queued = sched.run('foldingRange|a.rs', async () => 'queued');
    sched.dispose();
    await expect(queued).rejects.toBeInstanceOf(ProviderSupersededError);
    await vi.advanceTimersByTimeAsync(50);
    await Promise.allSettled([leading]);
    expect(leadingAborted).toBe(true); // in-flight leading was aborted by dispose
    await expect(sched.run('foldingRange|a.rs', async () => 'late')).rejects.toBeInstanceOf(ProviderSupersededError);
  });

  it('does NOT deliver a late in-flight result after dispose: the caller rejects (cancellation), no late value', async () => {
    const sched = createProviderScheduler({ delayMs: 20 });
    let finishExec: () => void = () => {};
    const leading = sched.run('semanticTokens|a.rs', () =>
      // An exec that ignores its abort signal and resolves only when we let it -- AFTER dispose.
      new Promise<string>((resolve) => {
        finishExec = () => resolve('late');
      })
    );
    sched.dispose(); // aborts in-flight + marks disposed
    finishExec(); // exec resolves after dispose
    await expect(leading).rejects.toBeInstanceOf(ProviderSupersededError); // 'late' is NOT delivered to the caller
  });

  it('no starvation: an idle key always leads, and a single call resolves with its result', async () => {
    const sched = createProviderScheduler({ delayMs: 10 });
    const keys = ['semanticTokens|a.rs', 'codeLens|a.rs', 'documentSymbol|a.rs', 'foldingRange|a.rs', 'inlayHint|a.rs', 'codeAction|a.rs'];
    const results = await Promise.all(keys.map((k) => sched.run(k, async () => k)));
    expect(results).toEqual(keys);
  });
});

describe('providerDelayBounds (provider scheduling per-method windows)', () => {
  it('maps each scheduled burst method to its researched [min,max] window', () => {
    expect(providerDelayBounds('inlayHint|file:///a.rs')).toEqual({ minMs: 25, maxMs: 400 });
    expect(providerDelayBounds('semanticTokens|file:///a.rs')).toEqual({ minMs: 100, maxMs: 600 });
    expect(providerDelayBounds('foldingRange|file:///a.rs')).toEqual({ minMs: 200, maxMs: 600 });
    expect(providerDelayBounds('codeLens|file:///a.rs')).toEqual({ minMs: 250, maxMs: 800 });
    expect(providerDelayBounds('codeAction|file:///a.rs')).toEqual({ minMs: 250, maxMs: 800 });
    expect(providerDelayBounds('documentSymbol|file:///a.rs')).toEqual({ minMs: 350, maxMs: 1000 });
  });

  it('floors increase from inlay (fastest) to documentSymbol (slowest)', () => {
    const order = ['inlayHint', 'semanticTokens', 'foldingRange', 'codeLens', 'documentSymbol'].map(
      (m) => providerDelayBounds(`${m}|x`).minMs
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('falls back to a conservative default for an unknown method', () => {
    expect(providerDelayBounds('hover|file:///a.rs')).toEqual({ minMs: 150, maxMs: 600 });
    expect(providerDelayBounds('weird-no-pipe')).toEqual({ minMs: 150, maxMs: 600 });
  });

  it('every floor is <= its ceiling', () => {
    for (const m of ['inlayHint', 'semanticTokens', 'foldingRange', 'codeLens', 'codeAction', 'documentSymbol', 'unknown']) {
      const b = providerDelayBounds(`${m}|x`);
      expect(b.minMs).toBeLessThanOrEqual(b.maxMs);
    }
  });
});

describe('createProviderScheduler (provider scheduling adaptive trailing delay)', () => {
  // Drive a fresh burst on `key`, recording one observed latency, returning when the leading settles.
  // The injected clock advances by `latencyMs` during the exec so the scheduler records that latency.
  const burstLeading = async (sched: ReturnType<typeof createProviderScheduler>, key: string, clock: { t: number }, latencyMs: number): Promise<void> => {
    const p = sched.run(key, async () => {
      clock.t += latencyMs;
      return 'x';
    });
    await p;
  };

  // Issue a measurement burst on an idle key: a leading (in-flight) plus a trailing armed in the SAME
  // synchronous tick, so the trailing timer is armed against the already-warm latency ring (the leading's
  // own settle does not pollute the arm-time average). Returns a `ran` flag for the trailing exec.
  const measureBurst = (
    sched: ReturnType<typeof createProviderScheduler>,
    key: string
  ): { ran: () => boolean; settled: Promise<unknown> } => {
    const leading = sched.run(key, async () => 'L');
    let ran = false;
    const trailing = sched.run(key, async () => {
      ran = true;
      return 'T';
    });
    trailing.catch(() => undefined);
    return { ran: () => ran, settled: leading };
  };

  it('sets the trailing-quiet window to the observed latency, clamped within [min,max]', async () => {
    const clock = { t: 0 };
    const sched = createProviderScheduler({ boundsFor: () => ({ minMs: 20, maxMs: 500 }), now: () => clock.t });
    await burstLeading(sched, 'semanticTokens|a.rs', clock, 100); // observe 100ms

    const m = measureBurst(sched, 'semanticTokens|a.rs');
    await m.settled;
    await vi.advanceTimersByTimeAsync(99);
    expect(m.ran()).toBe(false); // below the adapted ~100ms window
    await vi.advanceTimersByTimeAsync(1);
    expect(m.ran()).toBe(true);
  });

  it('clamps the window UP to min when observed latency is tiny', async () => {
    const clock = { t: 0 };
    const sched = createProviderScheduler({ boundsFor: () => ({ minMs: 80, maxMs: 500 }), now: () => clock.t });
    await burstLeading(sched, 'codeLens|a.rs', clock, 5); // 5ms observed

    const m = measureBurst(sched, 'codeLens|a.rs');
    await m.settled;
    await vi.advanceTimersByTimeAsync(79);
    expect(m.ran()).toBe(false); // floored at min=80, not 5
    await vi.advanceTimersByTimeAsync(1);
    expect(m.ran()).toBe(true);
  });

  it('clamps the window DOWN to max when observed latency is huge', async () => {
    const clock = { t: 0 };
    const sched = createProviderScheduler({ boundsFor: () => ({ minMs: 20, maxMs: 250 }), now: () => clock.t });
    await burstLeading(sched, 'documentSymbol|a.rs', clock, 5000); // 5s observed

    const m = measureBurst(sched, 'documentSymbol|a.rs');
    await m.settled;
    await vi.advanceTimersByTimeAsync(249);
    expect(m.ran()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.ran()).toBe(true); // capped at max=250, never waits the full 5s
  });

  it('applies per-key bounds from boundsFor (method-specific windows), no history needed', async () => {
    const clock = { t: 0 };
    const boundsFor = (key: string): { minMs: number; maxMs: number } =>
      key.startsWith('inlayHint') ? { minMs: 25, maxMs: 25 } : { minMs: 350, maxMs: 350 };
    const sched = createProviderScheduler({ boundsFor, now: () => clock.t });

    // No prior history -> empty ring falls back to each key's floor.
    const inlay = measureBurst(sched, 'inlayHint|a.rs');
    const sym = measureBurst(sched, 'documentSymbol|a.rs');
    await Promise.all([inlay.settled, sym.settled]);

    await vi.advanceTimersByTimeAsync(25);
    expect(inlay.ran()).toBe(true); // inlay window = 25
    expect(sym.ran()).toBe(false); // docSymbol window = 350, still pending
    await vi.advanceTimersByTimeAsync(325);
    expect(sym.ran()).toBe(true);
  });

  it('averages a bounded sliding window of recent latencies (history persists across bursts)', async () => {
    const clock = { t: 0 };
    const sched = createProviderScheduler({ boundsFor: () => ({ minMs: 0, maxMs: 1000 }), windowSize: 2, now: () => clock.t });
    // Three bursts of latency 500, 100, 200; window=2 keeps only the last two -> avg(100,200)=150.
    await burstLeading(sched, 'foldingRange|a.rs', clock, 500);
    await burstLeading(sched, 'foldingRange|a.rs', clock, 100);
    await burstLeading(sched, 'foldingRange|a.rs', clock, 200);

    const m = measureBurst(sched, 'foldingRange|a.rs');
    await m.settled;
    await vi.advanceTimersByTimeAsync(149);
    expect(m.ran()).toBe(false); // avg of last two (100,200) = 150, not influenced by the dropped 500
    await vi.advanceTimersByTimeAsync(1);
    expect(m.ran()).toBe(true);
  });
});
