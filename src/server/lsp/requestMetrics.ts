export interface LspRequestMetricDimensions {
  sessionId: string;
  consumerId?: string;
  method?: string;
}

export interface LspWriterErrorMetric {
  sessionId?: string;
}

export interface LspSessionExitRejectionMetric {
  sessionId: string;
  count: number;
}

export interface LspRequestMetricsRecorder {
  readonly enabled: boolean;
  requestStarted(dimensions: LspRequestMetricDimensions): void;
  requestSettled(dimensions: LspRequestMetricDimensions): void;
  requestCanceled(dimensions: LspRequestMetricDimensions): void;
  lateResponseDropped(dimensions: LspRequestMetricDimensions): void;
  writerError(dimensions: LspWriterErrorMetric): void;
  sessionExitRejected(dimensions: LspSessionExitRejectionMetric): void;
}

export interface LspRequestMetricsSnapshot {
  enabled: boolean;
  pending: {
    bySession: Record<string, number>;
    byConsumer: Record<string, number>;
    byMethod: Record<string, number>;
  };
  cancellations: {
    total: number;
    byMethod: Record<string, number>;
  };
  lateResponseDrops: {
    total: number;
  };
  writerErrors: {
    total: number;
  };
  sessionExitRejections: {
    total: number;
    bySession: Record<string, number>;
  };
}

export interface LspRequestMetricsCollectorOptions {
  enabled?: boolean;
}

export interface LspRequestMetricsCollector extends LspRequestMetricsRecorder {
  snapshot(): LspRequestMetricsSnapshot;
}

export function createLspRequestMetricsCollector(
  options: LspRequestMetricsCollectorOptions = {}
): LspRequestMetricsCollector {
  return new InMemoryLspRequestMetricsCollector(options.enabled === true);
}

export function isLspRequestMetricsEnabled(
  metrics: LspRequestMetricsRecorder | undefined
): metrics is LspRequestMetricsRecorder {
  return metrics?.enabled === true;
}

class InMemoryLspRequestMetricsCollector implements LspRequestMetricsCollector {
  readonly enabled: boolean;

  private readonly pendingBySession = new Map<string, number>();
  private readonly pendingByConsumer = new Map<string, number>();
  private readonly pendingByMethod = new Map<string, number>();
  private readonly cancellationsByMethod = new Map<string, number>();
  private readonly sessionExitRejectionsBySession = new Map<string, number>();
  private cancellationTotal = 0;
  private lateResponseDropTotal = 0;
  private writerErrorTotal = 0;
  private sessionExitRejectionTotal = 0;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  requestStarted(dimensions: LspRequestMetricDimensions): void {
    if (!this.enabled) {
      return;
    }
    increment(this.pendingBySession, dimensions.sessionId, 1);
    if (dimensions.consumerId) {
      increment(this.pendingByConsumer, dimensions.consumerId, 1);
    }
    if (dimensions.method) {
      increment(this.pendingByMethod, dimensions.method, 1);
    }
  }

  requestSettled(dimensions: LspRequestMetricDimensions): void {
    if (!this.enabled) {
      return;
    }
    increment(this.pendingBySession, dimensions.sessionId, -1);
    if (dimensions.consumerId) {
      increment(this.pendingByConsumer, dimensions.consumerId, -1);
    }
    if (dimensions.method) {
      increment(this.pendingByMethod, dimensions.method, -1);
    }
  }

  requestCanceled(dimensions: LspRequestMetricDimensions): void {
    if (!this.enabled) {
      return;
    }
    this.cancellationTotal += 1;
    if (dimensions.method) {
      increment(this.cancellationsByMethod, dimensions.method, 1);
    }
  }

  lateResponseDropped(): void {
    if (!this.enabled) {
      return;
    }
    this.lateResponseDropTotal += 1;
  }

  writerError(): void {
    if (!this.enabled) {
      return;
    }
    this.writerErrorTotal += 1;
  }

  sessionExitRejected(dimensions: LspSessionExitRejectionMetric): void {
    if (!this.enabled || dimensions.count <= 0) {
      return;
    }
    this.sessionExitRejectionTotal += dimensions.count;
    increment(this.sessionExitRejectionsBySession, dimensions.sessionId, dimensions.count);
  }

  snapshot(): LspRequestMetricsSnapshot {
    return {
      enabled: this.enabled,
      pending: {
        bySession: toRecord(this.pendingBySession),
        byConsumer: toRecord(this.pendingByConsumer),
        byMethod: toRecord(this.pendingByMethod)
      },
      cancellations: {
        total: this.cancellationTotal,
        byMethod: toRecord(this.cancellationsByMethod)
      },
      lateResponseDrops: {
        total: this.lateResponseDropTotal
      },
      writerErrors: {
        total: this.writerErrorTotal
      },
      sessionExitRejections: {
        total: this.sessionExitRejectionTotal,
        bySession: toRecord(this.sessionExitRejectionsBySession)
      }
    };
  }
}

function increment(map: Map<string, number>, key: string, delta: number): void {
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) {
    map.delete(key);
    return;
  }
  map.set(key, next);
}

function toRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}
