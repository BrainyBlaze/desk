/**
 * Pure aggregation for the Problems panel. Takes already-normalized problem entries (the caller in
 * EditorSubsystem scopes these to in-root open text models and maps the file path root-relative, so
 * this module imports no monaco and stays headless-testable) and produces file-grouped, severity-
 * ordered groups plus error/warning/info counts.
 *
 * Severity is the raw Monaco MarkerSeverity number (Hint 1, Info 2, Warning 4, Error 8).
 */

export interface ProblemEntry {
  uri: string;
  /** root-relative display path */
  path: string;
  severity: number;
  message: string;
  source?: string;
  code?: string;
  line: number;
  column: number;
}

export type ProblemSeverity = 'error' | 'warning' | 'info';

export interface ProblemItem {
  severity: ProblemSeverity;
  message: string;
  source?: string;
  code?: string;
  line: number;
  column: number;
}

export interface ProblemGroup {
  uri: string;
  path: string;
  items: ProblemItem[];
}

export interface ProblemsModel {
  groups: ProblemGroup[];
  counts: { errors: number; warnings: number; infos: number };
  total: number;
}

function severityLabel(severity: number): ProblemSeverity {
  if (severity >= 8) {
    return 'error';
  }
  if (severity >= 4) {
    return 'warning';
  }
  return 'info';
}

/** Higher first (Error 8 -> Warning 4 -> Info 2 -> Hint 1). */
function severityRank(severity: number): number {
  return severity;
}

export function aggregateProblems(entries: ProblemEntry[]): ProblemsModel {
  const byUri = new Map<string, { path: string; entries: ProblemEntry[] }>();
  const counts = { errors: 0, warnings: 0, infos: 0 };

  for (const entry of entries) {
    const label = severityLabel(entry.severity);
    if (label === 'error') {
      counts.errors += 1;
    } else if (label === 'warning') {
      counts.warnings += 1;
    } else {
      counts.infos += 1;
    }
    const bucket = byUri.get(entry.uri);
    if (bucket) {
      bucket.entries.push(entry);
    } else {
      byUri.set(entry.uri, { path: entry.path, entries: [entry] });
    }
  }

  const groups: ProblemGroup[] = [...byUri.entries()]
    .map(([uri, bucket]) => ({
      uri,
      path: bucket.path,
      items: bucket.entries
        .slice()
        .sort(
          (a, b) =>
            severityRank(b.severity) - severityRank(a.severity) || a.line - b.line || a.column - b.column
        )
        .map((entry) => {
          const item: ProblemItem = {
            severity: severityLabel(entry.severity),
            message: entry.message,
            line: entry.line,
            column: entry.column
          };
          if (entry.source !== undefined) {
            item.source = entry.source;
          }
          if (entry.code !== undefined) {
            item.code = entry.code;
          }
          return item;
        })
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return { groups, counts, total: entries.length };
}
