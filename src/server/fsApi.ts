import { createReadStream, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { readJsonBody, sendJson } from './httpUtil.js';
import { resolveFsPath } from './fsSafety.js';
import {
  copyEntry,
  createEntry,
  deleteEntry,
  listDirectory,
  MAX_EDITABLE_BYTES,
  readFileSafe,
  renameEntry,
  writeFileAtomic,
  writeFileAtomicCreate
} from './fsOps.js';
import { searchContent, searchFiles } from './fsSearch.js';
import { readManifestFile, resolveManifestPath, updateManifestFile, withManifestFileLock } from '../core/config.js';
import type { DeskNotesSettings } from '../core/types.js';
import type { LspFileOperationCoordinator, LspFileOperationKind } from './lsp/lspFileOperationCoordinator.js';
import { ApiValidationError } from './apiValidation.js';

export interface FsRequestOptions {
  fileOperationCoordinator?: LspFileOperationCoordinator;
}

const FS_WRITE_JSON_BODY_MAX_BYTES = MAX_EDITABLE_BYTES * 6 + 64 * 1024;

/**
 * Handle /api/fs/* requests. Returns false when the URL is not an fs route
 * so the caller's routing chain continues.
 */
export async function handleFsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: FsRequestOptions = {}
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/fs/')) {
    return false;
  }

  if (req.method === 'GET' && url.pathname === '/api/fs/home') {
    sendJson(res, 200, { home: homedir() });
    return true;
  }

  // Derives an explorer root that contains an arbitrary absolute path, so a file
  // link from a chat (or any subsystem) opens even when it lives outside the
  // editor's current root. Returns the tilde-expanded path too.
  if (req.method === 'GET' && url.pathname === '/api/fs/root-for') {
    const raw = url.searchParams.get('path');
    if (typeof raw !== 'string' || raw.trim() === '') {
      sendJson(res, 400, { error: 'path required' });
      return true;
    }
    const path = resolve(expandTilde(raw));
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      isDir = false; // not on disk - treated as a file open attempt
    }
    sendJson(res, 200, { root: deriveRootForPath(path), path, isDir });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/fs/notes-home') {
    // Notes live beside the manifest; ensure the directory exists so the
    // notes subsystem can boot on a fresh install.
    const notesDir = join(homedir(), '.config', 'desk', 'notes');
    mkdirSync(notesDir, { recursive: true });
    sendJson(res, 200, { path: notesDir });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/fs/notes-state') {
    const manifest = readManifestFile(resolveManifestPath());
    sendJson(res, 200, manifest.settings?.notes ?? {});
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/fs/notes-state') {
    const body = await readJsonBody(req);
    const manifestPath = resolveManifestPath();
    let next: DeskNotesSettings | undefined;
    await updateManifestFile(manifestPath, (manifest) => {
      next = { ...(manifest.settings?.notes ?? {}) };
      if (Array.isArray(body.openFiles)) {
        next.openFiles = body.openFiles.filter((file): file is string => typeof file === 'string');
      }
      if (typeof body.activeFile === 'string') {
        next.activeFile = body.activeFile;
      } else if (body.activeFile === null) {
        delete next.activeFile;
      }
      return { ...manifest, settings: { ...(manifest.settings ?? {}), notes: next } };
    });
    if (!next) {
      throw new Error('notes update unexpectedly produced no state');
    }
    sendJson(res, 200, next);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/fs/validate') {
    const candidate = url.searchParams.get('path') ?? '';
    try {
      const resolved = resolve(candidate.replace(/^~(?=$|\/)/, homedir()));
      if (statSync(resolved).isDirectory()) {
        sendJson(res, 200, { ok: true, resolved });
      } else {
        sendJson(res, 200, { ok: false, error: 'not a directory' });
      }
    } catch {
      sendJson(res, 200, { ok: false, error: 'does not exist' });
    }
    return true;
  }

  if (req.method === 'GET') {
    const root = requireRoot(url.searchParams.get('root'));

    if (url.pathname === '/api/fs/list') {
      const path = resolveFsPath(url.searchParams.get('path'), root);
      sendJson(res, 200, { entries: listDirectory(path) });
      return true;
    }

    if (url.pathname === '/api/fs/read') {
      // The manifest is openable from the header regardless of explorer root.
      const path = resolveFsPath(url.searchParams.get('path'), root, [resolveManifestPath()]);
      sendJson(res, 200, readFileSafe(path));
      return true;
    }

    if (url.pathname === '/api/fs/raw') {
      // Raw bytes for the image/pdf viewers. Same root guard as every other
      // route; streamed so large PDFs never buffer in memory.
      const path = resolveFsPath(url.searchParams.get('path'), root);
      const contentType = rawContentType(path);
      if (!contentType) {
        // Only the viewer types are served raw - anything else is 415 rather
        // than a sniffable octet-stream.
        sendJson(res, 415, { error: 'unsupported raw type' });
        return true;
      }
      const stats = statSync(path);
      if (!stats.isFile()) {
        sendJson(res, 404, { error: 'not a file' });
        return true;
      }
      res.statusCode = 200;
      res.setHeader('content-type', contentType);
      res.setHeader('content-length', stats.size);
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('x-content-type-options', 'nosniff');
      const safeName = basename(path).replace(/[^\w.-]/g, '_');
      res.setHeader('content-disposition', `inline; filename="${safeName}"`);
      if (contentType !== 'application/pdf') {
        // Neutralize scripts in SVG (or anything else) when the URL is opened
        // directly: <img> rendering never executes scripts, and this CSP stops
        // direct navigation from running them in the desk origin. PDFs are
        // exempt because the sandbox directive breaks the native PDF plugin.
        res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      }
      const stream = createReadStream(path);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return true;
    }

    if (url.pathname === '/api/fs/search') {
      const query = url.searchParams.get('q') ?? '';
      const mode = url.searchParams.get('mode') === 'content' ? 'content' : 'files';
      if (query.trim() === '') {
        sendJson(res, 200, { matches: [], truncated: false });
        return true;
      }
      const result = mode === 'content' ? await searchContent(root, query) : await searchFiles(root, query);
      sendJson(res, 200, result);
      return true;
    }
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req, largeFsBodyRoute(url.pathname) ? { maxBytes: FS_WRITE_JSON_BODY_MAX_BYTES } : undefined);
    const root = requireRoot(typeof body.root === 'string' ? body.root : null);

    if (url.pathname === '/api/fs/write') {
      const path = resolveFsPath(body.path, root, [resolveManifestPath()]);
      const content = body.content;
      if (typeof content !== 'string') {
        throw new ApiValidationError('content must be a string');
      }
      const expected = typeof body.mtimeMs === 'number' ? body.mtimeMs : undefined;
      const result =
        path === resolveManifestPath()
          ? await withManifestFileLock(path, () => writeFileAtomic(path, content, expected))
          : writeFileAtomic(path, content, expected);
      sendJson(res, result.ok ? 200 : 409, result);
      return true;
    }

    if (url.pathname === '/api/fs/create') {
      const path = resolveFsPath(body.path, root);
      const kind = body.kind === 'dir' ? 'dir' : 'file';
      createEntry(path, kind);
      await notifyFileOperation(() =>
        options.fileOperationCoordinator?.didCreate({ workspaceRoot: root, path, kind: lspKind(kind) })
      );
      sendJson(res, 200, { ok: true, path });
      return true;
    }

    if (url.pathname === '/api/fs/create-preview') {
      const path = resolveFsPath(body.path, root);
      const kind = body.kind === 'dir' ? 'folder' : 'file';
      if (!options.fileOperationCoordinator?.previewCreate) {
        sendJson(res, 200, {
          ok: true,
          status: 'no-running-session',
          operation: { type: 'create', path, kind },
          changes: []
        });
        return true;
      }
      const preview = await options.fileOperationCoordinator.previewCreate({
        workspaceRoot: root,
        path,
        kind,
        ...(body.supportsResourceOps === true ? { supportsResourceOps: true } : {})
      });
      sendFsOperationResult(res, preview);
      return true;
    }

    if (url.pathname === '/api/fs/create-apply') {
      const previewId = typeof body.previewId === 'string' ? body.previewId : '';
      if (!previewId || !options.fileOperationCoordinator?.applyCreate) {
        sendJson(res, 409, { ok: false, error: 'preview expired', reason: 'preview-expired' });
        return true;
      }
      const result = await options.fileOperationCoordinator.applyCreate({ workspaceRoot: root, previewId });
      sendFsOperationResult(res, result);
      return true;
    }

    if (url.pathname === '/api/fs/rename-preview') {
      const from = resolveFsPath(body.from, root);
      const to = resolveFsPath(body.to, root);
      const kind = lspKindFromPath(from);
      if (!options.fileOperationCoordinator?.previewRename) {
        sendJson(res, 200, {
          ok: true,
          status: 'no-running-session',
          operation: { type: 'rename', from, to, kind },
          changes: []
        });
        return true;
      }
      const preview = await options.fileOperationCoordinator.previewRename({
        workspaceRoot: root,
        from,
        to,
        kind,
        ...(body.supportsResourceOps === true ? { supportsResourceOps: true } : {})
      });
      sendFsOperationResult(res, preview);
      return true;
    }

    if (url.pathname === '/api/fs/rename-apply') {
      const previewId = typeof body.previewId === 'string' ? body.previewId : '';
      if (!previewId || !options.fileOperationCoordinator?.applyRename) {
        sendJson(res, 409, { ok: false, error: 'preview expired', reason: 'preview-expired' });
        return true;
      }
      const result = await options.fileOperationCoordinator.applyRename({ workspaceRoot: root, previewId });
      sendFsOperationResult(res, result);
      return true;
    }

    if (url.pathname === '/api/fs/rename') {
      const from = resolveFsPath(body.from, root);
      const to = resolveFsPath(body.to, root);
      const kind = lspKindFromPath(from);
      const oldPath = realpathSync(from);
      renameEntry(from, to);
      await notifyFileOperation(() =>
        options.fileOperationCoordinator?.didRename({ workspaceRoot: root, oldPath, newPath: to, kind })
      );
      sendJson(res, 200, { ok: true, path: to });
      return true;
    }

    if (url.pathname === '/api/fs/copy') {
      const from = resolveFsPath(body.from, root);
      const to = resolveFsPath(body.to, root);
      copyEntry(from, to);
      sendJson(res, 200, { ok: true, path: to });
      return true;
    }

    if (url.pathname === '/api/fs/delete') {
      const path = resolveFsPath(body.path, root);
      if (path === resolve(root)) {
        throw new ApiValidationError('refusing to delete the explorer root');
      }
      const kind = lspKindFromPath(path);
      const deletedPath = realpathSync(path);
      deleteEntry(path);
      await notifyFileOperation(() =>
        options.fileOperationCoordinator?.didDelete({ workspaceRoot: root, path: deletedPath, kind })
      );
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/fs/delete-preview') {
      const path = resolveFsPath(body.path, root);
      if (path === resolve(root)) {
        throw new ApiValidationError('refusing to delete the explorer root');
      }
      const kind = lspKindFromPath(path);
      const deletedPath = realpathSync(path);
      if (!options.fileOperationCoordinator?.previewDelete) {
        sendJson(res, 200, {
          ok: true,
          status: 'no-running-session',
          operation: { type: 'delete', path: deletedPath, kind },
          changes: []
        });
        return true;
      }
      const preview = await options.fileOperationCoordinator.previewDelete({
        workspaceRoot: root,
        path: deletedPath,
        kind,
        ...(body.supportsResourceOps === true ? { supportsResourceOps: true } : {})
      });
      sendFsOperationResult(res, preview);
      return true;
    }

    if (url.pathname === '/api/fs/delete-apply') {
      const previewId = typeof body.previewId === 'string' ? body.previewId : '';
      if (!previewId || !options.fileOperationCoordinator?.applyDelete) {
        sendJson(res, 409, { ok: false, error: 'preview expired', reason: 'preview-expired' });
        return true;
      }
      const result = await options.fileOperationCoordinator.applyDelete({ workspaceRoot: root, previewId });
      sendFsOperationResult(res, result);
      return true;
    }

    if (url.pathname === '/api/fs/upload') {
      const dirPath = resolveFsPath(body.dirPath, root);
      const fileName = typeof body.name === 'string' ? body.name : '';
      const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';

      if (!fileName || !dataBase64) {
        sendJson(res, 400, { error: 'name and dataBase64 required' });
        return true;
      }

      // Decode base64 to buffer
      const buffer = Buffer.from(dataBase64, 'base64');
      const filePath = join(dirPath, fileName);

      // Write file atomically (creates parent dirs)
      const result = writeFileAtomicCreate(filePath, buffer);
      if (!result.ok) {
        sendJson(res, 409, { error: 'file already exists' });
        return true;
      }
      await notifyFileOperation(() =>
        options.fileOperationCoordinator?.didCreate({ workspaceRoot: root, path: filePath, kind: 'file' })
      );
      sendJson(res, 200, { ok: true, path: filePath });
      return true;
    }
  }

  sendJson(res, 404, { error: `unknown fs route ${url.pathname}` });
  return true;
}

