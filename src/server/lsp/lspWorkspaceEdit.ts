import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspRenamePreviewChange {
  uri: string;
  path: string;
  edits: LspTextEdit[];
}

export type LspFileOperationKind = 'file' | 'folder';

export type LspFileOperationDescriptor =
  | { type: 'rename'; from: string; to: string; kind: LspFileOperationKind }
  | { type: 'create'; path: string; kind: LspFileOperationKind }
  | { type: 'delete'; path: string; kind: LspFileOperationKind };

export type LspFileResourceOperation =
  | { type: 'create'; path: string; kind: 'file' }
  | { type: 'rename'; from: string; to: string; kind: 'file' }
  | { type: 'delete'; path: string; kind: 'file' };

type StaticReason =
  | 'server-error'
  | 'timeout'
  | 'unsupported-workspace-edit'
  | 'out-of-root-edit'
  | 'conflicting-edits'
  | 'stale-preview'
  | 'path-collision'
  | 'invalid-operation'
  | 'non-regular-entry'
  | 'symlink-escape'
  | 'move-into-own-descendant'
  | 'rollback-failed'
  | 'resource-ops-not-supported';

export type LspFileOperationPreviewResponse =
  | {
      ok: true;
      status: 'ready';
      previewId: string;
      operation: LspFileOperationDescriptor;
      changes: LspRenamePreviewChange[];
      resourceOps?: LspFileResourceOperation[];
    }
  | {
      ok: true;
      status: 'no-running-session' | 'no-capability' | 'no-edits';
      operation: LspFileOperationDescriptor;
      changes: [];
    }
  | {
      ok: false;
      statusCode: 409;
      error: 'lsp file operation preview failed';
      reason: StaticReason;
    };

export type LspRenamePreviewResponse = LspFileOperationPreviewResponse;

export type LspFileOperationApplyResponse =
  | { ok: true; operation: LspFileOperationDescriptor; path: string; changedFiles: string[]; resourceOps?: LspFileResourceOperation[] }
  | {
      ok: false;
      statusCode: 409;
      error: 'lsp file operation apply failed' | 'preview expired' | 'lsp file operation rollback failed';
      reason: StaticReason | 'preview-expired';
      rollbackFailed?: boolean;
      affectedPaths?: string[];
    };

export type LspRenameApplyResponse = LspFileOperationApplyResponse;

export interface LspFileOperationPreviewStore {
  createPreview(input: {
    workspaceRoot: string;
    operation: LspFileOperationDescriptor;
    serverResults: Array<{ sessionId: string; result: unknown }>;
    supportsResourceOps?: boolean;
  }): Promise<LspFileOperationPreviewResponse>;
  apply(input: { workspaceRoot: string; previewId: string }): Promise<LspFileOperationApplyResponse>;
}

export interface LspRenamePreviewStore {
  createPreview(input: {
    workspaceRoot: string;
    from: string;
    to: string;
    serverResults: Array<{ sessionId: string; result: unknown }>;
  }): Promise<LspRenamePreviewResponse>;
  apply(input: { workspaceRoot: string; previewId: string }): Promise<LspRenameApplyResponse>;
}

export interface LspFileOperationPreviewStoreOptions {
  ttlMs?: number;
  secrets?: readonly string[] | (() => readonly string[]);
  now?: () => number;
  createPreviewId?: () => string;
  notifyDidRename?: (input: { workspaceRoot: string; oldPath: string; newPath: string; kind: LspFileOperationKind }) => Promise<number>;
  notifyDidCreate?: (input: { workspaceRoot: string; path: string; kind: LspFileOperationKind }) => Promise<number>;
  notifyDidDelete?: (input: { workspaceRoot: string; path: string; kind: LspFileOperationKind }) => Promise<number>;
}

export interface LspRenamePreviewStoreOptions {
  ttlMs?: number;
  secrets?: readonly string[] | (() => readonly string[]);
  now?: () => number;
  createPreviewId?: () => string;
  notifyDidRename?: (input: { workspaceRoot: string; oldPath: string; newPath: string; kind: 'file' }) => Promise<number>;
}

