export interface DocumentHighlightServiceInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  position: LspPosition;
}

export interface DocumentHighlightPlanInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  feature: 'documentHighlight';
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface DocumentHighlightRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  isPrimary: boolean;
}

export interface DocumentHighlightRequestPlan {
  targets: DocumentHighlightRequestTarget[];
}

export interface DocumentHighlightRequestPlanner {
  planLspRequest(input: DocumentHighlightPlanInput): DocumentHighlightRequestPlan | undefined;
}

export interface DocumentHighlightRequestManager {
  sendRequest(
    target: DocumentHighlightSessionTarget,
    method: 'textDocument/documentHighlight',
    params: DocumentHighlightRequestParams
  ): Promise<unknown> | unknown;
}

export interface DocumentHighlightSessionTarget {
  serverConfigId: string;
  workspaceRoot: string;
}

export interface DocumentHighlightRequestParams {
  textDocument: {
    uri: string;
  };
  position: LspPosition;
}

export interface DocumentHighlightServiceDependencies {
  requestPlanner: DocumentHighlightRequestPlanner;
  manager: DocumentHighlightRequestManager;
}

export interface DocumentHighlightService {
  documentHighlights(input: DocumentHighlightServiceInput): Promise<DocumentHighlightServiceResponse>;
}

export interface DocumentHighlightServiceResponse {
  results: DocumentHighlightServiceResult[];
}

export interface DocumentHighlightServiceResult {
  serverConfigId: string;
  isPrimary: boolean;
  result: unknown;
}

export function createDocumentHighlightService({
  requestPlanner,
  manager
}: DocumentHighlightServiceDependencies): DocumentHighlightService {
  return {
    async documentHighlights(input) {
      const plan = requestPlanner.planLspRequest({
        settings: input.settings,
        uri: input.uri,
        languageId: input.languageId,
        workspaceRoot: input.workspaceRoot,
        feature: 'documentHighlight'
      });

      if (!plan) {
        return { results: [] };
      }

      const results: DocumentHighlightServiceResult[] = [];

      for (const target of plan.targets) {
        const result = await manager.sendRequest(
          { serverConfigId: target.serverConfigId, workspaceRoot: target.workspaceRoot },
          'textDocument/documentHighlight',
          { textDocument: { uri: input.uri }, position: input.position }
        );

        if (hasDocumentHighlightResult(result)) {
          results.push({ serverConfigId: target.serverConfigId, isPrimary: target.isPrimary, result });
        }
      }

      return { results };
    }
  };
}

function hasDocumentHighlightResult(result: unknown): boolean {
  return result != null && (!Array.isArray(result) || result.length > 0);
}
