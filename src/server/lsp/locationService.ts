export interface LocationServiceInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  position: LspPosition;
}

export interface LocationReferencesInput extends LocationServiceInput {
  includeDeclaration: boolean;
}

export interface LocationPlanInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  feature: LocationFeature;
}

export type LocationFeature = 'definition' | 'references' | 'typeDefinition' | 'implementation' | 'declaration';

export interface LspPosition {
  line: number;
  character: number;
}

export interface LocationRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  isPrimary: boolean;
}

export interface LocationRequestPlan {
  targets: LocationRequestTarget[];
}

export interface LocationRequestPlanner {
  planLspRequest(input: LocationPlanInput): LocationRequestPlan | undefined;
}

export interface LocationRequestManager {
  sendRequest(target: LocationSessionTarget, method: LocationRequestMethod, params: LocationRequestParams): Promise<unknown> | unknown;
}

export interface LocationSessionTarget {
  serverConfigId: string;
  workspaceRoot: string;
}

export type LocationRequestMethod =
  | 'textDocument/definition'
  | 'textDocument/references'
  | 'textDocument/typeDefinition'
  | 'textDocument/implementation'
  | 'textDocument/declaration';

export interface LocationRequestParams {
  textDocument: {
    uri: string;
  };
  position: LspPosition;
  context?: {
    includeDeclaration: boolean;
  };
}

export interface LocationServiceDependencies {
  requestPlanner: LocationRequestPlanner;
  manager: LocationRequestManager;
}

export interface LocationService {
  definition(input: LocationServiceInput): Promise<LocationServiceResponse>;
  references(input: LocationReferencesInput): Promise<LocationServiceResponse>;
  typeDefinition(input: LocationServiceInput): Promise<LocationServiceResponse>;
  implementation(input: LocationServiceInput): Promise<LocationServiceResponse>;
  declaration(input: LocationServiceInput): Promise<LocationServiceResponse>;
}

export interface LocationServiceResponse {
  results: LocationServiceResult[];
}

export interface LocationServiceResult {
  serverConfigId: string;
  isPrimary: boolean;
  result: unknown;
}

export function createLocationService({ requestPlanner, manager }: LocationServiceDependencies): LocationService {
  return {
    definition(input) {
      return requestLocations({
        input,
        feature: 'definition',
        method: 'textDocument/definition',
        requestPlanner,
        manager
      });
    },
    references(input) {
      return requestLocations({
        input,
        feature: 'references',
        method: 'textDocument/references',
        context: { includeDeclaration: input.includeDeclaration },
        requestPlanner,
        manager
      });
    },
    typeDefinition(input) {
      return requestLocations({
        input,
        feature: 'typeDefinition',
        method: 'textDocument/typeDefinition',
        requestPlanner,
        manager
      });
    },
    implementation(input) {
      return requestLocations({
        input,
        feature: 'implementation',
        method: 'textDocument/implementation',
        requestPlanner,
        manager
      });
    },
    declaration(input) {
      return requestLocations({
        input,
        feature: 'declaration',
        method: 'textDocument/declaration',
        requestPlanner,
        manager
      });
    }
  };
}

interface RequestLocationsOptions {
  input: LocationServiceInput;
  feature: LocationPlanInput['feature'];
  method: LocationRequestMethod;
  context?: LocationRequestParams['context'];
  requestPlanner: LocationRequestPlanner;
  manager: LocationRequestManager;
}

async function requestLocations({
  input,
  feature,
  method,
  context,
  requestPlanner,
  manager
}: RequestLocationsOptions): Promise<LocationServiceResponse> {
  const plan = requestPlanner.planLspRequest({
    settings: input.settings,
    uri: input.uri,
    languageId: input.languageId,
    workspaceRoot: input.workspaceRoot,
    feature
  });

  if (!plan) {
    return { results: [] };
  }

  const params = {
    textDocument: { uri: input.uri },
    position: input.position,
    ...(context ? { context } : {})
  };
  const results: LocationServiceResult[] = [];

  for (const target of plan.targets) {
    const result = await manager.sendRequest(
      { serverConfigId: target.serverConfigId, workspaceRoot: target.workspaceRoot },
      method,
      params
    );

    if (hasLocationResult(result)) {
      results.push({ serverConfigId: target.serverConfigId, isPrimary: target.isPrimary, result });
    }
  }

  return { results };
}

function hasLocationResult(result: unknown): boolean {
  return result != null && (!Array.isArray(result) || result.length > 0);
}