interface PendingFileOperationPreview {
  previewId: string;
  rootRealpath: string;
  operation: LspFileOperationDescriptor;
  changes: StoredChange[];
  steps: TransactionStep[];
  resourceOps: LspFileResourceOperation[];
  operationFingerprint: OperationFingerprint;
  fileFingerprints: Map<string, FileFingerprint>;
  resourceFingerprints: ResourceOperationFingerprint[];
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

type OperationFingerprint =
  | {
      type: 'rename';
      source: EntryFingerprint;
      targetParent: DirectoryFingerprint;
      targetExists: boolean;
    }
  | {
      type: 'create';
      targetParent: DirectoryFingerprint;
      targetExists: boolean;
    }
  | {
      type: 'delete';
      source: EntryFingerprint;
    };

interface StoredChange {
  uri: string;
  path: string;
  readPath?: string;
  initialText?: string;
  edits: LspTextEdit[];
}

type TransactionStep =
  | { type: 'text'; change: StoredChange }
  | { type: 'resource-create'; path: string }
  | { type: 'resource-rename'; from: string; to: string }
  | { type: 'resource-delete'; path: string };

type ResourceOperationFingerprint =
  | { type: 'create'; path: string; parent: DirectoryFingerprint; targetExists: boolean }
  | { type: 'rename'; from: string; to: string; source: FileFingerprint; targetParent: DirectoryFingerprint; targetExists: boolean }
  | { type: 'delete'; path: string; source: FileFingerprint };

interface FileFingerprint {
  path: string;
  realpath: string;
  mtimeMs: number;
  size: number;
  sha256: string;
}

interface DirectoryFingerprint {
  realpath: string;
  mtimeMs: number;
  size: number;
}

interface EntryFingerprint {
  kind: LspFileOperationKind;
  realpath: string;
  manifest: SubtreeEntryFingerprint[];
}

interface SubtreeEntryFingerprint {
  relativePath: string;
  kind: LspFileOperationKind;
  realpath: string;
  mtimeMs: number;
  size: number;
  sha256?: string;
}

interface NormalizedEdit extends LspTextEdit {
  startOffset: number;
  endOffset: number;
}

type ParsedWorkspaceEdits =
  | {
      kind: 'ok';
      changes: StoredChange[];
      steps: TransactionStep[];
      resourceOps: LspFileResourceOperation[];
      fileFingerprints: Map<string, FileFingerprint>;
      resourceFingerprints: ResourceOperationFingerprint[];
    }
  | { kind: 'empty' }
  | { kind: 'error'; reason: StaticReason };

const DEFAULT_TTL_MS = 120_000;

export function createLspRenamePreviewStore(options: LspRenamePreviewStoreOptions = {}): LspRenamePreviewStore {
  const store = createLspFileOperationPreviewStore({
    ...options,
    notifyDidRename: options.notifyDidRename
      ? (input) =>
          input.kind === 'file'
            ? options.notifyDidRename!({ workspaceRoot: input.workspaceRoot, oldPath: input.oldPath, newPath: input.newPath, kind: 'file' })
            : Promise.resolve(0)
      : undefined
  });
  return {
    createPreview: (input) =>
      store.createPreview({
        workspaceRoot: input.workspaceRoot,
        operation: { type: 'rename', from: input.from, to: input.to, kind: 'file' },
        serverResults: input.serverResults
      }),
    apply: (input) => store.apply(input)
  };
}

export function createLspFileOperationPreviewStore(options: LspFileOperationPreviewStoreOptions = {}): LspFileOperationPreviewStore {
  const previews = new Map<string, PendingFileOperationPreview>();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const createPreviewId = options.createPreviewId ?? (() => randomBytes(18).toString('base64url'));
  const notifyDidRename = options.notifyDidRename ?? (async () => 0);
  const notifyDidCreate = options.notifyDidCreate ?? (async () => 0);
  const notifyDidDelete = options.notifyDidDelete ?? (async () => 0);
  const readSecrets = () => (typeof options.secrets === 'function' ? options.secrets() : options.secrets ?? []);

  return {
    async createPreview(input) {
      const prepared = prepareOperation(input.workspaceRoot, input.operation);
      if (prepared.kind === 'error') {
        return previewFailure(prepared.reason);
      }
      const parsed = parseWorkspaceEdits({
        serverResults: input.serverResults,
        rootRealpath: prepared.rootRealpath,
        operation: prepared.operation,
        supportsResourceOps: input.supportsResourceOps === true
      });
      if (parsed.kind === 'empty') {
        return sanitizeResponse({ ok: true, status: 'no-edits', operation: prepared.operation, changes: [] }, readSecrets());
      }
      if (parsed.kind === 'error') {
        return previewFailure(parsed.reason);
      }

      const createdAt = now();
      const previewId = createPreviewId();
      const preview: PendingFileOperationPreview = {
        previewId,
        rootRealpath: prepared.rootRealpath,
        operation: prepared.operation,
        changes: parsed.changes,
        steps: parsed.steps,
        resourceOps: parsed.resourceOps,
        operationFingerprint: prepared.fingerprint,
        fileFingerprints: parsed.fileFingerprints,
        resourceFingerprints: parsed.resourceFingerprints,
        createdAt,
        expiresAt: createdAt + ttlMs,
        used: false
      };
      previews.set(previewId, preview);

      return sanitizeResponse(
        {
          ok: true,
          status: 'ready',
          previewId,
          operation: preview.operation,
          changes: preview.changes.map((change) => ({
            uri: change.uri,
            path: change.path,
            edits: change.edits
          })),
          ...resourceOpsResponse(preview.resourceOps)
        },
        readSecrets()
      );
    },
    async apply(input) {
      const preview = previews.get(input.previewId);
      if (!preview || preview.used || now() > preview.expiresAt) {
        return previewExpired();
      }
      let rootRealpath: string;
      try {
        rootRealpath = realpathSync(input.workspaceRoot);
      } catch {
        return previewExpired();
      }
      if (rootRealpath !== preview.rootRealpath) {
        return previewExpired();
      }
      preview.used = true;
      previews.delete(preview.previewId);
      if (!isPreviewFresh(preview)) {
        return applyFailure('stale-preview');
      }

      const touchedFiles = changedFilesForPreview(preview);
      const snapshots = new Map<string, Buffer>();
      const createdPaths = new Set<string>();
      const resourceRenames: Array<{ from: string; to: string }> = [];
      const resourceTombstones: Array<{ path: string; tombstonePath: string }> = [];
      let tombstonePath: string | undefined;
      let mutationDone = false;
      try {
        if (preview.operation.type === 'rename') {
          mkdirSync(dirname(preview.operation.to), { recursive: true });
          renameSync(preview.operation.from, preview.operation.to);
          mutationDone = true;
        } else if (preview.operation.type === 'create') {
          if (preview.operation.kind === 'folder') {
            mkdirSync(preview.operation.path);
          } else {
            writeFileSync(preview.operation.path, '');
          }
          createdPaths.add(preview.operation.path);
          mutationDone = true;
        } else {
          tombstonePath = createTombstonePath(preview.operation.path);
          renameSync(preview.operation.path, tombstonePath);
          mutationDone = true;
        }

        for (const step of preview.steps) {
          if (step.type === 'resource-create') {
            writeFileSync(step.path, '');
            createdPaths.add(step.path);
            continue;
          }
          if (step.type === 'resource-rename') {
            renameSync(step.from, step.to);
            resourceRenames.push({ from: step.from, to: step.to });
            continue;
          }
          if (step.type === 'resource-delete') {
            const resourceTombstonePath = createTombstonePath(step.path);
            renameSync(step.path, resourceTombstonePath);
            resourceTombstones.push({ path: step.path, tombstonePath: resourceTombstonePath });
            continue;
          }
          const change = step.change;
          if (!createdPaths.has(change.path) && !snapshots.has(change.path)) {
            snapshots.set(change.path, readFileSync(change.path));
          }
          const text = change.initialText ?? readFileSync(change.path, 'utf8');
          writeFileSync(change.path, applyTextEdits(text, change.edits), 'utf8');
        }

        for (const resourceTombstone of resourceTombstones.splice(0)) {
          rmSync(resourceTombstone.tombstonePath, { recursive: true, force: true });
        }
        if (tombstonePath) {
          rmSync(tombstonePath, { recursive: true, force: true });
          tombstonePath = undefined;
        }
        try {
          await notifyDidOperation(preview, { notifyDidRename, notifyDidCreate, notifyDidDelete });
        } catch {
          // File-operation notifications are best-effort after the successful mutation.
        }
        return sanitizeResponse(
          { ok: true, operation: preview.operation, path: operationPath(preview.operation), changedFiles: touchedFiles, ...resourceOpsResponse(preview.resourceOps) },
          readSecrets()
        );
      } catch {
        const rollbackOk = rollback(preview, { snapshots, createdPaths, resourceRenames, resourceTombstones, tombstonePath, mutationDone });
        if (!rollbackOk) {
          return sanitizeResponse(
            {
              ok: false,
              statusCode: 409,
              error: 'lsp file operation rollback failed',
              reason: 'rollback-failed',
              rollbackFailed: true,
              affectedPaths: affectedUserPaths(preview, touchedFiles)
            },
            readSecrets()
          );
        }
        return sanitizeResponse(applyFailure('invalid-operation'), readSecrets());
      }
    }
  };
}

function prepareOperation(
  workspaceRoot: string,
  operation: LspFileOperationDescriptor
): { kind: 'ok'; rootRealpath: string; operation: LspFileOperationDescriptor; fingerprint: OperationFingerprint } | { kind: 'error'; reason: StaticReason } {
  let rootRealpath: string;
  try {
    rootRealpath = realpathSync(workspaceRoot);
  } catch {
    return { kind: 'error', reason: 'stale-preview' };
  }
  if (operation.type === 'rename') {
    const source = capturedExistingPath(operation.from, rootRealpath);
    const target = createdPath(operation.to, rootRealpath);
    if (!source || !target) {
      return { kind: 'error', reason: 'stale-preview' };
    }
    if (source.kind !== operation.kind) {
      return { kind: 'error', reason: 'stale-preview' };
    }
    if (operation.kind === 'folder' && isContained(target.path, source.path)) {
      return { kind: 'error', reason: 'move-into-own-descendant' };
    }
    if (existsSync(target.path)) {
      return { kind: 'error', reason: 'path-collision' };
    }
    return {
      kind: 'ok',
      rootRealpath,
      operation: { type: 'rename', from: source.path, to: target.path, kind: operation.kind },
      fingerprint: {
        type: 'rename',
        source: source.fingerprint,
        targetParent: target.parentFingerprint,
        targetExists: existsSync(target.path)
      }
    };
  }
  if (operation.type === 'create') {
    const target = createdPath(operation.path, rootRealpath);
    if (!target) {
      return { kind: 'error', reason: 'stale-preview' };
    }
    if (existsSync(target.path)) {
      return { kind: 'error', reason: 'path-collision' };
    }
    return {
      kind: 'ok',
      rootRealpath,
      operation: { type: 'create', path: target.path, kind: operation.kind },
      fingerprint: { type: 'create', targetParent: target.parentFingerprint, targetExists: existsSync(target.path) }
    };
  }
  const source = capturedExistingPath(operation.path, rootRealpath);
  if (!source || source.kind !== operation.kind || source.path === rootRealpath) {
    return { kind: 'error', reason: 'stale-preview' };
  }
  return {
    kind: 'ok',
    rootRealpath,
    operation: { type: 'delete', path: source.path, kind: operation.kind },
    fingerprint: { type: 'delete', source: source.fingerprint }
  };
}

function parseWorkspaceEdits(input: {
  serverResults: Array<{ sessionId: string; result: unknown }>;
  rootRealpath: string;
  operation: LspFileOperationDescriptor;
  supportsResourceOps: boolean;
}): ParsedWorkspaceEdits {
  const byPath = new Map<string, StoredChange>();
  const steps: TransactionStep[] = [];
  const resourceOps: LspFileResourceOperation[] = [];
  const resourceFingerprints: ResourceOperationFingerprint[] = [];
  const fileFingerprints = new Map<string, FileFingerprint>();
  let hasTopLevelChanges = false;
  for (const serverResult of input.serverResults) {
    const result = serverResult.result;
    if (result === null || result === undefined) {
      continue;
    }
    if (!isRecord(result)) {
      return { kind: 'error', reason: 'unsupported-workspace-edit' };
    }
    const allowedKeys = new Set(['changes', 'documentChanges']);
    if (Object.keys(result).some((key) => !allowedKeys.has(key))) {
      return { kind: 'error', reason: 'unsupported-workspace-edit' };
    }
    if (result.changes !== undefined) {
      hasTopLevelChanges = true;
      if (!isRecord(result.changes)) {
        return { kind: 'error', reason: 'unsupported-workspace-edit' };
      }
      for (const [uri, edits] of Object.entries(result.changes)) {
        if (!Array.isArray(edits)) {
          return { kind: 'error', reason: 'unsupported-workspace-edit' };
        }
        const added = addEdits({ ...input, uri, edits, byPath, fileFingerprints });
        if (added) {
          return added;
        }
      }
    }
    if (result.documentChanges !== undefined) {
      if (!Array.isArray(result.documentChanges)) {
        return { kind: 'error', reason: 'unsupported-workspace-edit' };
      }
      for (const change of result.documentChanges) {
        if (!isRecord(change)) {
          return { kind: 'error', reason: 'unsupported-workspace-edit' };
        }
        if ('kind' in change) {
          if (!input.supportsResourceOps) {
            return { kind: 'error', reason: 'resource-ops-not-supported' };
          }
          if (hasTopLevelChanges) {
            return { kind: 'error', reason: 'unsupported-workspace-edit' };
          }
          const parsed = parseResourceOperation({
            rootRealpath: input.rootRealpath,
            operation: input.operation,
            change,
            steps,
            resourceOps,
            resourceFingerprints
          });
          if (parsed) {
            return parsed;
          }
          continue;
        }
        const added = addTextDocumentEdit({
          ...input,
          change,
          byPath,
          steps,
          fileFingerprints,
          ordered: resourceOps.length > 0
        });
        if (added) {
          return added;
        }
      }
    }
  }
  if (resourceOps.length > 0 && hasTopLevelChanges) {
    return { kind: 'error', reason: 'unsupported-workspace-edit' };
  }
  if (byPath.size === 0 && resourceOps.length === 0) {
    return { kind: 'empty' };
  }
  for (const change of byPath.values()) {
    const text = change.initialText ?? readFileSync(change.readPath ?? change.path, 'utf8');
    try {
      normalizeTextEdits(text, change.edits);
    } catch (error) {
      return { kind: 'error', reason: error instanceof ConflictingEditError ? 'conflicting-edits' : 'unsupported-workspace-edit' };
    }
  }
  const changes = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { kind: 'ok', changes, steps: steps.length > 0 ? steps : changes.map((change) => ({ type: 'text' as const, change })), resourceOps, fileFingerprints, resourceFingerprints };
}

function addEdits(input: {
  rootRealpath: string;
  operation: LspFileOperationDescriptor;
  uri: string;
  edits: unknown[];
  byPath: Map<string, StoredChange>;
  fileFingerprints: Map<string, FileFingerprint>;
}): { kind: 'error'; reason: 'unsupported-workspace-edit' | 'out-of-root-edit' } | undefined {
  const editTarget = resolveEditTarget(input);
  if (!editTarget) {
    return { kind: 'error', reason: 'out-of-root-edit' };
  }
  const parsedEdits = parseTextEdits(input.edits);
  if (!parsedEdits) {
    return { kind: 'error', reason: 'unsupported-workspace-edit' };
  }
  if (parsedEdits.length === 0) {
    return undefined;
  }
  if (editTarget.readPath) {
    input.fileFingerprints.set(editTarget.readPath, fingerprintFile(editTarget.readPath));
  }
  const existing = input.byPath.get(editTarget.path);
  if (existing) {
    existing.edits.push(...parsedEdits);
    return undefined;
  }
  input.byPath.set(editTarget.path, {
    uri: editTarget.uri,
    path: editTarget.path,
    readPath: editTarget.readPath,
    initialText: editTarget.initialText,
    edits: parsedEdits
  });
  return undefined;
}

function addTextDocumentEdit(input: {
  rootRealpath: string;
  operation: LspFileOperationDescriptor;
  change: Record<string, unknown>;
  byPath: Map<string, StoredChange>;
  steps: TransactionStep[];
  fileFingerprints: Map<string, FileFingerprint>;
  ordered: boolean;
}): { kind: 'error'; reason: StaticReason } | undefined {
  const change = input.change;
  if (!isRecord(change.textDocument) || typeof change.textDocument.uri !== 'string') {
    return { kind: 'error', reason: 'unsupported-workspace-edit' };
  }
  if (Object.keys(change).some((key) => key !== 'textDocument' && key !== 'edits')) {
    return { kind: 'error', reason: 'unsupported-workspace-edit' };
  }
  if (Object.keys(change.textDocument).some((key) => key !== 'uri' && key !== 'version')) {
    return { kind: 'error', reason: 'unsupported-workspace-edit' };
  }
  if (change.textDocument.version !== undefined && change.textDocument.version !== null) {
    return { kind: 'error', reason: 'unsupported-workspace-edit' };
  }
  if (!Array.isArray(change.edits)) {
    return { kind: 'error', reason: 'unsupported-workspace-edit' };
  }
  const editTarget =
    resolveEditTarget({ rootRealpath: input.rootRealpath, operation: input.operation, uri: change.textDocument.uri }) ??
    resolvePlannedTextTarget(input.rootRealpath, change.textDocument.uri, input.steps);
  if (!editTarget) {
    return { kind: 'error', reason: 'out-of-root-edit' };
  }
  if (input.ordered && input.byPath.has(editTarget.path)) {
    return { kind: 'error', reason: 'conflicting-edits' };
  }
  const parsedEdits = parseTextEdits(change.edits);
  if (!parsedEdits) {
    return { kind: 'error', reason: 'unsupported-workspace-edit' };
  }
  if (parsedEdits.length === 0) {
    return undefined;
  }
  if (editTarget.readPath) {
    input.fileFingerprints.set(editTarget.readPath, fingerprintFile(editTarget.readPath));
  }
  const existing = input.byPath.get(editTarget.path);
  if (existing) {
    existing.edits.push(...parsedEdits);
    return undefined;
  }
  const stored: StoredChange = {
    uri: editTarget.uri,
    path: editTarget.path,
    readPath: editTarget.readPath,
    initialText: editTarget.initialText,
    edits: parsedEdits
  };
  input.byPath.set(editTarget.path, stored);
  input.steps.push({ type: 'text', change: stored });
  return undefined;
}

function parseResourceOperation(input: {
  rootRealpath: string;
  operation: LspFileOperationDescriptor;
  change: Record<string, unknown>;
  steps: TransactionStep[];
  resourceOps: LspFileResourceOperation[];
  resourceFingerprints: ResourceOperationFingerprint[];
}): { kind: 'error'; reason: StaticReason } | undefined {
  if (input.resourceOps.length >= 50 || input.steps.length >= 200) {
    return { kind: 'error', reason: 'unsupported-workspace-edit' };
  }
  if (input.change.kind === 'create') {
    if (Object.keys(input.change).some((key) => key !== 'kind' && key !== 'uri' && key !== 'options') || typeof input.change.uri !== 'string') {
      return { kind: 'error', reason: 'unsupported-workspace-edit' };
    }
    const optionsError = validateResourceOptions(input.change.options);
    if (optionsError) {
      return { kind: 'error', reason: optionsError };
    }
    const uriPath = pathFromFileUri(input.change.uri);
    const target = uriPath ? createdPath(uriPath, input.rootRealpath) : undefined;
    if (!target) {
      return { kind: 'error', reason: 'out-of-root-edit' };
    }
    if (existsSync(target.path)) {
      return { kind: 'error', reason: 'path-collision' };
    }
    if (conflictsWithUserOperation(input.operation, target.path) || conflictsWithPlan([target.path], input.steps)) {
      return { kind: 'error', reason: 'conflicting-edits' };
    }
    input.resourceOps.push({ type: 'create', path: target.path, kind: 'file' });
    input.steps.push({ type: 'resource-create', path: target.path });
    input.resourceFingerprints.push({ type: 'create', path: target.path, parent: target.parentFingerprint, targetExists: false });
    return undefined;
  }
  if (input.change.kind === 'rename') {
    if (
      Object.keys(input.change).some((key) => key !== 'kind' && key !== 'oldUri' && key !== 'newUri' && key !== 'options') ||
      typeof input.change.oldUri !== 'string' ||
      typeof input.change.newUri !== 'string'
    ) {
      return { kind: 'error', reason: 'unsupported-workspace-edit' };
    }
    const optionsError = validateResourceOptions(input.change.options);
    if (optionsError) {
      return { kind: 'error', reason: optionsError };
    }
    const fromPath = pathFromFileUri(input.change.oldUri);
    const toPath = pathFromFileUri(input.change.newUri);
    const source = fromPath ? existingResourceFile(fromPath, input.rootRealpath) : undefined;
    const target = toPath ? createdPath(toPath, input.rootRealpath) : undefined;
    if (!source || !target) {
      return { kind: 'error', reason: 'out-of-root-edit' };
    }
    if (existsSync(target.path)) {
      return { kind: 'error', reason: 'path-collision' };
    }
    if (conflictsWithUserOperation(input.operation, source.path) || conflictsWithUserOperation(input.operation, target.path) || conflictsWithPlan([source.path, target.path], input.steps)) {
      return { kind: 'error', reason: 'conflicting-edits' };
    }
    input.resourceOps.push({ type: 'rename', from: source.path, to: target.path, kind: 'file' });
    input.steps.push({ type: 'resource-rename', from: source.path, to: target.path });
    input.resourceFingerprints.push({
      type: 'rename',
      from: source.path,
      to: target.path,
      source: source.fingerprint,
      targetParent: target.parentFingerprint,
      targetExists: false
    });
    return undefined;
  }
  if (input.change.kind === 'delete') {
    if (Object.keys(input.change).some((key) => key !== 'kind' && key !== 'uri' && key !== 'options') || typeof input.change.uri !== 'string') {
      return { kind: 'error', reason: 'unsupported-workspace-edit' };
    }
    const optionsError = validateResourceOptions(input.change.options);
    if (optionsError) {
      return { kind: 'error', reason: optionsError };
    }
    const uriPath = pathFromFileUri(input.change.uri);
    const source = uriPath ? existingResourceFile(uriPath, input.rootRealpath) : undefined;
    if (!source) {
      return { kind: 'error', reason: 'out-of-root-edit' };
    }
    if (conflictsWithUserOperation(input.operation, source.path) || conflictsWithPlan([source.path], input.steps)) {
      return { kind: 'error', reason: 'conflicting-edits' };
    }
    input.resourceOps.push({ type: 'delete', path: source.path, kind: 'file' });
    input.steps.push({ type: 'resource-delete', path: source.path });
    input.resourceFingerprints.push({ type: 'delete', path: source.path, source: source.fingerprint });
    return undefined;
  }
  return { kind: 'error', reason: 'unsupported-workspace-edit' };
}

function resolveEditTarget(input: {
  rootRealpath: string;
  operation: LspFileOperationDescriptor;
  uri: string;
}): { uri: string; path: string; readPath?: string; initialText?: string } | undefined {
  let uriPath: string;
  try {
    uriPath = resolve(fileURLToPath(input.uri));
  } catch {
    return undefined;
  }
  if (input.operation.type === 'rename') {
    return resolveRenameEditTarget(input.rootRealpath, input.operation, input.uri, uriPath);
  }
  if (input.operation.type === 'create') {
    return resolveCreateEditTarget(input.rootRealpath, input.operation, input.uri, uriPath);
  }
  return resolveDeleteEditTarget(input.rootRealpath, input.operation, input.uri, uriPath);
}

function resolvePlannedTextTarget(
  rootRealpath: string,
  uri: string,
  steps: TransactionStep[]
): { uri: string; path: string; readPath?: string; initialText?: string } | undefined {
  const uriPath = pathFromFileUri(uri);
  if (!uriPath || !isContained(uriPath, rootRealpath)) {
    return undefined;
  }
  for (const step of [...steps].reverse()) {
    if (step.type === 'resource-delete' && samePath(step.path, uriPath)) {
      return undefined;
    }
    if (step.type === 'resource-create' && samePath(step.path, uriPath)) {
      return { uri: pathToFileURL(step.path).href, path: step.path, initialText: '' };
    }
    if (step.type === 'resource-rename') {
      if (samePath(step.from, uriPath)) {
        return undefined;
      }
      if (samePath(step.to, uriPath)) {
        return { uri: pathToFileURL(step.to).href, path: step.to, readPath: step.from };
      }
    }
  }
  return undefined;
}

function pathFromFileUri(uri: string): string | undefined {
  try {
    return resolve(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

function validateResourceOptions(value: unknown): StaticReason | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return 'unsupported-workspace-edit';
  }
  const allowed = new Set(['overwrite', 'ignoreIfExists', 'ignoreIfNotExists', 'recursive']);
  for (const [key, optionValue] of Object.entries(value)) {
    if (!allowed.has(key) || typeof optionValue !== 'boolean') {
      return 'unsupported-workspace-edit';
    }
    if (optionValue === true) {
      return key === 'overwrite' ? 'path-collision' : 'unsupported-workspace-edit';
    }
  }
  return undefined;
}

function existingResourceFile(
  path: string,
  rootRealpath: string
): { path: string; fingerprint: FileFingerprint } | undefined {
  const resolved = resolve(path);
  let realpath: string;
  try {
    if (lstatSync(resolved).isSymbolicLink()) {
      return undefined;
    }
    realpath = realpathSync(resolved);
  } catch {
    return undefined;
  }
  if (!isContained(realpath, rootRealpath)) {
    return undefined;
  }
  try {
    const fingerprint = fingerprintFile(realpath);
    return { path: realpath, fingerprint };
  } catch {
    return undefined;
  }
}

function conflictsWithUserOperation(operation: LspFileOperationDescriptor, path: string): boolean {
  if (operation.type === 'rename') {
    if (operation.kind === 'folder') {
      return samePath(path, operation.from) || samePath(path, operation.to) || !!containedRelative(operation.from, path) || !!containedRelative(operation.to, path);
    }
    return samePath(path, operation.from) || samePath(path, operation.to);
  }
  if (operation.type === 'create') {
    if (operation.kind === 'folder') {
      return samePath(path, operation.path) || !!containedRelative(operation.path, path);
    }
    return samePath(path, operation.path);
  }
  if (operation.kind === 'folder') {
    return samePath(path, operation.path) || !!containedRelative(operation.path, path);
  }
  return samePath(path, operation.path);
}

function conflictsWithPlan(paths: string[], steps: TransactionStep[]): boolean {
  for (const step of steps) {
    const stepPaths =
      step.type === 'text'
        ? [step.change.path]
        : step.type === 'resource-rename'
          ? [step.from, step.to]
          : [step.path];
    if (paths.some((path) => stepPaths.some((stepPath) => samePath(path, stepPath)))) {
      return true;
    }
  }
  return false;
}

function resolveRenameEditTarget(
  rootRealpath: string,
  operation: Extract<LspFileOperationDescriptor, { type: 'rename' }>,
  uri: string,
  uriPath: string
): { uri: string; path: string; readPath?: string; initialText?: string } | undefined {
  const oldUri = pathToFileURL(operation.from).href;
  const newUri = pathToFileURL(operation.to).href;
  if (operation.kind === 'file') {
    if (uri === oldUri || uri === newUri) {
      return { uri: newUri, path: operation.to, readPath: operation.from };
    }
    return existingFileTarget(uriPath, rootRealpath);
  }
  if (samePath(uriPath, operation.from) || samePath(uriPath, operation.to)) {
    return undefined;
  }
  const oldRel = containedRelative(operation.from, uriPath);
  if (oldRel) {
    const target = prospectiveContainedFile(resolve(operation.to, oldRel), rootRealpath);
    if (!target) {
      return undefined;
    }
    const source = existingFileTarget(uriPath, rootRealpath);
    if (!source) {
      return undefined;
    }
    return { uri: pathToFileURL(target).href, path: target, readPath: source.path };
  }
  const newRel = containedRelative(operation.to, uriPath);
  if (newRel) {
    const sourcePath = prospectiveContainedFile(resolve(operation.from, newRel), rootRealpath);
    const target = prospectiveContainedFile(uriPath, rootRealpath);
    if (!sourcePath || !target) {
      return undefined;
    }
    const source = existingFileTarget(sourcePath, rootRealpath);
    if (!source) {
      return undefined;
    }
    return { uri: pathToFileURL(target).href, path: target, readPath: source.path };
  }
  return existingFileTarget(uriPath, rootRealpath);
}

function resolveCreateEditTarget(
  rootRealpath: string,
  operation: Extract<LspFileOperationDescriptor, { type: 'create' }>,
  uri: string,
  uriPath: string
): { uri: string; path: string; readPath?: string; initialText?: string } | undefined {
  if (operation.kind === 'file' && samePath(uriPath, operation.path)) {
    return { uri: pathToFileURL(operation.path).href, path: operation.path, initialText: '' };
  }
  if (operation.kind === 'folder' && containedRelative(operation.path, uriPath)) {
    return undefined;
  }
  return existingFileTarget(uriPath, rootRealpath) ?? (uri === pathToFileURL(operation.path).href ? undefined : undefined);
}

function resolveDeleteEditTarget(
  rootRealpath: string,
  operation: Extract<LspFileOperationDescriptor, { type: 'delete' }>,
  _uri: string,
  uriPath: string
): { uri: string; path: string; readPath?: string; initialText?: string } | undefined {
  if (samePath(uriPath, operation.path) || containedRelative(operation.path, uriPath)) {
    return undefined;
  }
  return existingFileTarget(uriPath, rootRealpath);
}

function existingFileTarget(path: string, rootRealpath: string): { uri: string; path: string; readPath: string } | undefined {
  let realpath: string;
  try {
    realpath = realpathSync(path);
  } catch {
    return undefined;
  }
  if (!isContained(realpath, rootRealpath) || !lstatSync(realpath).isFile()) {
    return undefined;
  }
  return { uri: pathToFileURL(realpath).href, path: realpath, readPath: realpath };
}

function prospectiveContainedFile(path: string, rootRealpath: string): string | undefined {
  const resolved = resolve(path);
  if (!isContained(resolved, rootRealpath)) {
    return undefined;
  }
  const parent = nearestExistingParent(dirname(resolved));
  if (!parent) {
    return undefined;
  }
  const parentRealpath = safeRealpath(parent);
  if (!parentRealpath || !isContained(parentRealpath, rootRealpath)) {
    return undefined;
  }
  return resolved;
}

function parseTextEdits(edits: unknown[]): LspTextEdit[] | undefined {
  const parsed: LspTextEdit[] = [];
  for (const edit of edits) {
    if (!isRecord(edit) || !isRange(edit.range) || typeof edit.newText !== 'string') {
      return undefined;
    }
    if (Object.keys(edit).some((key) => key !== 'range' && key !== 'newText')) {
      return undefined;
    }
    parsed.push({ range: edit.range, newText: edit.newText });
  }
  return parsed;
}

function normalizeTextEdits(text: string, edits: LspTextEdit[]): NormalizedEdit[] {
  const normalized = edits.map((edit) => ({
    ...edit,
    startOffset: offsetAt(text, edit.range.start),
    endOffset: offsetAt(text, edit.range.end)
  }));
  for (const edit of normalized) {
    if (edit.startOffset > edit.endOffset) {
      throw new ConflictingEditError();
    }
  }
  normalized.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].endOffset > normalized[index].startOffset) {
      throw new ConflictingEditError();
    }
  }
  return normalized;
}

