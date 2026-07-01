export interface SelectionRangePosition {
  line: number;
  character: number;
}

export interface SelectionRangeServiceInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  positions: SelectionRangePosition[];
}

export interface SelectionRangePlanInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  feature: 'selectionRange';
}

export interface SelectionRangeRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  isPrimary: boolean;
}

export interface SelectionRangeRequestPlan {
  targets: SelectionRangeRequestTarget[];
}

export interface SelectionRangeRequestPlanner {
  planLspRequest(input: SelectionRangePlanInput): SelectionRangeRequestPlan | undefined;
}

export interface SelectionRangeRequestManager {
  sendRequest(
    target: SelectionRangeSessionTarget,
    method: 'textDocument/selectionRange',
    params: SelectionRangeRequestParams
  ): Promise<unknown> | unknown;
}

export interface SelectionRangeSessionTarget {
  serverConfigId: string;
  workspaceRoot: string;
}

export interface SelectionRangeRequestParams {
  textDocument: {
    uri: string;
  };
  positions: SelectionRangePosition[];
}

export interface SelectionRangeServiceDependencies {
  requestPlanner: SelectionRangeRequestPlanner;
  manager: SelectionRangeRequestManager;
}

export interface SelectionRangeService {
  selectionRanges(input: SelectionRangeServiceInput): Promise<SelectionRangeServiceResponse>;
}

export interface SelectionRangeServiceResponse {
  results: SelectionRangeServiceResult[];
}

export interface SelectionRangeServiceResult {
  serverConfigId: string;
  isPrimary: boolean;
  result: SafeSelectionRange[];
}

export interface SafeSelectionRange {
  range: SafeRange;
  parent?: SafeSelectionRange;
}

export interface SafeRange {
  start: SelectionRangePosition;
  end: SelectionRangePosition;
}

export const MAX_SELECTION_RANGE_POSITIONS = 100;
const MAX_SELECTION_PARENT_DEPTH = 64;

export function createSelectionRangeService({
  requestPlanner,
  manager
}: SelectionRangeServiceDependencies): SelectionRangeService {
  return {
    async selectionRanges(input) {
      const plan = requestPlanner.planLspRequest({
        settings: input.settings,
        uri: input.uri,
        languageId: input.languageId,
        workspaceRoot: input.workspaceRoot,
        feature: 'selectionRange'
      });

      if (!plan) {
        return { results: [] };
      }

      const results: SelectionRangeServiceResult[] = [];
      for (const target of plan.targets) {
        const rawResult = await manager.sendRequest(
          { serverConfigId: target.serverConfigId, workspaceRoot: target.workspaceRoot },
          'textDocument/selectionRange',
          { textDocument: { uri: input.uri }, positions: input.positions }
        );
        const result = sanitizeSelectionRanges(rawResult);
        if (result.length > 0) {
          results.push({ serverConfigId: target.serverConfigId, isPrimary: target.isPrimary, result });
        }
      }

      return { results };
    }
  };
}

export function sanitizeSelectionRangeResponse(value: unknown): SelectionRangeServiceResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    return { results: [] };
  }

  const results: SelectionRangeServiceResult[] = [];
  for (const entry of value.results) {
    if (!isRecord(entry) || typeof entry.serverConfigId !== 'string' || typeof entry.isPrimary !== 'boolean') {
      continue;
    }
    const result = sanitizeSelectionRanges(entry.result);
    if (result.length > 0) {
      results.push({ serverConfigId: entry.serverConfigId, isPrimary: entry.isPrimary, result });
    }
  }
  return { results };
}

export function sanitizeSelectionRanges(value: unknown): SafeSelectionRange[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const ranges: SafeSelectionRange[] = [];
  for (const entry of value) {
    const range = sanitizeSelectionRange(entry, 0, new WeakSet<object>());
    if (range) {
      ranges.push(range);
    }
  }
  return ranges;
}

export function isSelectionRangePositions(value: unknown): value is SelectionRangePosition[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_SELECTION_RANGE_POSITIONS &&
    value.every(isPosition)
  );
}

function sanitizeSelectionRange(
  value: unknown,
  depth: number,
  seen: WeakSet<object>
): SafeSelectionRange | undefined {
  if (!isRecord(value) || depth >= MAX_SELECTION_PARENT_DEPTH || seen.has(value)) {
    return undefined;
  }

  const range = sanitizeRange(value.range);
  if (!range) {
    return undefined;
  }

  seen.add(value);
  const sanitized: SafeSelectionRange = { range };
  const parent = sanitizeSelectionRange(value.parent, depth + 1, seen);
  if (parent) {
    sanitized.parent = parent;
  }
  seen.delete(value);
  return sanitized;
}

function sanitizeRange(value: unknown): SafeRange | undefined {
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

function sanitizePosition(value: unknown): SelectionRangePosition | undefined {
  if (!isPosition(value)) {
    return undefined;
  }
  return { line: value.line, character: value.character };
}

function isPosition(value: unknown): value is SelectionRangePosition {
  return (
    isRecord(value) &&
    typeof value.line === 'number' &&
    Number.isInteger(value.line) &&
    value.line >= 0 &&
    typeof value.character === 'number' &&
    Number.isInteger(value.character) &&
    value.character >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
