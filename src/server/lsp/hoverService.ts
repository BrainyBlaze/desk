export interface HoverServiceInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  position: LspPosition;
}

export interface HoverPlanInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  feature: 'hover';
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface HoverRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  isPrimary: boolean;
}

export interface HoverRequestPlan {
  targets: HoverRequestTarget[];
}

export interface HoverRequestPlanner {
  planLspRequest(input: HoverPlanInput): HoverRequestPlan | undefined;
}

export interface HoverRequestManager {
  sendRequest(target: HoverSessionTarget, method: 'textDocument/hover', params: HoverRequestParams): Promise<unknown> | unknown;
}

export interface HoverSessionTarget {
  serverConfigId: string;
  workspaceRoot: string;
}

export interface HoverRequestParams {
  textDocument: {
    uri: string;
  };
  position: LspPosition;
}

export interface HoverServiceDependencies {
  requestPlanner: HoverRequestPlanner;
  manager: HoverRequestManager;
}

export interface HoverService {
  hover(input: HoverServiceInput): Promise<HoverServiceResponse>;
}

export interface HoverServiceResponse {
  results: HoverServiceResult[];
}

export interface HoverServiceResult {
  serverConfigId: string;
  isPrimary: boolean;
  result: unknown;
}

export function createHoverService({ requestPlanner, manager }: HoverServiceDependencies): HoverService {
  return {
    async hover(input) {
      const plan = requestPlanner.planLspRequest({
        settings: input.settings,
        uri: input.uri,
        languageId: input.languageId,
        workspaceRoot: input.workspaceRoot,
        feature: 'hover'
      });

      if (!plan) {
        return { results: [] };
      }

      const params = {
        textDocument: { uri: input.uri },
        position: input.position
      };
      const results: HoverServiceResult[] = [];

      for (const target of plan.targets) {
        const result = await manager.sendRequest(
          { serverConfigId: target.serverConfigId, workspaceRoot: target.workspaceRoot },
          'textDocument/hover',
          params
        );

        if (result != null) {
          results.push({ serverConfigId: target.serverConfigId, isPrimary: target.isPrimary, result });
        }
      }

      return { results };
    }
  };
}