function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const normalized = normalizeTextEdits(text, edits).sort((a, b) => b.startOffset - a.startOffset);
  let next = text;
  for (const edit of normalized) {
    next = `${next.slice(0, edit.startOffset)}${edit.newText}${next.slice(edit.endOffset)}`;
  }
  return next;
}

function offsetAt(text: string, position: LspPosition): number {
  if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0) {
    throw new RangeError('invalid LSP position');
  }
  let line = 0;
  let lineStart = 0;
  while (line < position.line) {
    const next = text.indexOf('\n', lineStart);
    if (next === -1) {
      throw new RangeError('invalid LSP position');
    }
    lineStart = next + 1;
    line += 1;
  }
  const lineEnd = lineEndOffset(text, lineStart);
  const offset = lineStart + position.character;
  if (offset > lineEnd) {
    throw new RangeError('invalid LSP position');
  }
  return offset;
}

function lineEndOffset(text: string, lineStart: number): number {
  const newline = text.indexOf('\n', lineStart);
  if (newline === -1) {
    return text.length;
  }
  return newline > lineStart && text[newline - 1] === '\r' ? newline - 1 : newline;
}

function isPreviewFresh(preview: PendingFileOperationPreview): boolean {
  try {
    if (!sameOperationFingerprint(preview.operationFingerprint, operationFingerprint(preview.operation))) {
      return false;
    }
    for (const [path, fingerprint] of preview.fileFingerprints) {
      if (!sameFileFingerprint(fingerprint, fingerprintFile(path))) {
        return false;
      }
    }
    for (const fingerprint of preview.resourceFingerprints) {
      if (!sameResourceFingerprint(fingerprint)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function changedFilesForPreview(preview: PendingFileOperationPreview): string[] {
  const resourcePaths = preview.resourceOps.flatMap((operation) => {
    if (operation.type === 'rename') {
      return [operation.to];
    }
    return [operation.path];
  });
  return [...new Set([operationPath(preview.operation), ...preview.changes.map((change) => change.path), ...resourcePaths])].sort();
}

function rollback(
  preview: PendingFileOperationPreview,
  input: {
    snapshots: Map<string, Buffer>;
    createdPaths: Set<string>;
    resourceRenames: Array<{ from: string; to: string }>;
    resourceTombstones: Array<{ path: string; tombstonePath: string }>;
    tombstonePath?: string;
    mutationDone: boolean;
  }
): boolean {
  try {
    for (const [path, content] of [...input.snapshots.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      writeFileSync(path, content);
    }
    for (const path of [...input.createdPaths].sort((a, b) => b.length - a.length)) {
      rmSync(path, { recursive: true, force: true });
    }
    for (const rename of [...input.resourceRenames].reverse()) {
      if (existsSync(rename.to) && !existsSync(rename.from)) {
        renameSync(rename.to, rename.from);
      }
    }
    for (const tombstone of [...input.resourceTombstones].reverse()) {
      if (existsSync(tombstone.tombstonePath) && !existsSync(tombstone.path)) {
        renameSync(tombstone.tombstonePath, tombstone.path);
      }
    }
    if (!input.mutationDone) {
      return true;
    }
    if (preview.operation.type === 'rename' && existsSync(preview.operation.to) && !existsSync(preview.operation.from)) {
      renameSync(preview.operation.to, preview.operation.from);
    }
    if (preview.operation.type === 'delete' && input.tombstonePath && existsSync(input.tombstonePath) && !existsSync(preview.operation.path)) {
      renameSync(input.tombstonePath, preview.operation.path);
    }
    return true;
  } catch {
    return false;
  }
}

async function notifyDidOperation(
  preview: PendingFileOperationPreview,
  notify: {
    notifyDidRename: NonNullable<LspFileOperationPreviewStoreOptions['notifyDidRename']>;
    notifyDidCreate: NonNullable<LspFileOperationPreviewStoreOptions['notifyDidCreate']>;
    notifyDidDelete: NonNullable<LspFileOperationPreviewStoreOptions['notifyDidDelete']>;
  }
): Promise<void> {
  if (preview.operation.type === 'rename') {
    await notify.notifyDidRename({
      workspaceRoot: preview.rootRealpath,
      oldPath: preview.operation.from,
      newPath: preview.operation.to,
      kind: preview.operation.kind
    });
    return;
  }
  if (preview.operation.type === 'create') {
    await notify.notifyDidCreate({ workspaceRoot: preview.rootRealpath, path: preview.operation.path, kind: preview.operation.kind });
    return;
  }
  await notify.notifyDidDelete({ workspaceRoot: preview.rootRealpath, path: preview.operation.path, kind: preview.operation.kind });
}

function previewFailure(reason: StaticReason): LspFileOperationPreviewResponse {
  return { ok: false, statusCode: 409, error: 'lsp file operation preview failed', reason };
}

function previewExpired(): LspFileOperationApplyResponse {
  return { ok: false, statusCode: 409, error: 'preview expired', reason: 'preview-expired' };
}

function applyFailure(reason: StaticReason): LspFileOperationApplyResponse {
  return { ok: false, statusCode: 409, error: 'lsp file operation apply failed', reason };
}

function resourceOpsResponse(resourceOps: LspFileResourceOperation[]): { resourceOps?: LspFileResourceOperation[] } {
  return resourceOps.length > 0 ? { resourceOps } : {};
}

function operationPath(operation: LspFileOperationDescriptor): string {
  if (operation.type === 'rename') {
    return operation.to;
  }
  return operation.path;
}

function affectedUserPaths(preview: PendingFileOperationPreview, touchedFiles: string[]): string[] {
  return [...new Set(touchedFiles.map((path) => toWorkspaceRelativePath(preview.rootRealpath, path)).filter((path): path is string => !!path))].sort();
}

function operationFingerprint(operation: LspFileOperationDescriptor): OperationFingerprint {
  if (operation.type === 'rename') {
    return {
      type: 'rename',
      source: fingerprintEntry(operation.from, operation.kind),
      targetParent: fingerprintDirectory(dirname(operation.to)),
      targetExists: existsSync(operation.to)
    };
  }
  if (operation.type === 'create') {
    return { type: 'create', targetParent: fingerprintDirectory(dirname(operation.path)), targetExists: existsSync(operation.path) };
  }
  return { type: 'delete', source: fingerprintEntry(operation.path, operation.kind) };
}

function sameOperationFingerprint(left: OperationFingerprint, right: OperationFingerprint): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === 'rename' && right.type === 'rename') {
    return sameEntryFingerprint(left.source, right.source) && sameDirectoryFingerprint(left.targetParent, right.targetParent) && left.targetExists === right.targetExists;
  }
  if (left.type === 'create' && right.type === 'create') {
    return sameDirectoryFingerprint(left.targetParent, right.targetParent) && left.targetExists === right.targetExists;
  }
  return left.type === 'delete' && right.type === 'delete' && sameEntryFingerprint(left.source, right.source);
}

function sameResourceFingerprint(fingerprint: ResourceOperationFingerprint): boolean {
  if (fingerprint.type === 'create') {
    return (
      sameDirectoryFingerprint(fingerprint.parent, fingerprintDirectory(dirname(fingerprint.path))) &&
      existsSync(fingerprint.path) === fingerprint.targetExists
    );
  }
  if (fingerprint.type === 'rename') {
    return (
      sameFileFingerprint(fingerprint.source, fingerprintFile(fingerprint.from)) &&
      sameDirectoryFingerprint(fingerprint.targetParent, fingerprintDirectory(dirname(fingerprint.to))) &&
      existsSync(fingerprint.to) === fingerprint.targetExists
    );
  }
  return sameFileFingerprint(fingerprint.source, fingerprintFile(fingerprint.path));
}

function capturedExistingPath(
  path: string,
  rootRealpath: string
): { path: string; kind: LspFileOperationKind; fingerprint: EntryFingerprint } | undefined {
  let realpath: string;
  try {
    realpath = realpathSync(path);
  } catch {
    return undefined;
  }
  if (!isContained(realpath, rootRealpath)) {
    return undefined;
  }
  const kind = entryKind(realpath);
  if (!kind) {
    return undefined;
  }
  try {
    return { path: realpath, kind, fingerprint: fingerprintEntry(realpath, kind) };
  } catch {
    return undefined;
  }
}

function createdPath(path: string, rootRealpath: string): { path: string; parentFingerprint: DirectoryFingerprint } | undefined {
  const parent = safeRealpath(dirname(path));
  if (!parent || !isContained(parent, rootRealpath)) {
    return undefined;
  }
  const name = basename(path);
  if (name === '' || name === '.' || name === '..') {
    return undefined;
  }
  const candidate = resolve(parent, name);
  if (!isContained(candidate, rootRealpath)) {
    return undefined;
  }
  return { path: candidate, parentFingerprint: fingerprintDirectory(parent) };
}

function fingerprintEntry(path: string, kind: LspFileOperationKind): EntryFingerprint {
  return { kind, realpath: realpathSync(path), manifest: fingerprintSubtree(path, kind) };
}

function fingerprintSubtree(path: string, kind: LspFileOperationKind, base = path): SubtreeEntryFingerprint[] {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error('non-regular-entry');
  }
  if (kind === 'file') {
    if (!stat.isFile()) {
      throw new Error('non-regular-entry');
    }
    return [
      {
        relativePath: '',
        kind: 'file',
        realpath: realpathSync(path),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex')
      }
    ];
  }
  if (!stat.isDirectory()) {
    throw new Error('non-regular-entry');
  }
  const entries: SubtreeEntryFingerprint[] = [
    {
      relativePath: relative(base, path).split(sep).join('/'),
      kind: 'folder',
      realpath: realpathSync(path),
      mtimeMs: stat.mtimeMs,
      size: stat.size
    }
  ];
  for (const name of readdirSync(path).sort()) {
    const child = join(path, name);
    const childKind = entryKind(child);
    if (!childKind) {
      throw new Error('non-regular-entry');
    }
    entries.push(...fingerprintSubtree(child, childKind, base));
  }
  return entries;
}

function sameEntryFingerprint(left: EntryFingerprint, right: EntryFingerprint): boolean {
  return left.kind === right.kind && left.realpath === right.realpath && JSON.stringify(left.manifest) === JSON.stringify(right.manifest);
}

function fingerprintFile(path: string): FileFingerprint {
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error('non-regular-entry');
  }
  const content = readFileSync(path);
  return {
    path,
    realpath: realpathSync(path),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sha256: createHash('sha256').update(content).digest('hex')
  };
}

function fingerprintDirectory(path: string): DirectoryFingerprint {
  const stat = statSync(path);
  return { realpath: realpathSync(path), mtimeMs: stat.mtimeMs, size: stat.size };
}

function sameFileFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.realpath === right.realpath && left.mtimeMs === right.mtimeMs && left.size === right.size && left.sha256 === right.sha256;
}

