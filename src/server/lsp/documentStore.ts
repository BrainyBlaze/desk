import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type LspDocumentState = 'editor-open' | 'disk-cached' | 'closed';

export interface LspDocumentKey {
  workspaceRoot: string;
  uri: string;
}

export interface LspDocumentContent {
  workspaceRoot: string;
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface LspDocumentSnapshot {
  workspaceRoot: string;
  uri: string;
  state: LspDocumentState;
  languageId?: string;
  version?: number;
  text?: string;
}

export class LspDocumentStore {
  private readonly snapshots = new Map<string, LspDocumentSnapshot>();

  openEditorDocument(document: LspDocumentContent): LspDocumentSnapshot {
    const canonical = canonicalize(document.workspaceRoot, document.uri);
    const snapshot: LspDocumentSnapshot = {
      workspaceRoot: canonical.workspaceRoot,
      uri: canonical.uri,
      state: 'editor-open',
      languageId: document.languageId,
      version: document.version,
      text: document.text
    };
    this.snapshots.set(canonical.key, snapshot);
    return snapshot;
  }

  cacheDiskDocument(document: LspDocumentContent): LspDocumentSnapshot {
    const canonical = canonicalize(document.workspaceRoot, document.uri);
    const existing = this.snapshots.get(canonical.key);
    if (existing?.state === 'editor-open') {
      return existing;
    }

    const snapshot: LspDocumentSnapshot = {
      workspaceRoot: canonical.workspaceRoot,
      uri: canonical.uri,
      state: 'disk-cached',
      languageId: document.languageId,
      version: document.version,
      text: document.text
    };
    this.snapshots.set(canonical.key, snapshot);
    return snapshot;
  }

  closeDocument(document: LspDocumentKey): LspDocumentSnapshot {
    const canonical = canonicalize(document.workspaceRoot, document.uri);
    const snapshot: LspDocumentSnapshot = {
      workspaceRoot: canonical.workspaceRoot,
      uri: canonical.uri,
      state: 'closed'
    };
    this.snapshots.set(canonical.key, snapshot);
    return snapshot;
  }

  getSnapshot(document: LspDocumentKey): LspDocumentSnapshot | undefined {
    const canonical = canonicalize(document.workspaceRoot, document.uri);
    return this.snapshots.get(canonical.key);
  }
}

interface CanonicalDocumentKey {
  workspaceRoot: string;
  uri: string;
  key: string;
}

function canonicalize(workspaceRoot: string, uri: string): CanonicalDocumentKey {
  const canonicalWorkspaceRoot = canonicalPath(workspaceRoot);
  const filePath = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
  const canonicalFilePath = isAbsolute(filePath) ? resolve(filePath) : resolve(canonicalWorkspaceRoot, filePath);
  const canonicalUri = pathToFileURL(canonicalFilePath).href;
  return {
    workspaceRoot: canonicalWorkspaceRoot,
    uri: canonicalUri,
    key: `${canonicalWorkspaceRoot}\u0000${canonicalUri}`
  };
}

function canonicalPath(pathOrUri: string): string {
  const filePath = pathOrUri.startsWith('file://') ? fileURLToPath(pathOrUri) : pathOrUri;
  return resolve(filePath);
}
