import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LspFileOperationNotificationInput, LspFileOperationRequestInput, LspFileOperationRequestResult } from './manager.js';
import {
  createLspFileOperationPreviewStore,
  type LspFileOperationApplyResponse,
  type LspFileOperationPreviewResponse,
  type LspFileOperationPreviewStore
} from './lspWorkspaceEdit.js';

export type LspFileOperationKind = 'file' | 'folder';

export interface LspFileOperationCoordinator {
  didCreate(input: { workspaceRoot: string; path: string; kind: LspFileOperationKind }): Promise<number>;
  didRename(input: { workspaceRoot: string; oldPath: string; newPath: string; kind: LspFileOperationKind }): Promise<number>;
  didDelete(input: { workspaceRoot: string; path: string; kind: LspFileOperationKind }): Promise<number>;
  previewRename(input: { workspaceRoot: string; from: string; to: string; kind: LspFileOperationKind; supportsResourceOps?: boolean }): Promise<LspFileOperationPreviewResponse>;
  applyRename(input: { workspaceRoot: string; previewId: string }): Promise<LspFileOperationApplyResponse>;
  previewCreate(input: { workspaceRoot: string; path: string; kind: LspFileOperationKind; supportsResourceOps?: boolean }): Promise<LspFileOperationPreviewResponse>;
  applyCreate(input: { workspaceRoot: string; previewId: string }): Promise<LspFileOperationApplyResponse>;
  previewDelete(input: { workspaceRoot: string; path: string; kind: LspFileOperationKind; supportsResourceOps?: boolean }): Promise<LspFileOperationPreviewResponse>;
  applyDelete(input: { workspaceRoot: string; previewId: string }): Promise<LspFileOperationApplyResponse>;
}

export interface LspFileOperationCoordinatorOptions {
  manager: {
    notifyRunningSessionsForWorkspaceFileOperation(input: LspFileOperationNotificationInput): Promise<number>;
    requestRunningSessionsForWorkspaceFileOperation(input: LspFileOperationRequestInput): Promise<LspFileOperationRequestResult[]>;
    hasRunningSessionForWorkspaceFileOperation?(workspaceRoot: string): boolean | Promise<boolean>;
  };
  responseSecrets?: () => readonly string[];
  fileOperationPreviewStore?: LspFileOperationPreviewStore;
}

interface FileOperationPath {
  path: string;
  kind: LspFileOperationKind;
}

type FileOperationCapability = 'didCreate' | 'didRename' | 'didDelete' | 'willCreate' | 'willRename' | 'willDelete';

type WorkspaceFileOperationRequest =
  | {
      workspaceRoot: string;
      method: 'workspace/willRenameFiles';
      params: { files: Array<{ oldUri: string; newUri: string }> };
      matchesCapabilities: (capabilities: Record<string, unknown>) => boolean;
      timeoutMs: number;
    }
  | {
      workspaceRoot: string;
      method: 'workspace/willCreateFiles' | 'workspace/willDeleteFiles';
      params: { files: Array<{ uri: string }> };
      matchesCapabilities: (capabilities: Record<string, unknown>) => boolean;
      timeoutMs: number;
    };

