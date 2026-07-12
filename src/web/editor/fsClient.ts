export interface FsEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir' | 'symlink';
  size: number;
  mtimeMs: number;
  hidden: boolean;
  expandable: boolean;
}

export type FsReadResult =
  | { ok: true; content: string; mtimeMs: number; size: number }
  | { ok: false; reason: 'binary' | 'too-large'; size: number };

export type FsWriteResult = { ok: true; mtimeMs: number } | { ok: false; conflict: true; mtimeMs: number };

export interface FsSearchFileMatch {
  path: string;
  score: number;
}

export interface FsSearchContentMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface FsChangeEvent {
  event: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';
  path: string;
  watched: string;
}

async function readJson<T>(request: Promise<Response>): Promise<T> {
  // Read text FIRST, then parse — never `response.json()` before the status
  // check. A non-JSON error body (a proxy 502 HTML page, the Vite SPA index
  // served on an unknown route, an empty 500) otherwise threw a cryptic
  // "Unexpected token '<'" and discarded the real HTTP status. 409 stays a
  // valid result (a write conflict carries a JSON body), not an error.
  const response = await request;
  const text = await response.text();
  let payload: (T & { error?: string }) | undefined;
  if (text) {
    try {
      payload = JSON.parse(text) as T & { error?: string };
    } catch {
      payload = undefined;
    }
  }
  if (!response.ok && response.status !== 409) {
    throw new Error(payload?.error ?? `request failed (${response.status})`);
  }
  if (payload === undefined) {
    throw new Error(`request failed (${response.status}): unexpected non-JSON response`);
  }
  return payload;
}

const enc = encodeURIComponent;

export async function fsHome(): Promise<string> {
  const payload = await readJson<{ home: string }>(fetch('/api/fs/home'));
  return payload.home;
}

/** Notes root (~/.config/desk/notes); the server creates it if missing. */
export async function fsNotesHome(): Promise<string> {
  const payload = await readJson<{ path: string }>(fetch('/api/fs/notes-home'));
  return payload.path;
}

export interface NotesState {
  openFiles?: string[];
  activeFile?: string;
}

export async function fsNotesState(): Promise<NotesState> {
  return readJson(fetch('/api/fs/notes-state'));
}

export async function fsSaveNotesState(state: { openFiles: string[]; activeFile: string | null }): Promise<void> {
  await readJson(
    fetch('/api/fs/notes-state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state)
    })
  );
}

export async function fsValidate(path: string): Promise<{ ok: boolean; resolved?: string; error?: string }> {
  return readJson(fetch(`/api/fs/validate?path=${enc(path)}`));
}

export async function fsList(root: string, path: string): Promise<FsEntry[]> {
  const payload = await readJson<{ entries: FsEntry[] }>(fetch(`/api/fs/list?root=${enc(root)}&path=${enc(path)}`));
  return payload.entries;
}

export async function fsRead(root: string, path: string): Promise<FsReadResult> {
  return readJson(fetch(`/api/fs/read?root=${enc(root)}&path=${enc(path)}`));
}

/** Resolves an explorer root that contains an arbitrary absolute (or ~) path,
 *  the tilde-expanded path, and whether it's a directory — so a chat link can
 *  open a file or reveal a directory in the tree. */
export async function fsRootFor(path: string): Promise<{ root: string; path: string; isDir: boolean }> {
  return readJson(fetch(`/api/fs/root-for?path=${enc(path)}`));
}

export async function fsWrite(root: string, path: string, content: string, mtimeMs?: number): Promise<FsWriteResult> {
  return readJson(
    fetch('/api/fs/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, path, content, mtimeMs })
    })
  );
}

export async function fsCreate(root: string, path: string, kind: 'file' | 'dir'): Promise<void> {
  await readJson(
    fetch('/api/fs/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, path, kind })
    })
  );
}

export async function fsRename(root: string, from: string, to: string): Promise<void> {
  await readJson(
    fetch('/api/fs/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, from, to })
    })
  );
}

