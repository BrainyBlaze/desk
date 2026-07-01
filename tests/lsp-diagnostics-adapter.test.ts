import { describe, expect, it } from 'vitest';
import { toLspDiagnostics, toMarkerData, MonacoMarkerSeverity } from '../src/web/editor/lsp/diagnosticsAdapter';

describe('toMarkerData', () => {
  it('converts an LSP diagnostic to a Monaco marker with 1-based range, mapped severity, and preserved source', () => {
    const markers = toMarkerData([
      {
        range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
        message: 'Cannot find name x',
        severity: 1,
        source: 'ts',
        code: 2304
      }
    ]);
    expect(markers).toEqual([
      {
        severity: MonacoMarkerSeverity.Error,
        message: 'Cannot find name x',
        startLineNumber: 3,
        startColumn: 5,
        endLineNumber: 3,
        endColumn: 10,
        source: 'ts',
        code: 2304
      }
    ]);
  });

  it('maps all four LSP severities to MonacoMarkerSeverity', () => {
    const severityOf = (lsp: number): number =>
      toMarkerData([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'm', severity: lsp }
      ])[0]!.severity;
    expect(severityOf(1)).toBe(MonacoMarkerSeverity.Error);
    expect(severityOf(2)).toBe(MonacoMarkerSeverity.Warning);
    expect(severityOf(3)).toBe(MonacoMarkerSeverity.Info);
    expect(severityOf(4)).toBe(MonacoMarkerSeverity.Hint);
  });

  it('maps diagnostic tags (Unnecessary/Deprecated)', () => {
    const markers = toMarkerData([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'm', severity: 2, tags: [1, 2] }
    ]);
    expect(markers[0]!.tags).toEqual([1, 2]);
  });
});

describe('toLspDiagnostics', () => {
  const baseMarker = {
    severity: MonacoMarkerSeverity.Error,
    message: 'boom',
    startLineNumber: 3,
    startColumn: 5,
    endLineNumber: 3,
    endColumn: 10
  };

  it('converts Monaco marker data to LSP diagnostics (0-based range, reversed severity)', () => {
    expect(toLspDiagnostics([baseMarker])).toEqual([
      {
        range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
        message: 'boom',
        severity: 1
      }
    ]);
  });

  it('reverses every severity level and defaults unknown to Error (1)', () => {
    const sev = (severity: number) =>
      toLspDiagnostics([{ ...baseMarker, severity }])[0]!.severity;
    expect(sev(MonacoMarkerSeverity.Hint)).toBe(4);
    expect(sev(MonacoMarkerSeverity.Info)).toBe(3);
    expect(sev(MonacoMarkerSeverity.Warning)).toBe(2);
    expect(sev(MonacoMarkerSeverity.Error)).toBe(1);
    expect(sev(99)).toBe(1);
  });

  it('passes a string code through unchanged', () => {
    expect(toLspDiagnostics([{ ...baseMarker, code: 'TS2304' }])[0]!.code).toBe('TS2304');
  });

  it('passes a numeric code through unchanged', () => {
    expect(toLspDiagnostics([{ ...baseMarker, code: 2304 }])[0]!.code).toBe(2304);
  });

  it('maps an object code to its value and drops the target', () => {
    const result = toLspDiagnostics([{ ...baseMarker, code: { value: 'TS2304', target: { scheme: 'https' } } }]);
    expect(result[0]!.code).toBe('TS2304');
  });

  it('omits code when absent', () => {
    expect('code' in toLspDiagnostics([baseMarker])[0]!).toBe(false);
  });

  it('passes source and tags through when present and omits them when absent', () => {
    const withExtras = toLspDiagnostics([{ ...baseMarker, source: 'ts', tags: [1, 2] }])[0]!;
    expect(withExtras.source).toBe('ts');
    expect(withExtras.tags).toEqual([1, 2]);
    const without = toLspDiagnostics([baseMarker])[0]!;
    expect('source' in without).toBe(false);
    expect('tags' in without).toBe(false);
  });

  it('returns an empty array for empty input', () => {
    expect(toLspDiagnostics([])).toEqual([]);
  });
});
