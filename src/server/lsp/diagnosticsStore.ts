export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  message: string;
  severity?: number;
  code?: number | string;
  source?: string;
  tags?: number[];
}

export interface LspDiagnosticsSnapshot {
  uri: string;
  diagnostics: LspDiagnostic[];
}

export interface SetDiagnosticsOptions {
  uri: string;
  serverId: string;
  diagnostics: unknown[];
  version?: number;
  currentDocumentVersion?: number;
}

export interface ClearDiagnosticsOptions {
  uri: string;
  serverId: string;
}

interface DiagnosticBucket {
  diagnostics: LspDiagnostic[];
  version?: number;
}

export class LspDiagnosticsStore {
  private readonly bucketsByUri = new Map<string, Map<string, DiagnosticBucket>>();

  setDiagnostics(options: SetDiagnosticsOptions): LspDiagnosticsSnapshot {
    if (isStale(options.version, options.currentDocumentVersion)) {
      return this.getMergedDiagnostics(options.uri);
    }

    const buckets = this.getOrCreateBuckets(options.uri);
    buckets.set(options.serverId, {
      diagnostics: sanitizeLspDiagnostics(options.diagnostics),
      version: options.version
    });
    return this.getMergedDiagnostics(options.uri);
  }

  clearDiagnostics(options: ClearDiagnosticsOptions): LspDiagnosticsSnapshot {
    const buckets = this.bucketsByUri.get(options.uri);
    buckets?.delete(options.serverId);
    return this.getMergedDiagnostics(options.uri);
  }

  clearServerDiagnostics(serverId: string): LspDiagnosticsSnapshot[] {
    const snapshots: LspDiagnosticsSnapshot[] = [];
    for (const [uri, buckets] of this.bucketsByUri.entries()) {
      if (!buckets.has(serverId)) {
        continue;
      }
      buckets.delete(serverId);
      snapshots.push(this.getMergedDiagnostics(uri));
    }
    return snapshots;
  }

  getMergedDiagnostics(uri: string): LspDiagnosticsSnapshot {
    const buckets = this.bucketsByUri.get(uri);
    const diagnostics = buckets ? [...buckets.values()].flatMap((bucket) => bucket.diagnostics) : [];
    return { uri, diagnostics };
  }

  private getOrCreateBuckets(uri: string): Map<string, DiagnosticBucket> {
    const existing = this.bucketsByUri.get(uri);
    if (existing) {
      return existing;
    }

    const buckets = new Map<string, DiagnosticBucket>();
    this.bucketsByUri.set(uri, buckets);
    return buckets;
  }
}

function isStale(version: number | undefined, currentDocumentVersion: number | undefined): boolean {
  return version !== undefined && currentDocumentVersion !== undefined && version < currentDocumentVersion;
}

export function sanitizeLspDiagnostics(values: readonly unknown[]): LspDiagnostic[] {
  return values.map(sanitizeLspDiagnostic).filter((entry): entry is LspDiagnostic => Boolean(entry));
}

export function sanitizeLspDiagnostic(value: unknown): LspDiagnostic | undefined {
  if (!isRecord(value) || typeof value.message !== 'string') {
    return undefined;
  }
  const range = sanitizeRange(value.range);
  if (!range) {
    return undefined;
  }
  return {
    range,
    message: value.message,
    ...(typeof value.severity === 'number' ? { severity: value.severity } : {}),
    ...(typeof value.code === 'number' || typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof value.source === 'string' ? { source: value.source } : {}),
    ...(Array.isArray(value.tags) ? { tags: value.tags.filter((tag): tag is number => typeof tag === 'number') } : {})
  };
}

function sanitizeRange(value: unknown): LspRange | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const start = sanitizePosition(value.start);
  const end = sanitizePosition(value.end);
  if (!start || !end) {
    return undefined;
  }
  return { start, end };
}

function sanitizePosition(value: unknown): LspPosition | undefined {
  if (!isRecord(value) || typeof value.line !== 'number' || typeof value.character !== 'number') {
    return undefined;
  }
  return { line: value.line, character: value.character };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