const RAW_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf'
};

/** Content type for the raw viewer endpoint; null = not a servable viewer type. */
export function rawContentType(path: string): string | null {
  return RAW_CONTENT_TYPES[extname(path).toLowerCase()] ?? null;
}

function requireRoot(value: string | null): string {
  if (!value || value.trim() === '') {
    throw new ApiValidationError('root query/body parameter is required');
  }
  return value;
}

function largeFsBodyRoute(pathname: string): boolean {
  return pathname === '/api/fs/write' || pathname === '/api/fs/create';
}

/** Expands a leading ~ to the server's home directory. */
export function expandTilde(path: string): string {
  if (path === '~') {
    return homedir();
  }
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** Nearest ancestor directory containing a `.git` entry, or null. */
function gitRootOf(startDir: string): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/**
 * Picks an explorer root that contains `resolvedPath`: the longest manifest
 * project/session cwd that is an ancestor (so the explorer shows the whole
 * project), else the file's git root, else its directory.
 */
export function deriveRootForPath(resolvedPath: string): string {
  // Always the target's parent, so a directory target appears as a node inside
  // the tree rather than becoming the root itself.
  const baseDir = dirname(resolvedPath);
  try {
    const manifest = readManifestFile(resolveManifestPath());
    const cwds: string[] = [];
    const collect = (cwd?: string): void => {
      if (cwd) {
        cwds.push(resolve(expandTilde(cwd)));
      }
    };
    for (const project of manifest.projects ?? []) {
      collect(project.cwd);
      for (const group of project.groups) {
        for (const session of group.sessions) {
          collect(session.cwd);
        }
      }
    }
    for (const group of manifest.groups) {
      for (const session of group.sessions) {
        collect(session.cwd);
      }
    }
    const ancestors = cwds.filter((cwd) => resolvedPath === cwd || resolvedPath.startsWith(cwd + sep));
    if (ancestors.length > 0) {
      return ancestors.sort((a, b) => b.length - a.length)[0];
    }
  } catch {
    // No/unreadable manifest - fall through to git/dir derivation.
  }
  return gitRootOf(baseDir) ?? baseDir;
}

function lspKind(kind: 'file' | 'dir'): LspFileOperationKind {
  return kind === 'dir' ? 'folder' : 'file';
}

function lspKindFromPath(path: string): LspFileOperationKind {
  return statSync(path).isDirectory() ? 'folder' : 'file';
}

async function notifyFileOperation(notify: () => Promise<number> | undefined): Promise<void> {
  try {
    await notify();
  } catch {
    // File operations are already committed at this point; notifications are best-effort.
  }
}

function sendFsOperationResult(res: ServerResponse, result: { ok: boolean; statusCode?: number }): void {
  if (result.ok) {
    sendJson(res, 200, result);
    return;
  }
  const { statusCode = 409, ...body } = result;
  sendJson(res, statusCode, body);
}
