/**
 * Pure Monaco-change -> LSP content-change conversion helpers.
 *
 * Scope: data-in/data-out only. No live Monaco model subscriptions, no LspConnection
 * calls - those stateful wirings are a later step. Keeping the coordinate math and the
 * change-ordering rule here makes the highest-correctness-risk logic unit-testable.
 *
 * LSP positions are 0-based (line/character); Monaco positions are 1-based (lineNumber/column).
 */

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
/** Incremental text-document change: a replaced range plus its new text. */
export interface LspIncrementalChange {
  range: LspRange;
  text: string;
}
/** Full-document change: replaces the whole document, no range. */
export interface LspFullContentChange {
  text: string;
}
export type LspContentChange = LspIncrementalChange | LspFullContentChange;

/** Minimal shape of a Monaco range (1-based line/column) needed for conversion. */
export interface MonacoRangeLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}
/** Minimal shape of one Monaco `IModelContentChange`. */
export interface MonacoChangeLike {
  range: MonacoRangeLike;
  text: string;
}

/** Convert a 1-based Monaco line/column to a 0-based LSP position. */
export function toLspPosition(lineNumber: number, column: number): LspPosition {
  return { line: lineNumber - 1, character: column - 1 };
}

/**
 * Convert Monaco `IModelContentChangedEvent.changes` to LSP incremental contentChanges.
 *
 * Monaco delivers the changes ordered from the END of the document to the BEGINNING, which is
 * exactly the order in which LSP applies a contentChanges array in sequence (each range relative
 * to the prior change's result). So we emit them VERBATIM - re-sorting ascending by position
 * would invalidate later ranges and corrupt the server's mirror.
 */
export function toIncrementalChanges(changes: ReadonlyArray<MonacoChangeLike>): LspIncrementalChange[] {
  return changes.map((change) => ({
    range: {
      start: toLspPosition(change.range.startLineNumber, change.range.startColumn),
      end: toLspPosition(change.range.endLineNumber, change.range.endColumn)
    },
    text: change.text
  }));
}

/**
 * Full-text sync fallback: used for the coalesced-flush path or servers that only support
 * `TextDocumentSyncKind.Full`. One change carrying the entire document text, no range.
 */
export function toFullContentChanges(text: string): LspFullContentChange[] {
  return [{ text }];
}

/** LSP didOpen params: full document state for a (re)opened document. */
export interface DidOpenParams {
  textDocument: { uri: string; languageId: string; version: number; text: string };
}
/** LSP didChange params: a versioned identifier plus the content changes. */
export interface DidChangeParams {
  textDocument: { uri: string; version: number };
  contentChanges: LspContentChange[];
}
/** LSP didClose params. */
export interface DidCloseParams {
  textDocument: { uri: string };
}
/** One Monaco edit batch: the incremental changes plus the resulting full text. */
export interface MonacoChangeEdit {
  changes: ReadonlyArray<MonacoChangeLike>;
  fullText: string;
}

interface TrackedDocument {
  languageId: string;
  version: number;
  text: string;
}

/**
 * Tracks open documents and their monotonic versions, producing LSP lifecycle
 * notification payloads (didOpen/didChange/didClose).
 *
 * Pure state machine: it stores the authoritative full text per document (cheap to
 * obtain from a Monaco model) so a late-joining server session gets a correct didOpen
 * snapshot without reconstructing text by replaying incremental edits. It does NOT
 * subscribe to Monaco events, call a connection, or fan out to multiple sessions -
 * those wirings are later steps.
 */
export class LspDocumentTracker {
  private readonly docs = new Map<string, TrackedDocument>();

  /** Begin tracking a document at version 1; returns its didOpen params. */
  open(uri: string, languageId: string, text: string): DidOpenParams {
    this.docs.set(uri, { languageId, version: 1, text });
    return { textDocument: { uri, languageId, version: 1, text } };
  }

  /** Record an edit: bump the version, store the new full text, return didChange params. */
  change(uri: string, edit: MonacoChangeEdit): DidChangeParams {
    const doc = this.require(uri);
    doc.version += 1;
    doc.text = edit.fullText;
    return {
      textDocument: { uri, version: doc.version },
      contentChanges: toIncrementalChanges(edit.changes)
    };
  }

  /** Stop tracking a document; returns its didClose params. */
  close(uri: string): DidCloseParams {
    this.require(uri);
    this.docs.delete(uri);
    return { textDocument: { uri } };
  }

  /**
   * didOpen params for a server session that joins after the document is already open.
   * Carries the CURRENT version and text so the new session is in sync immediately.
   */
  snapshotForNewServer(uri: string): DidOpenParams {
    const doc = this.require(uri);
    return { textDocument: { uri, languageId: doc.languageId, version: doc.version, text: doc.text } };
  }

  private require(uri: string): TrackedDocument {
    const doc = this.docs.get(uri);
    if (!doc) {
      throw new Error(`document not open: ${uri}`);
    }
    return doc;
  }
}

/** Minimal connection surface LspDocumentSync needs: the notify method only. */
export interface LspNotifySink {
  notify(method: string, params: unknown): void;
}

/**
 * Wires an LspDocumentTracker to a connection's notify(), emitting the LSP document
 * lifecycle notifications (didOpen/didChange/didClose) for each document operation.
 *
 * This is the integration seam between the tracker and the transport. It does NOT yet
 * subscribe to live Monaco model events or fan out to multiple server sessions - those
 * are later steps.
 */
export class LspDocumentSync {
  private readonly connection: LspNotifySink;
  private readonly tracker: LspDocumentTracker;

  constructor(connection: LspNotifySink, tracker: LspDocumentTracker = new LspDocumentTracker()) {
    this.connection = connection;
    this.tracker = tracker;
  }

  openDocument(uri: string, languageId: string, text: string): void {
    this.connection.notify('textDocument/didOpen', this.tracker.open(uri, languageId, text));
  }

  changeDocument(uri: string, edit: MonacoChangeEdit): void {
    this.connection.notify('textDocument/didChange', this.tracker.change(uri, edit));
  }

  closeDocument(uri: string): void {
    this.connection.notify('textDocument/didClose', this.tracker.close(uri));
  }
}
