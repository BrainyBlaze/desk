export interface DocumentSymbolServiceInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
}

export interface DocumentSymbolPlanInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  feature: 'documentSymbol';
}

export interface DocumentSymbolRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  isPrimary: boolean;
}

export interface DocumentSymbolRequestPlan {
  targets: DocumentSymbolRequestTarget[];
}

export interface DocumentSymbolRequestPlanner {
  planLspRequest(input: DocumentSymbolPlanInput): DocumentSymbolRequestPlan | undefined;
}

export interface DocumentSymbolRequestManager {
  sendRequest(
    target: DocumentSymbolSessionTarget,
    method: 'textDocument/documentSymbol',
    params: DocumentSymbolRequestParams
  ): Promise<unknown> | unknown;
}

export interface DocumentSymbolSessionTarget {
  serverConfigId: string;
  workspaceRoot: string;
}

export interface DocumentSymbolRequestParams {
  textDocument: {
    uri: string;
  };
}

export interface DocumentSymbolServiceDependencies {
  requestPlanner: DocumentSymbolRequestPlanner;
  manager: DocumentSymbolRequestManager;
}

export interface DocumentSymbolService {
  documentSymbols(input: DocumentSymbolServiceInput): Promise<DocumentSymbolServiceResponse>;
}

export interface DocumentSymbolServiceResponse {
  results: DocumentSymbolServiceResult[];
}

export interface DocumentSymbolServiceResult {
  serverConfigId: string;
  isPrimary: boolean;
  result: unknown;
}

export function createDocumentSymbolService({
  requestPlanner,
  manager
}: DocumentSymbolServiceDependencies): DocumentSymbolService {
  return {
    async documentSymbols(input) {
      const plan = requestPlanner.planLspRequest({
        settings: input.settings,
        uri: input.uri,
        languageId: input.languageId,
        workspaceRoot: input.workspaceRoot,
        feature: 'documentSymbol'
      });

      if (!plan) {
        return { results: [] };
      }

      const results: DocumentSymbolServiceResult[] = [];

      for (const target of plan.targets) {
        const result = await manager.sendRequest(
          { serverConfigId: target.serverConfigId, workspaceRoot: target.workspaceRoot },
          'textDocument/documentSymbol',
          { textDocument: { uri: input.uri } }
        );

        if (hasDocumentSymbolResult(result)) {
          results.push({ serverConfigId: target.serverConfigId, isPrimary: target.isPrimary, result });
        }
      }

      return { results };
    }
  };
}

function hasDocumentSymbolResult(result: unknown): boolean {
  return result != null && (!Array.isArray(result) || result.length > 0);
}
