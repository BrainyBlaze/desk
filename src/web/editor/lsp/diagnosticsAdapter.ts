/**
 * Pure conversion of LSP diagnostics to Monaco marker data.
 *
 * Headless and pure: it produces the shape editor.setModelMarkers expects without
 * importing monaco-editor. The actual setModelMarkers call, per-(uri,serverId) bucket
 * merge, and connection subscription are later wiring steps.
 *
 * Severity numbering differs between the two: LSP DiagnosticSeverity is
 * 1=Error,2=Warning,3=Info,4=Hint; Monaco MarkerSeverity is Hint=1,Info=2,Warning=4,Error=8.
 */

/** Mirrors monaco.MarkerSeverity numeric values (without importing the editor). */
export const MonacoMarkerSeverity = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;
/** Mirrors monaco.MarkerTag numeric values. LSP DiagnosticTag uses the same numbers. */
export const MonacoMarkerTag = { Unnecessary: 1, Deprecated: 2 } as const;

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
  /** LSP DiagnosticSeverity: 1=Error,2=Warning,3=Info,4=Hint. Defaults to Error when absent. */
  severity?: number;
  source?: string;
  code?: string | number;
  /** LSP DiagnosticTag: 1=Unnecessary, 2=Deprecated. */
  tags?: number[];
}
export interface MonacoMarkerData {
  severity: number;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source?: string;
  code?: string | number;
  tags?: number[];
}

const LSP_TO_MONACO_SEVERITY: Record<number, number> = {
  1: MonacoMarkerSeverity.Error,
  2: MonacoMarkerSeverity.Warning,
  3: MonacoMarkerSeverity.Info,
  4: MonacoMarkerSeverity.Hint
};

/** Convert LSP diagnostics to Monaco marker data (1-based ranges, mapped severity, preserved source/code/tags). */
export function toMarkerData(diagnostics: ReadonlyArray<LspDiagnostic>): MonacoMarkerData[] {
  return diagnostics.map((diagnostic) => {
    const marker: MonacoMarkerData = {
      severity: LSP_TO_MONACO_SEVERITY[diagnostic.severity ?? 1] ?? MonacoMarkerSeverity.Error,
      message: diagnostic.message,
      startLineNumber: diagnostic.range.start.line + 1,
      startColumn: diagnostic.range.start.character + 1,
      endLineNumber: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1
    };
    if (diagnostic.source !== undefined) {
      marker.source = diagnostic.source;
    }
    if (diagnostic.code !== undefined) {
      marker.code = diagnostic.code;
    }
    // LSP and Monaco tag values coincide (1=Unnecessary, 2=Deprecated), so pass them through.
    if (diagnostic.tags !== undefined) {
      marker.tags = diagnostic.tags;
    }
    return marker;
  });
}

/**
 * Monaco IMarkerData as the editor hands it to a code-action provider. Note code may be an object
 * ({ value, target }) -- richer than the string|number that toMarkerData produces -- so the reverse
 * converter must normalize it.
 */
export interface MonacoMarkerInput {
  severity: number;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source?: string;
  code?: string | number | { value: string | number; target?: unknown };
  tags?: number[];
}

const MONACO_TO_LSP_SEVERITY: Record<number, number> = {
  [MonacoMarkerSeverity.Error]: 1,
  [MonacoMarkerSeverity.Warning]: 2,
  [MonacoMarkerSeverity.Info]: 3,
  [MonacoMarkerSeverity.Hint]: 4
};

/**
 * Reverse of toMarkerData: convert Monaco marker data (e.g. CodeActionContext.diagnostics) back to
 * LSP diagnostics. 0-based range, reversed severity (unknown -> Error/1), and code normalized to a
 * string/number -- an object code contributes its value and the Uri target is dropped (LSP has no slot).
 */
export function toLspDiagnostics(markers: ReadonlyArray<MonacoMarkerInput>): LspDiagnostic[] {
  return markers.map((marker) => {
    const diagnostic: LspDiagnostic = {
      range: {
        start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
        end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 }
      },
      message: marker.message,
      severity: MONACO_TO_LSP_SEVERITY[marker.severity] ?? 1
    };
    if (marker.source !== undefined) {
      diagnostic.source = marker.source;
    }
    if (marker.code !== undefined) {
      diagnostic.code = typeof marker.code === 'object' ? marker.code.value : marker.code;
    }
    if (marker.tags !== undefined) {
      diagnostic.tags = marker.tags;
    }
    return diagnostic;
  });
}