export interface LspTextEditPreview {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

export interface LspRenamePreviewChange {
  uri: string;
  path: string;
  edits: LspTextEditPreview[];
}

/** Kind of a file-operation target. The backend maps the fs 'dir' kind to 'folder'. */
export type FileOperationKind = 'file' | 'folder';

/** The 4a operation descriptor echoed in preview/apply responses (absolute in-root paths). */
export type FileOperationDescriptor =
  | { type: 'rename'; from: string; to: string; kind: FileOperationKind }
  | { type: 'create'; path: string; kind: FileOperationKind }
  | { type: 'delete'; path: string; kind: FileOperationKind };

/**
 * The 4c-a contained resource operations a server WorkspaceEdit may carry (file-only v1). Surfaced
 * only for opted-in previews (supportsResourceOps:true) as an allowlist shape with absolute in-root
 * paths; the backend never forwards raw options/annotationId/data/keys.
 */
export type LspFileResourceOperation =
  | { type: 'create'; path: string; kind: 'file' }
  | { type: 'rename'; from: string; to: string; kind: 'file' }
  | { type: 'delete'; path: string; kind: 'file' };

/** Mirrors the 4a/4c LspFileOperationPreviewResponse. Never thrown; 4xx is a discriminated value. */
export type FileOpPreviewResult =
  | {
      ok: true;
      status: 'ready';
      previewId: string;
      operation: FileOperationDescriptor;
      changes: LspRenamePreviewChange[];
      resourceOps: LspFileResourceOperation[];
    }
  | {
      ok: true;
      status: 'no-running-session' | 'no-capability' | 'no-edits';
      operation: FileOperationDescriptor;
      changes: [];
      resourceOps: LspFileResourceOperation[];
    }
  | { ok: false; error: string; reason?: string };

/** Mirrors the 4a/4c LspFileOperationApplyResponse. affectedPaths are workspace-relative display-only. */
export type FileOpApplyResult =
  | { ok: true; operation: FileOperationDescriptor; path: string; changedFiles: string[]; resourceOps: LspFileResourceOperation[] }
  | { ok: false; error: string; reason?: string; affectedPaths?: string[] };

// Back-compat aliases for the single-file rename call sites.
export type RenamePreviewResult = FileOpPreviewResult;
export type RenameApplyResult = FileOpApplyResult;

/** Coerce a parsed preview/apply result so `resourceOps` is always an array (older/text-only previews omit it). */
function normalizeResourceOps<T extends { ok: boolean }>(result: T): T {
  const record = result as { ok: boolean; resourceOps?: unknown };
  if (record.ok && !Array.isArray(record.resourceOps)) {
    record.resourceOps = [];
  }
  return result;
}

async function fileOpPreview(endpoint: string, body: Record<string, unknown>): Promise<FileOpPreviewResult> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return normalizeResourceOps((await response.json()) as FileOpPreviewResult);
  } catch {
    return { ok: false, error: 'file operation preview unavailable' };
  }
}

async function fileOpApply(endpoint: string, root: string, previewId: string): Promise<FileOpApplyResult> {
  try {
    // previewId-only apply: never send client-submitted edits or resourceOps.
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, previewId })
    });
    return normalizeResourceOps((await response.json()) as FileOpApplyResult);
  } catch {
    return { ok: false, error: 'file operation apply failed' };
  }
}

/**
 * Non-mutating LSP-aware rename/move preview (file or folder). Never throws on 4xx.
 * Sends supportsResourceOps:true: this client renders + confirms resourceOps, so the 4c-a backend
 * may return contained CreateFile/RenameFile/DeleteFile resource ops for explicit confirmation.
 */
export async function fsRenamePreview(root: string, from: string, to: string): Promise<FileOpPreviewResult> {
  return fileOpPreview('/api/fs/rename-preview', { root, from, to, supportsResourceOps: true });
}

/** Apply a previewed rename/move by previewId only. */
export async function fsRenameApply(root: string, previewId: string): Promise<FileOpApplyResult> {
  return fileOpApply('/api/fs/rename-apply', root, previewId);
}

/** Non-mutating create preview (file or dir); willCreate edits may touch existing importers. */
export async function fsCreatePreview(root: string, path: string, kind: 'file' | 'dir'): Promise<FileOpPreviewResult> {
  return fileOpPreview('/api/fs/create-preview', { root, path, kind, supportsResourceOps: true });
}

/** Apply a previewed create by previewId only. */
export async function fsCreateApply(root: string, previewId: string): Promise<FileOpApplyResult> {
  return fileOpApply('/api/fs/create-apply', root, previewId);
}

/** Non-mutating delete preview (file or folder); willDelete edits rewrite importers. */
export async function fsDeletePreview(root: string, path: string): Promise<FileOpPreviewResult> {
  return fileOpPreview('/api/fs/delete-preview', { root, path, supportsResourceOps: true });
}

/** Apply a previewed delete by previewId only. */
export async function fsDeleteApply(root: string, previewId: string): Promise<FileOpApplyResult> {
  return fileOpApply('/api/fs/delete-apply', root, previewId);
}

// ---- Pure file-operation reconciliation helpers (monaco-free; unit-tested) ----

