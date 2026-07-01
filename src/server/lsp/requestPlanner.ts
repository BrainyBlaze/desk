import { matchLspLanguages } from './languageMatcher.js';
import type { NormalizedLspLanguage, NormalizedLspServer, NormalizedLspSettings } from './settings.js';

export interface LspRequestPlanInput {
  settings: NormalizedLspSettings;
  uri?: string;
  languageId?: string;
  workspaceRoot: string;
  feature: string;
}

export interface LspRequestPlan {
  language: NormalizedLspLanguage;
  targets: LspRequestTarget[];
}

export interface LspRequestTarget {
  serverConfigId: string;
  workspaceRoot: string;
  server: NormalizedLspServer;
  isPrimary: boolean;
}

const SINGLE_TARGET_FEATURES = new Set(['formatting', 'rename']);

export function planLspRequest(input: LspRequestPlanInput): LspRequestPlan | undefined {
  const matches = matchLspLanguages(input);
  if (matches.length === 0) {
    return undefined;
  }

  const targets = matches.map((server, index) => ({
    serverConfigId: server.serverConfigId,
    workspaceRoot: input.workspaceRoot,
    server,
    isPrimary: index === 0
  }));
  const selectedTargets = SINGLE_TARGET_FEATURES.has(input.feature) ? targets.slice(0, 1) : targets;
  if (selectedTargets.length === 0) {
    return undefined;
  }

  return { language: matches[0], targets: selectedTargets };
}
