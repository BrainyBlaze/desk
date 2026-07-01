export interface LspFeatureRouteRequest {
  serverConfigId: string;
  workspaceRoot: string;
  method: string;
  params: unknown;
}

export interface LspFeatureRouteTarget {
  serverConfigId: string;
  workspaceRoot: string;
}

export interface LspFeatureManager {
  sendRequest(target: LspFeatureRouteTarget, method: string, params: unknown): Promise<unknown>;
}

export class LspFeatureRouter {
  constructor(private readonly manager: LspFeatureManager) {}

  routeRequest(request: LspFeatureRouteRequest): Promise<unknown> {
    return this.manager.sendRequest(
      { serverConfigId: request.serverConfigId, workspaceRoot: request.workspaceRoot },
      request.method,
      request.params
    );
  }
}
