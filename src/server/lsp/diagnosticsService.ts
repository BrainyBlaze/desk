import type { LspDiagnostic } from './diagnosticsStore.js';

export interface DiagnosticsServiceInput {
  workspaceRoot: string;
  uri: string;
  languageId?: string;
  settings?: unknown;
  refresh?: boolean;
}

export interface DiagnosticsServiceResponse {
  diagnostics: LspDiagnostic[];
}

export interface DiagnosticsService {
  diagnostics(input: DiagnosticsServiceInput): Promise<DiagnosticsServiceResponse> | DiagnosticsServiceResponse;
}

export interface DiagnosticsServiceManager {
  getDiagnostics(input: { workspaceRoot: string; uri: string }): DiagnosticsServiceResponse;
  pullDiagnosticsForRunningSession?(input: {
    workspaceRoot: string;
    serverConfigId: string;
    uri: string;
    languageId?: string;
  }): Promise<unknown> | unknown;
}

export interface DiagnosticsRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  isPrimary: boolean;
}

export interface DiagnosticsRequestPlanner {
  planLspRequest(input: {
    settings: unknown;
    uri: string;
    languageId?: string;
    workspaceRoot: string;
    feature: 'diagnostic';
  }): { targets: DiagnosticsRequestTarget[] } | undefined;
}

export function createDiagnosticsService({
  manager,
  requestPlanner
}: {
  manager: DiagnosticsServiceManager;
  requestPlanner?: DiagnosticsRequestPlanner;
}): DiagnosticsService {
  return {
    async diagnostics(input) {
      if (input.refresh === true && input.settings !== undefined && requestPlanner && manager.pullDiagnosticsForRunningSession) {
        const plan = requestPlanner.planLspRequest({
          settings: input.settings,
          uri: input.uri,
          languageId: input.languageId,
          workspaceRoot: input.workspaceRoot,
          feature: 'diagnostic'
        });
        for (const target of plan?.targets ?? []) {
          try {
            await manager.pullDiagnosticsForRunningSession({
              workspaceRoot: target.workspaceRoot,
              serverConfigId: target.serverConfigId,
              uri: input.uri,
              languageId: input.languageId
            });
          } catch {
            // Pull diagnostics are best-effort; the existing cache remains authoritative on failure.
          }
        }
      }
      return manager.getDiagnostics({ workspaceRoot: input.workspaceRoot, uri: input.uri });
    }
  };
}
