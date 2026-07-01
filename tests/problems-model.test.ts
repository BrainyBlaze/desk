import { describe, expect, it } from 'vitest';
import { aggregateProblems, type ProblemEntry } from '../src/web/editor/problemsModel';

// Monaco MarkerSeverity: Hint 1, Info 2, Warning 4, Error 8.
function entry(over: Partial<ProblemEntry>): ProblemEntry {
  return {
    uri: 'file:///root/src/a.ts',
    path: 'src/a.ts',
    severity: 8,
    message: 'msg',
    line: 1,
    column: 1,
    ...over
  };
}

describe('aggregateProblems', () => {
  it('returns empty groups and zero counts for no entries', () => {
    expect(aggregateProblems([])).toEqual({ groups: [], counts: { errors: 0, warnings: 0, infos: 0 }, total: 0 });
  });

  it('groups by file and counts by severity', () => {
    const result = aggregateProblems([
      entry({ uri: 'file:///root/src/a.ts', path: 'src/a.ts', severity: 8, message: 'e1', line: 5 }),
      entry({ uri: 'file:///root/src/a.ts', path: 'src/a.ts', severity: 4, message: 'w1', line: 2 }),
      entry({ uri: 'file:///root/src/b.py', path: 'src/b.py', severity: 2, message: 'i1', line: 1 })
    ]);
    expect(result.counts).toEqual({ errors: 1, warnings: 1, infos: 1 });
    expect(result.total).toBe(3);
    expect(result.groups.map((g) => g.path)).toEqual(['src/a.ts', 'src/b.py']); // groups sorted by path
    // within a.ts: error (sev 8) before warning (sev 4) regardless of line order
    expect(result.groups[0].items.map((i) => i.message)).toEqual(['e1', 'w1']);
    expect(result.groups[0].items[0].severity).toBe('error');
    expect(result.groups[0].items[1].severity).toBe('warning');
    expect(result.groups[1].items[0].severity).toBe('info');
  });

  it('maps severities: 8->error, 4->warning, 2->info, 1(hint)->info', () => {
    const sevs = aggregateProblems([
      entry({ severity: 8, line: 1 }),
      entry({ severity: 4, line: 2 }),
      entry({ severity: 2, line: 3 }),
      entry({ severity: 1, line: 4 })
    ]).groups[0].items.map((i) => i.severity);
    expect(sevs).toEqual(['error', 'warning', 'info', 'info']);
  });

  it('orders items by severity desc, then line asc, then column asc', () => {
    const items = aggregateProblems([
      entry({ severity: 4, line: 10, column: 1, message: 'w-l10' }),
      entry({ severity: 8, line: 9, column: 5, message: 'e-l9c5' }),
      entry({ severity: 8, line: 9, column: 2, message: 'e-l9c2' }),
      entry({ severity: 8, line: 3, column: 1, message: 'e-l3' })
    ]).groups[0].items.map((i) => i.message);
    expect(items).toEqual(['e-l3', 'e-l9c2', 'e-l9c5', 'w-l10']);
  });

  it('preserves source, code, line and column on items', () => {
    const item = aggregateProblems([
      entry({ message: 'boom', source: 'pyright', code: 'reportUndefinedVariable', line: 7, column: 12 })
    ]).groups[0].items[0];
    expect(item).toEqual({
      severity: 'error',
      message: 'boom',
      source: 'pyright',
      code: 'reportUndefinedVariable',
      line: 7,
      column: 12
    });
  });

  it('counts infos for both Info and Hint severities and totals correctly', () => {
    const r = aggregateProblems([entry({ severity: 2 }), entry({ severity: 1 }), entry({ severity: 8 })]);
    expect(r.counts).toEqual({ errors: 1, warnings: 0, infos: 2 });
    expect(r.total).toBe(3);
  });
});
