export interface SignatureHelpServiceInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  position: LspPosition;
  context?: SignatureHelpContext;
}

export interface SignatureHelpContext {
  triggerKind: number;
  triggerCharacter?: string;
  isRetrigger?: boolean;
  activeSignatureHelp?: unknown;
}

export interface SignatureHelpPlanInput {
  settings: unknown;
  uri: string;
  languageId?: string;
  workspaceRoot: string;
  feature: 'signatureHelp';
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface SignatureHelpRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  isPrimary: boolean;
}

export interface SignatureHelpRequestPlan {
  targets: SignatureHelpRequestTarget[];
}

export interface SignatureHelpRequestPlanner {
  planLspRequest(input: SignatureHelpPlanInput): SignatureHelpRequestPlan | undefined;
}

export interface SignatureHelpRequestManager {
  sendRequest(
    target: SignatureHelpSessionTarget,
    method: 'textDocument/signatureHelp',
    params: SignatureHelpRequestParams
  ): Promise<unknown> | unknown;
}

export interface SignatureHelpSessionTarget {
  serverConfigId: string;
  workspaceRoot: string;
}

export interface SignatureHelpRequestParams {
  textDocument: {
    uri: string;
  };
  position: LspPosition;
  context?: SignatureHelpContext;
}

export interface SignatureHelpServiceDependencies {
  requestPlanner: SignatureHelpRequestPlanner;
  manager: SignatureHelpRequestManager;
}

export interface SignatureHelpService {
  signatureHelp(input: SignatureHelpServiceInput): Promise<SignatureHelpServiceResponse>;
}

export type SignatureHelpServiceResponse = SignatureHelpServiceResult | SignatureHelpServiceEmptyResult;

export interface SignatureHelpServiceResult {
  serverConfigId: string;
  isPrimary: boolean;
  result: unknown;
}

export interface SignatureHelpServiceEmptyResult {
  result: null;
}

export function createSignatureHelpService({
  requestPlanner,
  manager
}: SignatureHelpServiceDependencies): SignatureHelpService {
  return {
    async signatureHelp(input) {
      const plan = requestPlanner.planLspRequest({
        settings: input.settings,
        uri: input.uri,
        languageId: input.languageId,
        workspaceRoot: input.workspaceRoot,
        feature: 'signatureHelp'
      });
      const target = selectSignatureHelpTarget(plan?.targets ?? []);
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
        'textDocument/signatureHelp',
        params
      );

      if (result == null) {
        return { result: null };
      }

      return { serverConfigId: target.serverConfigId, isPrimary: target.isPrimary, result };
    }
  };
}

function selectSignatureHelpTarget(targets: SignatureHelpRequestTarget[]): SignatureHelpRequestTarget | undefined {
  return targets.find((target) => target.isPrimary) ?? targets[0];
}
