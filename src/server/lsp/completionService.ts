export interface CompletionServiceInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  position: LspPosition;
  context?: CompletionContext;
}

export interface CompletionContext {
  triggerKind: number;
  triggerCharacter?: string;
}

export interface CompletionPlanInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  feature: 'completion';
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface CompletionRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  isPrimary: boolean;
}

export interface CompletionRequestPlan {
  targets: CompletionRequestTarget[];
}

export interface CompletionRequestPlanner {
  planLspRequest(input: CompletionPlanInput): CompletionRequestPlan | undefined;
}

export interface CompletionRequestManager {
  sendRequest(
    target: CompletionSessionTarget,
    method: 'textDocument/completion',
    params: CompletionRequestParams
  ): Promise<unknown> | unknown;
}

export interface CompletionSessionTarget {
  serverConfigId: string;
  workspaceRoot: string;
}

export interface CompletionRequestParams {
  textDocument: {
    uri: string;
  };
  position: LspPosition;
  context?: CompletionContext;
}

export interface CompletionServiceDependencies {
  requestPlanner: CompletionRequestPlanner;
  manager: CompletionRequestManager;
}

export interface CompletionService {
  complete(input: CompletionServiceInput): Promise<CompletionServiceResponse>;
}

export type CompletionServiceResponse = CompletionServiceResult | CompletionServiceEmptyResult;

export interface CompletionServiceResult {
  serverConfigId: string;
  isPrimary: boolean;
  result: unknown;
}

export interface CompletionServiceEmptyResult {
  result: null;
}

export function createCompletionService({ requestPlanner, manager }: CompletionServiceDependencies): CompletionService {
  return {
    async complete(input) {
      const plan = requestPlanner.planLspRequest({
        settings: input.settings,
        uri: input.uri,
        languageId: input.languageId,
        workspaceRoot: input.workspaceRoot,
        feature: 'completion'
      });
      const target = selectCompletionTarget(plan?.targets ?? []);
      if (!target) {
        return { result: null };
      }

      const params = {
        textDocument: { uri: input.uri },
        position: input.position,
        ...(input.context ? { context: input.context } : {})
      };
      const result = await manager.sendRequest(
        { serverConfigId: target.serverConfigId, workspaceRoot: target.workspaceRoot },
        'textDocument/completion',
        params
      );

      if (result == null) {
        return { result: null };
      }

      return { serverConfigId: target.serverConfigId, isPrimary: target.isPrimary, result };
    }
  };
}

function selectCompletionTarget(targets: CompletionRequestTarget[]): CompletionRequestTarget | undefined {
  return targets.find((target) => target.isPrimary) ?? targets[0];
}
