import type { Server as NodeHttpServer } from 'node:http';
import { readManifestFile, resolveManifestPath } from '../core/config.js';
import type { SessionSpec } from '../core/types.js';
import { rewriteNativeLaunchCommand } from './agentHostLaunch.js';
import { deriveAgentHostToken, getOrCreateAgentHostSecret } from './agentHostToken.js';
import { AgentSurfaceBroker } from './agentSurfaceBroker.js';
import { createLspCapabilityTokenRegistry } from './lsp/capabilityTokenRegistry.js';
import { createCodeActionService } from './lsp/codeActionService.js';
import { createCompletionService } from './lsp/completionService.js';
import { LspDiagnosticsStore } from './lsp/diagnosticsStore.js';
import { createDiagnosticsService } from './lsp/diagnosticsService.js';
import { createDocumentHighlightService } from './lsp/documentHighlightService.js';
import { createDocumentSymbolService } from './lsp/documentSymbolService.js';
import { createEditorSharedSessionFactory } from './lsp/editorSharedSessionFactory.js';
import { createFormattingService } from './lsp/formattingService.js';
import { createFoldingRangeService } from './lsp/foldingRangeService.js';
import { createHoverService } from './lsp/hoverService.js';
import { createLspHttpEndpoint } from './lsp/lspHttpEndpoint.js';
import { createLspFileOperationCoordinator } from './lsp/lspFileOperationCoordinator.js';
import { createLspLanguageDetector } from './lsp/languageDetection.js';
import { createLocationService } from './lsp/locationService.js';
import { LspManager } from './lsp/manager.js';
import { createManagedAgentLspWiring } from './lsp/managedAgentLspWiring.js';
import { createRenameService } from './lsp/renameService.js';
import { createLspRequestApi } from './lsp/requestApi.js';
import { planLspRequest } from './lsp/requestPlanner.js';
import { createSelectionRangeService } from './lsp/selectionRangeService.js';
import { createSemanticTokensService } from './lsp/semanticTokensService.js';
import { normalizeLspSettings, type NormalizedLspSettings } from './lsp/settings.js';
import { createSignatureHelpService } from './lsp/signatureHelpService.js';
import { createLspWarmSessionCoordinator } from './lsp/warmSessionCoordinator.js';
import { createDefaultTerminalBroker } from './terminalBroker.js';

function canonicalLocalApiBaseUrl(httpServer: NodeHttpServer | null): string | undefined {
  const address = httpServer?.address();
  if (!address || typeof address === 'string') {
    return undefined;
  }
  return `http://127.0.0.1:${address.port}`;
}

export function createDeskServices(httpServer: NodeHttpServer | null) {
  const terminalBroker = createDefaultTerminalBroker();
  const agentSurfaceBroker = new AgentSurfaceBroker();
  const lspDiagnosticsStore = new LspDiagnosticsStore();
  const lspManager = new LspManager(undefined, { diagnosticsStore: lspDiagnosticsStore });
  const lspRequestPlanner = {
    planLspRequest(input: {
      settings: unknown;
      uri?: string;
      languageId?: string;
      workspaceRoot: string;
      feature: string;
    }) {
      return planLspRequest({ ...input, settings: input.settings as NormalizedLspSettings });
    }
  };
  const lspRequestApi = createLspRequestApi({
    getSettings: () => normalizeLspSettings(readManifestFile(resolveManifestPath()).settings?.lsp),
    hoverService: createHoverService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    formattingService: createFormattingService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    foldingRangeService: createFoldingRangeService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    documentSymbolService: createDocumentSymbolService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    completionService: createCompletionService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    signatureHelpService: createSignatureHelpService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    renameService: createRenameService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    documentHighlightService: createDocumentHighlightService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    locationService: createLocationService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    diagnosticsService: createDiagnosticsService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    codeActionService: createCodeActionService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    selectionRangeService: createSelectionRangeService({ requestPlanner: lspRequestPlanner, manager: lspManager }),
    semanticTokensService: createSemanticTokensService({ requestPlanner: lspRequestPlanner, manager: lspManager })
  });
  const rawLspCapabilityTokens = createLspCapabilityTokenRegistry();
  const activeLspCapabilityTokens = new Set<string>();
  const lspCapabilityTokens: ReturnType<typeof createLspCapabilityTokenRegistry> = {
    mint(workspaceRoot) {
      const minted = rawLspCapabilityTokens.mint(workspaceRoot);
      activeLspCapabilityTokens.add(minted.token);
      return minted;
    },
    resolve(token) {
      return rawLspCapabilityTokens.resolve(token);
    },
    revoke(token) {
      activeLspCapabilityTokens.delete(token);
      rawLspCapabilityTokens.revoke(token);
    },
    dispose() {
      activeLspCapabilityTokens.clear();
      rawLspCapabilityTokens.dispose();
    }
  };
  const lspHttpEndpoint = createLspHttpEndpoint({ tokenRegistry: lspCapabilityTokens, requestApi: lspRequestApi });
  const lspLanguageDetector = createLspLanguageDetector({
    readManifest: () => readManifestFile(resolveManifestPath())
  });
  const lspWarmSessions = createLspWarmSessionCoordinator({
    manager: lspManager,
    languageDetector: lspLanguageDetector,
    readManifest: () => readManifestFile(resolveManifestPath())
  });
  const lspFileOperationCoordinator = createLspFileOperationCoordinator({
    manager: lspManager,
    responseSecrets: () => [...activeLspCapabilityTokens]
  });
  const managedAgentLsp = createManagedAgentLspWiring({
    tokenRegistry: lspCapabilityTokens,
    getApiBaseUrl: () => canonicalLocalApiBaseUrl(httpServer)
  });
  const createEditorSession = createEditorSharedSessionFactory({
    manager: lspManager,
    warmSessions: lspWarmSessions,
    readManifest: () => readManifestFile(resolveManifestPath())
  });
  const nativeAgentLaunch = (spec: SessionSpec, lspEnvFilePath?: string): SessionSpec => {
    if (spec.uiMode !== 'native') {
      return spec;
    }
    const serverUrl = canonicalLocalApiBaseUrl(httpServer);
    if (!serverUrl) {
      return spec;
    }
    const secret = getOrCreateAgentHostSecret();
    return rewriteNativeLaunchCommand(spec, {
      serverUrl,
      ...(lspEnvFilePath ? { lspEnvFilePath } : {}),
      token: deriveAgentHostToken(secret, spec.tmuxSession, spec.agent ?? '')
    });
  };

  return {
    terminalBroker,
    agentSurfaceBroker,
    lspManager,
    lspCapabilityTokens,
    lspHttpEndpoint,
    lspLanguageDetector,
    lspWarmSessions,
    lspFileOperationCoordinator,
    managedAgentLsp,
    createEditorSession,
    nativeAgentLaunch
  };
}

export type DeskServices = ReturnType<typeof createDeskServices>;