/** True when `path` is `dir` itself or a descendant of it (absolute in-root, '/'-separated). */
export function isPathUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Remap a path from an old subtree root to a new one. Returns the remapped path when `path` is under
 * `fromDir` (or equals it), else null. Used for folder rename/move tab rekey from operation.from->to.
 */
export function remapSubtreePath(path: string, fromDir: string, toDir: string): string | null {
  if (!isPathUnder(path, fromDir)) {
    return null;
  }
  return `${toDir}${path.slice(fromDir.length)}`;
}

/** Open paths under `dir` (== or descendant). Used to enumerate tabs to rekey (rename) or close (delete). */
export function enumerateSubtree(openPaths: Iterable<string>, dir: string): string[] {
  return [...openPaths].filter((path) => isPathUnder(path, dir));
}

/** All absolute in-root paths a resource-op set touches (create target, rename old+new, delete target). */
export function resourceOpPaths(ops: Iterable<LspFileResourceOperation>): string[] {
  const paths: string[] = [];
  for (const op of ops) {
    if (op.type === 'rename') {
      paths.push(op.from, op.to);
    } else {
      paths.push(op.path);
    }
  }
  return paths;
}

/**
 * The dirty open paths that must hard-block an apply: any dirty file in the operated source subtree
 * (folder rename/move/delete), in the preview's text-edit touched set (changes[].path), or on any
 * resource-op path (create target / rename old+new / delete target).
 */
export function fileOpDirtyBlock(input: {
  dirtyPaths: Iterable<string>;
  sourceDir?: string;
  touchedPaths: Iterable<string>;
  resourceOpPaths?: Iterable<string>;
}): string[] {
  const touched = new Set(input.touchedPaths);
  for (const path of input.resourceOpPaths ?? []) {
    touched.add(path);
  }
  const blocked = new Set<string>();
  for (const path of input.dirtyPaths) {
    if (touched.has(path) || (input.sourceDir !== undefined && isPathUnder(path, input.sourceDir))) {
      blocked.add(path);
    }
  }
  return [...blocked];
}

export async function fsCopy(root: string, from: string, to: string): Promise<void> {
  await readJson(
    fetch('/api/fs/copy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, from, to })
    })
  );
}

export async function fsDelete(root: string, path: string): Promise<void> {
  await readJson(
    fetch('/api/fs/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, path })
    })
  );
}

export async function fsSearchFiles(root: string, query: string): Promise<{ matches: FsSearchFileMatch[]; truncated: boolean }> {
  return readJson(fetch(`/api/fs/search?root=${enc(root)}&q=${enc(query)}&mode=files`));
}

export async function fsSearchContent(
  root: string,
  query: string
): Promise<{ matches: FsSearchContentMatch[]; truncated: boolean }> {
  return readJson(fetch(`/api/fs/search?root=${enc(root)}&q=${enc(query)}&mode=content`));
}

export async function fsUpload(root: string, dirPath: string, name: string, dataBase64: string): Promise<void> {
  await readJson(
    fetch('/api/fs/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, dirPath, name, dataBase64 })
    })
  );
}

/**
 * /ws/fs client: watch/unwatch directories and files, auto-reconnect with
 * full resubscribe (same resilience pattern as the terminal socket).
 */
export class FsWatchSocket {
  private socket: WebSocket | null = null;
  private readonly watched = new Set<string>();
  private readonly listeners = new Set<(event: FsChangeEvent) => void>();
  private retryTimer: number | null = null;
  private disposed = false;

  constructor() {
    this.connect();
  }

  private connect(): void {
    if (this.disposed) {
      return;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws/fs`);
    this.socket = socket;
    socket.onopen = () => {
      for (const path of this.watched) {
        socket.send(JSON.stringify({ type: 'watch', path }));
      }
    };
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(String(message.data)) as FsChangeEvent;
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch {
            // one broken listener must not starve the others
          }
        }
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      this.socket = null;
      if (!this.disposed) {
        this.retryTimer = window.setTimeout(() => this.connect(), 1500);
      }
    };
  }

  watch(path: string): void {
    if (this.watched.has(path)) {
      return;
    }
    this.watched.add(path);
    this.send({ type: 'watch', path });
  }

  unwatch(path: string): void {
    if (!this.watched.delete(path)) {
      return;
    }
    this.send({ type: 'unwatch', path });
  }

  unwatchAll(): void {
    for (const path of [...this.watched]) {
      this.unwatch(path);
    }
  }

  onEvent(listener: (event: FsChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
    }
    this.socket?.close();
  }

  private send(payload: { type: 'watch' | 'unwatch'; path: string }): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
