export interface SemanticTokensServiceInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
}

export interface SemanticTokensPlanInput {
  settings: unknown;
  uri?: string;
  languageId?: string;
  workspaceRoot: string;
  feature: 'semanticTokens';
}

export interface SemanticTokensRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  isPrimary: boolean;
}

export interface SemanticTokensRequestPlan {
  targets: SemanticTokensRequestTarget[];
}

export interface SemanticTokensRequestPlanner {
  planLspRequest(input: SemanticTokensPlanInput): SemanticTokensRequestPlan | undefined;
}

export interface SemanticTokensRequestManager {
  sendRequest(
    target: SemanticTokensSessionTarget,
    method: 'textDocument/semanticTokens/full',
    params: SemanticTokensRequestParams
  ): Promise<unknown> | unknown;
  getCapabilities?(target: SemanticTokensSessionTarget): Record<string, unknown> | undefined;
}

export interface SemanticTokensSessionTarget {
  serverConfigId: string;
  workspaceRoot: string;
}

export interface SemanticTokensRequestParams {
  textDocument: {
    uri: string;
  };
}

export interface SemanticTokensServiceDependencies {
  requestPlanner: SemanticTokensRequestPlanner;
  manager: SemanticTokensRequestManager;
}

export interface SemanticTokensService {
  semanticTokens(input: SemanticTokensServiceInput): Promise<SemanticTokensServiceResponse>;
}

export interface SemanticTokensServiceResponse {
  results: SemanticTokensServiceResult[];
}

export interface SemanticTokensServiceResult {
  serverConfigId: string;
  isPrimary: boolean;
  result: SafeSemanticTokens;
  legend?: SafeSemanticTokensLegend;
  semanticTokensProvider?: SafeSemanticTokensProvider;
}

export interface SafeSemanticTokens {
  data: number[];
}

export interface SafeSemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export interface SafeSemanticTokensProvider {
  full?: boolean | { delta?: boolean };
  range?: boolean;
}

export function createSemanticTokensService({
  requestPlanner,
  manager
}: SemanticTokensServiceDependencies): SemanticTokensService {
  return {
    async semanticTokens(input) {
      const plan = requestPlanner.planLspRequest({
        settings: input.settings,
        uri: input.uri,
        languageId: input.languageId,
        workspaceRoot: input.workspaceRoot,
        feature: 'semanticTokens'
      });
      if (!plan) {
        return { results: [] };
      }

      const results: SemanticTokensServiceResult[] = [];
      for (const target of plan.targets) {
        const sessionTarget = { serverConfigId: target.serverConfigId, workspaceRoot: target.workspaceRoot };
        const rawResult = await manager.sendRequest(sessionTarget, 'textDocument/semanticTokens/full', {
          textDocument: { uri: input.uri }
        });
        const result = sanitizeSemanticTokens(rawResult);
        if (!result) {
          continue;
        }
        const providerContext = sanitizeSemanticTokensProvider(
          manager.getCapabilities?.(sessionTarget)?.semanticTokensProvider
        );
        results.push({
          serverConfigId: target.serverConfigId,
          isPrimary: target.isPrimary,
          result,
          ...(providerContext.legend ? { legend: providerContext.legend } : {}),
          ...(providerContext.semanticTokensProvider
            ? { semanticTokensProvider: providerContext.semanticTokensProvider }
            : {})
        });
      }
      return { results };
    }
  };
}

export function sanitizeSemanticTokensResponse(value: unknown): SemanticTokensServiceResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    return { results: [] };
  }
  const results: SemanticTokensServiceResult[] = [];
  for (const entry of value.results) {
    if (!isRecord(entry) || typeof entry.serverConfigId !== 'string' || typeof entry.isPrimary !== 'boolean') {
      continue;
    }
    const result = sanitizeSemanticTokens(entry.result);
    if (!result) {
      continue;
    }
    const providerContext = sanitizeSemanticTokensProvider(entry.semanticTokensProvider);
    results.push({
      serverConfigId: entry.serverConfigId,
      isPrimary: entry.isPrimary,
      result,
      ...(isSafeLegend(entry.legend) ? { legend: entry.legend } : providerContext.legend ? { legend: providerContext.legend } : {}),
      ...(providerContext.semanticTokensProvider
        ? { semanticTokensProvider: providerContext.semanticTokensProvider }
        : {})
    });
  }
  return { results };
}

export function sanitizeSemanticTokens(value: unknown): SafeSemanticTokens | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return undefined;
  }
  if (value.data.length % 5 !== 0) {
    return undefined;
  }
  if (!value.data.every((entry) => Number.isInteger(entry) && entry >= 0)) {
    return undefined;
  }
  return { data: value.data.slice() as number[] };
}

function sanitizeSemanticTokensProvider(value: unknown): {
  legend?: SafeSemanticTokensLegend;
  semanticTokensProvider?: SafeSemanticTokensProvider;
} {
  if (!isRecord(value)) {
    return {};
  }
  const provider: SafeSemanticTokensProvider = {};
  if (typeof value.full === 'boolean') {
    provider.full = value.full;
  } else if (isRecord(value.full)) {
    const full: { delta?: boolean } = {};
    if (typeof value.full.delta === 'boolean') {
      full.delta = value.full.delta;
    }
    provider.full = full;
  }
  if (typeof value.range === 'boolean') {
    provider.range = value.range;
  }
  const legend = sanitizeLegend(value.legend);
  return {
    ...(legend ? { legend } : {}),
    ...(Object.keys(provider).length > 0 ? { semanticTokensProvider: provider } : {})
  };
}

function sanitizeLegend(value: unknown): SafeSemanticTokensLegend | undefined {
  if (!isRecord(value) || !Array.isArray(value.tokenTypes) || !Array.isArray(value.tokenModifiers)) {
    return undefined;
  }
  if (!value.tokenTypes.every((entry) => typeof entry === 'string')) {
    return undefined;
  }
  if (!value.tokenModifiers.every((entry) => typeof entry === 'string')) {
    return undefined;
  }
  return { tokenTypes: value.tokenTypes.slice() as string[], tokenModifiers: value.tokenModifiers.slice() as string[] };
}

function isSafeLegend(value: unknown): value is SafeSemanticTokensLegend {
  return sanitizeLegend(value) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
