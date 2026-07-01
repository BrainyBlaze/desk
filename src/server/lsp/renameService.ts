export interface RenameServiceInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  position: LspPosition;
}

export interface RenameExecutionServiceInput extends RenameServiceInput {
  newName: string;
}

export interface RenamePlanInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  feature: 'rename';
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface RenameRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  isPrimary: boolean;
}

export interface RenameRequestPlan {
  targets: RenameRequestTarget[];
}

export interface RenameRequestPlanner {
  planLspRequest(input: RenamePlanInput): RenameRequestPlan | undefined;
}

export interface RenameRequestManager {
  sendRequest(
    target: RenameSessionTarget,
    method: 'textDocument/prepareRename',
    params: RenamePrepareRequestParams
  ): Promise<unknown> | unknown;
  sendRequest(
    target: RenameSessionTarget,
    method: 'textDocument/rename',
    params: RenameRequestParams
  ): Promise<unknown> | unknown;
}

export interface RenameSessionTarget {
  serverConfigId: string;
  workspaceRoot: string;
}

export interface RenamePrepareRequestParams {
  textDocument: {
    uri: string;
  };
  position: LspPosition;
}

export interface RenameRequestParams extends RenamePrepareRequestParams {
  newName: string;
}

export interface RenameServiceDependencies {
  requestPlanner: RenameRequestPlanner;
  manager: RenameRequestManager;
}

export interface RenameService {
  rename(input: RenameExecutionServiceInput): Promise<RenameServiceResponse>;
  prepareRename(input: RenameServiceInput): Promise<RenameServiceResponse>;
}

export type RenameServiceResponse = RenameServiceResult | RenameServiceEmptyResult;

export interface RenameServiceResult {
  serverConfigId: string;
  isPrimary: boolean;
  result: unknown;
}

export interface RenameServiceEmptyResult {
  result: null;
}

export function createRenameService({ requestPlanner, manager }: RenameServiceDependencies): RenameService {
  return {
    async rename(input) {
      const target = selectRenameTarget(planRenameTargets(requestPlanner, input));
      if (!target) {
        return { result: null };
      }

      const result = await manager.sendRequest(
        { serverConfigId: target.serverConfigId, workspaceRoot: target.workspaceRoot },
        'textDocument/rename',
        {
          textDocument: { uri: input.uri },
          position: input.position,
          newName: input.newName
        }
      );

      if (result == null) {
        return { result: null };
      }

      return { serverConfigId: target.serverConfigId, isPrimary: target.isPrimary, result };
    },

    async prepareRename(input) {
      const target = selectRenameTarget(planRenameTargets(requestPlanner, input));
      if (!target) {
        return { result: null };
      }

      const result = await manager.sendRequest(
        { serverConfigId: target.serverConfigId, workspaceRoot: target.workspaceRoot },
        'textDocument/prepareRename',
        {
          textDocument: { uri: input.uri },
          position: input.position
        }
      );

      if (result == null) {
        return { result: null };
      }

      return { serverConfigId: target.serverConfigId, isPrimary: target.isPrimary, result };
    }
  };
}

function planRenameTargets(requestPlanner: RenameRequestPlanner, input: RenameServiceInput): RenameRequestTarget[] {
  const plan = requestPlanner.planLspRequest({
    settings: input.settings,
    uri: input.uri,
    languageId: input.languageId,
    workspaceRoot: input.workspaceRoot,
    feature: 'rename'
  });

  return plan?.targets ?? [];
}

function selectRenameTarget(targets: RenameRequestTarget[]): RenameRequestTarget | undefined {
  return targets.find((target) => target.isPrimary) ?? targets[0];
}