function sameDirectoryFingerprint(left: DirectoryFingerprint, right: DirectoryFingerprint): boolean {
  return left.realpath === right.realpath && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function createTombstonePath(path: string): string {
  for (let index = 0; index < 20; index += 1) {
    const candidate = join(dirname(path), `.desk-lsp-delete-${randomBytes(9).toString('hex')}`);
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('tombstone unavailable');
}

function sanitizeResponse<T>(value: T, secrets: readonly string[]): T {
  return scrub(value, secrets) as T;
}

function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    return secrets.reduce((next, secret) => (secret ? next.split(secret).join('[redacted]') : next), value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrub(entry, secrets));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [scrub(key, secrets), scrub(entry, secrets)]));
  }
  return value;
}

function entryKind(path: string): LspFileOperationKind | undefined {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return undefined;
  }
  if (stat.isFile()) {
    return 'file';
  }
  if (stat.isDirectory()) {
    return 'folder';
  }
  return undefined;
}

function nearestExistingParent(path: string): string | undefined {
  let next = resolve(path);
  while (!existsSync(next)) {
    const parent = dirname(next);
    if (parent === next) {
      return undefined;
    }
    next = parent;
  }
  return next;
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isContained(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function containedRelative(parent: string, child: string): string | undefined {
  const rel = relative(parent, child);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function toWorkspaceRelativePath(root: string, path: string): string | undefined {
  if (!isContained(path, root)) {
    return undefined;
  }
  return relative(root, path).split(sep).join('/');
}

function isRange(value: unknown): value is LspRange {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

function isPosition(value: unknown): value is LspPosition {
  return (
    isRecord(value) &&
    typeof value.line === 'number' &&
    typeof value.character === 'number' &&
    Number.isInteger(value.line) &&
    Number.isInteger(value.character) &&
    value.line >= 0 &&
    value.character >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class ConflictingEditError extends Error {}
