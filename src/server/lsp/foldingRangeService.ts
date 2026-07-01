export interface FoldingRangeServiceInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
}

export interface FoldingRangePlanInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  feature: 'foldingRange';
}

export interface FoldingRangeRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  isPrimary: boolean;
}

export interface FoldingRangeRequestPlan {
  targets: FoldingRangeRequestTarget[];
}

export interface FoldingRangeRequestPlanner {
  planLspRequest(input: FoldingRangePlanInput): FoldingRangeRequestPlan | undefined;
}

export interface FoldingRangeRequestManager {
  sendRequest(
    target: FoldingRangeSessionTarget,
    method: 'textDocument/foldingRange',
    params: FoldingRangeRequestParams
  ): Promise<unknown> | unknown;
}

export interface FoldingRangeSessionTarget {
  serverConfigId: string;
  workspaceRoot: string;
}

export interface FoldingRangeRequestParams {
  textDocument: {
    uri: string;
  };
}

export interface FoldingRangeServiceDependencies {
  requestPlanner: FoldingRangeRequestPlanner;
  manager: FoldingRangeRequestManager;
}

export interface FoldingRangeService {
  foldingRanges(input: FoldingRangeServiceInput): Promise<FoldingRangeServiceResponse>;
}

export interface FoldingRangeServiceResponse {
  results: FoldingRangeServiceResult[];
}

export interface FoldingRangeServiceResult {
  serverConfigId: string;
  isPrimary: boolean;
  result: SafeFoldingRange[];
}

export interface SafeFoldingRange {
  startLine: number;
  endLine: number;
  startCharacter?: number;
  endCharacter?: number;
  kind?: 'comment' | 'imports' | 'region';
}

const FOLDING_RANGE_KINDS = new Set(['comment', 'imports', 'region']);

export function createFoldingRangeService({
  requestPlanner,
  manager
}: FoldingRangeServiceDependencies): FoldingRangeService {
  return {
    async foldingRanges(input) {
      const plan = requestPlanner.planLspRequest({
        settings: input.settings,
        uri: input.uri,
        languageId: input.languageId,
        workspaceRoot: input.workspaceRoot,
        feature: 'foldingRange'
      });

      if (!plan) {
        return { results: [] };
      }

      const results: FoldingRangeServiceResult[] = [];
      for (const target of plan.targets) {
        const rawResult = await manager.sendRequest(
          { serverConfigId: target.serverConfigId, workspaceRoot: target.workspaceRoot },
          'textDocument/foldingRange',
          { textDocument: { uri: input.uri } }
        );
        const result = sanitizeFoldingRanges(rawResult);
        if (result.length > 0) {
          results.push({ serverConfigId: target.serverConfigId, isPrimary: target.isPrimary, result });
        }
      }

      return { results };
    }
  };
}

export function sanitizeFoldingRangeResponse(value: unknown): FoldingRangeServiceResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    return { results: [] };
  }

  const results: FoldingRangeServiceResult[] = [];
  for (const entry of value.results) {
    if (!isRecord(entry) || typeof entry.serverConfigId !== 'string' || typeof entry.isPrimary !== 'boolean') {
      continue;
    }
    const result = sanitizeFoldingRanges(entry.result);
    if (result.length > 0) {
      results.push({ serverConfigId: entry.serverConfigId, isPrimary: entry.isPrimary, result });
    }
  }
  return { results };
}

export function sanitizeFoldingRanges(value: unknown): SafeFoldingRange[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const ranges: SafeFoldingRange[] = [];
  for (const entry of value) {
    const range = sanitizeFoldingRange(entry);
    if (range) {
      ranges.push(range);
    }
  }
  return ranges;
}

function sanitizeFoldingRange(value: unknown): SafeFoldingRange | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const startLine = toNonNegativeInteger(value.startLine);
  const endLine = toNonNegativeInteger(value.endLine);
  if (startLine === undefined || endLine === undefined || endLine < startLine) {
    return undefined;
  }

  const range: SafeFoldingRange = { startLine, endLine };
  const startCharacter = toNonNegativeInteger(value.startCharacter);
  const endCharacter = toNonNegativeInteger(value.endCharacter);
  if (startCharacter !== undefined) {
    range.startCharacter = startCharacter;
  }
  if (endCharacter !== undefined) {
    range.endCharacter = endCharacter;
  }
  if (typeof value.kind === 'string' && FOLDING_RANGE_KINDS.has(value.kind)) {
    range.kind = value.kind as SafeFoldingRange['kind'];
  }
  return range;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
