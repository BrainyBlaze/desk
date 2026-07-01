export interface FormattingServiceInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  options: FormattingOptions;
}

export interface FormattingOptions {
  tabSize: number;
  insertSpaces: boolean;
}

export interface FormattingPlanInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  feature: 'formatting';
}

export interface FormattingRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  isPrimary: boolean;
}

export interface FormattingRequestPlan {
  targets: FormattingRequestTarget[];
}

export interface FormattingRequestPlanner {
  planLspRequest(input: FormattingPlanInput): FormattingRequestPlan | undefined;
}

export interface FormattingRequestManager {
  sendRequest(
    target: FormattingSessionTarget,
    method: 'textDocument/formatting',
    params: FormattingRequestParams
  ): Promise<unknown> | unknown;
}

export interface FormattingSessionTarget {
  serverConfigId: string;
  workspaceRoot: string;
}

export interface FormattingRequestParams {
  textDocument: {
    uri: string;
  };
  options: FormattingOptions;
}

export interface FormattingServiceDependencies {
  requestPlanner: FormattingRequestPlanner;
  manager: FormattingRequestManager;
}

export interface FormattingService {
  formatDocument(input: FormattingServiceInput): Promise<FormattingServiceResponse>;
}

export type FormattingServiceResponse = FormattingServiceEditResponse | FormattingServiceEmptyResponse;

export interface FormattingServiceEditResponse {
  serverConfigId: string;
  isPrimary: boolean;
  result: unknown[];
}

export interface FormattingServiceEmptyResponse {
  result: [];
}

export function createFormattingService({ requestPlanner, manager }: FormattingServiceDependencies): FormattingService {
  return {
    async formatDocument(input) {
      const plan = requestPlanner.planLspRequest({
        settings: input.settings,
        uri: input.uri,
        languageId: input.languageId,
        workspaceRoot: input.workspaceRoot,
        feature: 'formatting'
      });

      const target = plan?.targets[0];
      if (!target) {
        return { result: [] };
      }

      const result = await manager.sendRequest(
        { serverConfigId: target.serverConfigId, workspaceRoot: target.workspaceRoot },
        'textDocument/formatting',
        { textDocument: { uri: input.uri }, options: input.options }
      );

      if (!Array.isArray(result) || result.length === 0) {
        return { result: [] };
      }

      return { serverConfigId: target.serverConfigId, isPrimary: target.isPrimary, result };
    }
  };
}