export function createLspFileOperationCoordinator(options: LspFileOperationCoordinatorOptions): LspFileOperationCoordinator {
  let coordinator: LspFileOperationCoordinator;
  const previewStore =
    options.fileOperationPreviewStore ??
    createLspFileOperationPreviewStore({
      secrets: options.responseSecrets,
      notifyDidRename: (input) => coordinator.didRename(input),
      notifyDidCreate: (input) => coordinator.didCreate(input),
      notifyDidDelete: (input) => coordinator.didDelete(input)
    });
  coordinator = {
    previewRename: async (input) => {
      const workspaceRoot = safeRealpath(input.workspaceRoot);
      const from = workspaceRoot ? existingOrCapturedPath(input.from, workspaceRoot) : undefined;
      const to = workspaceRoot ? existingOrCreatedPath(input.to, workspaceRoot) : undefined;
      if (!workspaceRoot || !from || !to) {
        return { ok: false, statusCode: 409, error: 'lsp file operation preview failed', reason: 'stale-preview' };
      }
      const operation = { type: 'rename' as const, from, to, kind: input.kind };
      const hasRunningSession = await options.manager.hasRunningSessionForWorkspaceFileOperation?.(workspaceRoot);
      if (hasRunningSession === false) {
        return { ok: true, status: 'no-running-session', operation, changes: [] };
      }
      const oldUri = pathToFileURL(from).href;
      const newUri = pathToFileURL(to).href;
      let serverResults: LspFileOperationRequestResult[];
      try {
        serverResults = await requestFileOperation(options.manager, {
          workspaceRoot,
          method: 'workspace/willRenameFiles',
          params: { files: [{ oldUri, newUri }] },
          timeoutMs: 1_000,
          matchesCapabilities: (capabilities) =>
            matchesFileOperationCapabilities(capabilities, 'willRename', workspaceRoot, [
              { path: from, kind: input.kind },
              { path: to, kind: input.kind }
            ])
        });
      } catch {
        return { ok: false, statusCode: 409, error: 'lsp file operation preview failed', reason: 'server-error' };
      }
      if (serverResults.length === 0) {
        return { ok: true, status: 'no-capability', operation, changes: [] };
      }
      return previewStore.createPreview({ workspaceRoot, operation, serverResults, supportsResourceOps: input.supportsResourceOps });
    },
    applyRename: (input) => previewStore.apply(input),
    previewCreate: async (input) => {
      const workspaceRoot = safeRealpath(input.workspaceRoot);
      const path = workspaceRoot ? existingOrCreatedPath(input.path, workspaceRoot) : undefined;
      if (!workspaceRoot || !path) {
        return { ok: false, statusCode: 409, error: 'lsp file operation preview failed', reason: 'stale-preview' };
      }
      const operation = { type: 'create' as const, path, kind: input.kind };
      const hasRunningSession = await options.manager.hasRunningSessionForWorkspaceFileOperation?.(workspaceRoot);
      if (hasRunningSession === false) {
        return { ok: true, status: 'no-running-session', operation, changes: [] };
      }
      let serverResults: LspFileOperationRequestResult[];
      try {
        serverResults = await requestFileOperation(options.manager, {
          workspaceRoot,
          method: 'workspace/willCreateFiles',
          params: { files: [{ uri: pathToFileURL(path).href }] },
          timeoutMs: 1_000,
          matchesCapabilities: (capabilities) =>
            matchesFileOperationCapabilities(capabilities, 'willCreate', workspaceRoot, [{ path, kind: input.kind }])
        });
      } catch {
        return { ok: false, statusCode: 409, error: 'lsp file operation preview failed', reason: 'server-error' };
      }
      if (serverResults.length === 0) {
        return { ok: true, status: 'no-capability', operation, changes: [] };
      }
      return previewStore.createPreview({ workspaceRoot, operation, serverResults, supportsResourceOps: input.supportsResourceOps });
    },
    applyCreate: (input) => previewStore.apply(input),
    previewDelete: async (input) => {
      const workspaceRoot = safeRealpath(input.workspaceRoot);
      const path = workspaceRoot ? existingOrCapturedPath(input.path, workspaceRoot) : undefined;
      if (!workspaceRoot || !path) {
        return { ok: false, statusCode: 409, error: 'lsp file operation preview failed', reason: 'stale-preview' };
      }
      const operation = { type: 'delete' as const, path, kind: input.kind };
      const hasRunningSession = await options.manager.hasRunningSessionForWorkspaceFileOperation?.(workspaceRoot);
      if (hasRunningSession === false) {
        return { ok: true, status: 'no-running-session', operation, changes: [] };
      }
      let serverResults: LspFileOperationRequestResult[];
      try {
        serverResults = await requestFileOperation(options.manager, {
          workspaceRoot,
          method: 'workspace/willDeleteFiles',
          params: { files: [{ uri: pathToFileURL(path).href }] },
          timeoutMs: 1_000,
          matchesCapabilities: (capabilities) =>
            matchesFileOperationCapabilities(capabilities, 'willDelete', workspaceRoot, [{ path, kind: input.kind }])
        });
      } catch {
        return { ok: false, statusCode: 409, error: 'lsp file operation preview failed', reason: 'server-error' };
      }
      if (serverResults.length === 0) {
        return { ok: true, status: 'no-capability', operation, changes: [] };
      }
      return previewStore.createPreview({ workspaceRoot, operation, serverResults, supportsResourceOps: input.supportsResourceOps });
    },
    applyDelete: (input) => previewStore.apply(input),
    didCreate(input) {
      const workspaceRoot = safeRealpath(input.workspaceRoot);
      const path = workspaceRoot ? existingOrCreatedPath(input.path, workspaceRoot) : undefined;
      if (!workspaceRoot || !path) {
        return Promise.resolve(0);
      }
      const uri = pathToFileURL(path).href;
      return options.manager.notifyRunningSessionsForWorkspaceFileOperation({
        workspaceRoot,
        method: 'workspace/didCreateFiles',
        params: { files: [{ uri }] },
        matchesCapabilities: (capabilities) =>
          matchesFileOperationCapabilities(capabilities, 'didCreate', workspaceRoot, [{ path, kind: input.kind }])
      });
    },
    didRename(input) {
      const workspaceRoot = safeRealpath(input.workspaceRoot);
      const oldPath = workspaceRoot ? existingOrCapturedPath(input.oldPath, workspaceRoot) : undefined;
      const newPath = workspaceRoot ? existingOrCreatedPath(input.newPath, workspaceRoot) : undefined;
      if (!workspaceRoot || !oldPath || !newPath) {
        return Promise.resolve(0);
      }
      const oldUri = pathToFileURL(oldPath).href;
      const newUri = pathToFileURL(newPath).href;
      return options.manager.notifyRunningSessionsForWorkspaceFileOperation({
        workspaceRoot,
        method: 'workspace/didRenameFiles',
        params: { files: [{ oldUri, newUri }] },
        matchesCapabilities: (capabilities) =>
          matchesFileOperationCapabilities(capabilities, 'didRename', workspaceRoot, [
            { path: oldPath, kind: input.kind },
            { path: newPath, kind: input.kind }
          ])
      });
    },
    didDelete(input) {
      const workspaceRoot = safeRealpath(input.workspaceRoot);
      const path = workspaceRoot ? existingOrCapturedPath(input.path, workspaceRoot) : undefined;
      if (!workspaceRoot || !path) {
        return Promise.resolve(0);
      }
      const uri = pathToFileURL(path).href;
      return options.manager.notifyRunningSessionsForWorkspaceFileOperation({
        workspaceRoot,
        method: 'workspace/didDeleteFiles',
        params: { files: [{ uri }] },
        matchesCapabilities: (capabilities) =>
          matchesFileOperationCapabilities(capabilities, 'didDelete', workspaceRoot, [{ path, kind: input.kind }])
      });
    }
  };
  return coordinator;
}

