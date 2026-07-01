/**
 * Sidebar drag-to-reorder for projects / groups / sessions. Uses a dedicated
 * dataTransfer MIME so it never collides with the existing session-move drag
 * (application/x-desk-session, dragged from a mux cell). Pure helpers here are
 * unit-tested; the React wiring lives in the sidebar.
 */
export const REORDER_MIME = 'application/x-desk-reorder';

export type ReorderKind = 'project' | 'group' | 'session';

export interface ReorderPayload {
  kind: ReorderKind;
  /** project id (all kinds) */
  projectId: string;
  /** group id (group + session kinds) */
  groupId?: string;
  /** the dragged item's id: project id / group id / session name */
  id: string;
}

export interface ReorderDataTransfer {
  setData(type: string, data: string): void;
  getData(type: string): string;
}

export function setReorderData(dataTransfer: ReorderDataTransfer, payload: ReorderPayload): void {
  dataTransfer.setData(REORDER_MIME, JSON.stringify(payload));
}

export function getReorderData(dataTransfer: ReorderDataTransfer | null | undefined): ReorderPayload | null {
  if (!dataTransfer) {
    return null;
  }
  const raw = dataTransfer.getData(REORDER_MIME);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as ReorderPayload;
    if (parsed && (parsed.kind === 'project' || parsed.kind === 'group' || parsed.kind === 'session') && typeof parsed.id === 'string') {
      return parsed;
    }
  } catch {
    // malformed payload — treat as no reorder
  }
  return null;
}

/**
 * Move `draggedId` to sit just before `targetId` in the id list, returning the
 * new ordering. A no-op (returns the same order) when the drag and target are
 * the same or either id is missing — the caller can skip persisting.
 */
export function computeReorder(ids: string[], draggedId: string, targetId: string): string[] {
  if (draggedId === targetId) {
    return ids;
  }
  const from = ids.indexOf(draggedId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0) {
    return ids;
  }
  const next = [...ids];
  next.splice(from, 1);
  // After removal the target may have shifted left by one; recompute its index.
  const insertAt = next.indexOf(targetId);
  next.splice(insertAt, 0, draggedId);
  return next;
}
