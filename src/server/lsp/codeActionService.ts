export interface CodeActionServiceInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  range: LspRange;
  context: CodeActionContext;
}

export interface CodeActionPlanInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  feature: 'codeAction';
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface CodeActionContext {
  diagnostics: unknown[];
  only?: string[];
  triggerKind?: number;
}

export interface CodeActionRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  isPrimary: boolean;
}

export interface CodeActionRequestPlan {
  targets: CodeActionRequestTarget[];
}

export interface CodeActionRequestPlanner {
  planLspRequest(input: CodeActionPlanInput): CodeActionRequestPlan | undefined;
}

export interface CodeActionRequestManager {
  sendRequest(
    target: CodeActionSessionTarget,
    method: 'textDocument/codeAction',
    params: CodeActionRequestParams
  ): Promise<unknown> | unknown;
}

export interface CodeActionSessionTarget {
  serverConfigId: string;
  workspaceRoot: string;
}

export interface CodeActionRequestParams {
  textDocument: {
    uri: string;
  };
  range: LspRange;
  context: CodeActionContext;
}

export interface CodeActionServiceDependencies {
  requestPlanner: CodeActionRequestPlanner;
  manager: CodeActionRequestManager;
}

export interface CodeActionService {
  codeActions(input: CodeActionServiceInput): Promise<CodeActionServiceResponse>;
}

export interface CodeActionServiceResponse {
  results: CodeActionServiceResult[];
}

export interface CodeActionServiceResult {
  serverConfigId: string;
  isPrimary: boolean;
  result: unknown;
}

export function createCodeActionService({
  requestPlanner,
  manager
}: CodeActionServiceDependencies): CodeActionService {
  return {
    async codeActions(input) {
      const plan = requestPlanner.planLspRequest({
        settings: input.settings,
        uri: input.uri,
        languageId: input.languageId,
        workspaceRoot: input.workspaceRoot,
        feature: 'codeAction'
      });

      if (!plan) {
        return { results: [] };
      }

      const results: CodeActionServiceResult[] = [];

      for (const target of plan.targets) {
        const result = await manager.sendRequest(
          { serverConfigId: target.serverConfigId, workspaceRoot: target.workspaceRoot },
          'textDocument/codeAction',
          { textDocument: { uri: input.uri }, range: input.range, context: input.context }
        );

        if (hasCodeActionResult(result)) {
          results.push({ serverConfigId: target.serverConfigId, isPrimary: target.isPrimary, result });
        }
      }

      return { results };
    }
  };
}

function hasCodeActionResult(result: unknown): boolean {
  return result != null && (!Array.isArray(result) || result.length > 0);
}