function matchesFileOperationCapabilities(
  capabilities: Record<string, unknown>,
  operation: FileOperationCapability,
  workspaceRoot: string,
  paths: FileOperationPath[]
): boolean {
  const workspace = asRecord(capabilities.workspace);
  const fileOperations = asRecord(workspace?.fileOperations);
  const registration = asRecord(fileOperations?.[operation]);
  const filters = registration?.filters;
  if (!Array.isArray(filters)) {
    return false;
  }
  return filters.some((filter) => paths.some((path) => matchesFileOperationFilter(filter, workspaceRoot, path)));
}

function requestFileOperation(
  manager: LspFileOperationCoordinatorOptions['manager'],
  input: WorkspaceFileOperationRequest
): Promise<LspFileOperationRequestResult[]> {
  return (manager.requestRunningSessionsForWorkspaceFileOperation as (request: WorkspaceFileOperationRequest) => Promise<LspFileOperationRequestResult[]>)(
    input
  );
}

function matchesFileOperationFilter(filter: unknown, workspaceRoot: string, file: FileOperationPath): boolean {
  if (!isRecord(filter)) {
    return false;
  }
  if (filter.scheme !== undefined && filter.scheme !== 'file') {
    return false;
  }
  const pattern = asRecord(filter.pattern);
  if (!pattern || typeof pattern.glob !== 'string') {
    return false;
  }
  if (pattern.matches !== undefined && pattern.matches !== 'file' && pattern.matches !== 'folder') {
    return false;
  }
  if (pattern.matches !== undefined && pattern.matches !== file.kind) {
    return false;
  }
  const relativePath = toWorkspaceRelativePath(workspaceRoot, file.path);
  if (!relativePath) {
    return false;
  }
  const options = asRecord(pattern.options);
  const ignoreCase = options?.ignoreCase === true || pattern.ignoreCase === true;
  return matchesGlob(pattern.glob, relativePath, ignoreCase);
}

function matchesGlob(glob: string, relativePath: string, ignoreCase: boolean): boolean {
  const regex = globToRegExp(glob);
  if (!regex) {
    return false;
  }
  const target = glob.includes('/') ? relativePath : basename(relativePath);
  return new RegExp(regex, ignoreCase ? 'i' : '').test(target);
}

function globToRegExp(glob: string): string | undefined {
  if (glob === '' || /[\\[\\]()!]/.test(glob)) {
    return undefined;
  }
  let output = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          output += '(?:.*/)?';
          index += 1;
        } else {
          output += '.*';
        }
      } else {
        output += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      output += '[^/]';
      continue;
    }
    if (char === '{') {
      const close = glob.indexOf('}', index + 1);
      if (close === -1) {
        return undefined;
      }
      const alternatives = glob.slice(index + 1, close).split(',');
      if (alternatives.length === 0 || alternatives.some((entry) => entry === '' || /[{}\\/]/.test(entry))) {
        return undefined;
      }
      output += `(?:${alternatives.map(escapeRegExp).join('|')})`;
      index = close;
      continue;
    }
    if (char === '}') {
      return undefined;
    }
    output += escapeRegExp(char);
  }
  return `${output}$`;
}

function existingOrCreatedPath(path: string, workspaceRoot: string): string | undefined {
  const parent = safeRealpath(dirname(path));
  if (!parent) {
    return undefined;
  }
  const name = basename(path);
  if (name === '' || name === '.' || name === '..') {
    return undefined;
  }
  const candidate = resolve(parent, name);
  return isContained(candidate, workspaceRoot) ? candidate : undefined;
}

function existingOrCapturedPath(path: string, workspaceRoot: string): string | undefined {
  const existing = safeRealpath(path) ?? resolve(path);
  return isContained(existing, workspaceRoot) ? existing : undefined;
}

function toWorkspaceRelativePath(workspaceRoot: string, path: string): string | undefined {
  if (!isContained(path, workspaceRoot)) {
    return undefined;
  }
  const relativePath = relative(workspaceRoot, path).split(sep).join('/');
  return relativePath === '' ? basename(path) : relativePath;
}

function isContained(path: string, workspaceRoot: string): boolean {
  const rel = relative(workspaceRoot, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
