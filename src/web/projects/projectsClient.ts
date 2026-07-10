/** Client for /api/projects/* — types mirror the server's GraphQL read model. */

import { readJson as readJsonBase } from '../httpJson.js';

export interface ProjectSummary {
  id: string;
  number: number;
  title: string;
  closed: boolean;
  public: boolean;
  updatedAt: string;
  shortDescription: string | null;
  items: { totalCount: number };
  owner: { login: string };
}

export interface ProjectFieldOption {
  id: string;
  name: string;
  color: string;
}

export interface ProjectIteration {
  id: string;
  title: string;
  startDate: string;
  duration: number;
}

export interface ProjectField {
  id: string;
  name: string;
  dataType: string;
  options?: ProjectFieldOption[];
  configuration?: { iterations: ProjectIteration[]; completedIterations: ProjectIteration[] };
}

export interface ProjectView {
  id: string;
  number: number;
  name: string;
  layout: string;
  filter: string | null;
}

export interface ProjectStatusUpdate {
  id: string;
  status: 'INACTIVE' | 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | 'COMPLETE';
  body: string;
  startDate: string | null;
  targetDate: string | null;
  createdAt: string;
  creator: { login: string } | null;
}

export interface LabelChip {
  name: string;
  color: string;
}

export interface FieldValue {
  __typename: string;
  field?: { id: string };
  text?: string;
  number?: number;
  date?: string;
  optionId?: string;
  iterationId?: string;
  /** display name for option/iteration values */
  name?: string;
  title?: string;
  color?: string;
  labels?: { nodes: LabelChip[] };
  users?: { nodes: Array<{ login: string }> };
  milestone?: { title: string } | null;
  repository?: { nameWithOwner: string } | null;
}

export interface ItemContent {
  __typename: 'Issue' | 'PullRequest' | 'DraftIssue';
  id: string;
  title: string;
  number?: number;
  state?: string;
  stateReason?: string | null;
  isDraft?: boolean;
  url?: string;
  repository?: { nameWithOwner: string };
  assignees?: { nodes: Array<{ login: string }> };
  labels?: { nodes: LabelChip[] };
  milestone?: { title: string } | null;
}

export interface ProjectItem {
  id: string;
  type: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE' | 'REDACTED';
  isArchived: boolean;
  updatedAt: string;
  fieldValues: { nodes: FieldValue[] };
  content: ItemContent | null;
}

export interface ProjectBoard {
  id: string;
  number: number;
  title: string;
  shortDescription: string | null;
  readme: string | null;
  public: boolean;
  closed: boolean;
  url: string;
  owner: { login: string };
  fields: { nodes: ProjectField[] };
  views: { nodes: ProjectView[] };
  statusUpdates: { nodes: ProjectStatusUpdate[] };
  items: ProjectItem[];
  truncated: boolean;
}

export interface ProjectsAuth {
  ok: boolean;
  login: string | null;
  missingScope?: boolean;
  reason?: string;
}

export interface ItemComment {
  author: { login: string } | null;
  body: string;
  createdAt: string;
}

export interface ItemDetail {
  id: string;
  content: {
    __typename: string;
    id: string;
    title: string;
    body: string;
    url?: string;
    state?: string;
    repository?: { nameWithOwner: string };
    comments?: { nodes: ItemComment[] };
  } | null;
}

export interface ProjectOwner {
  id: string;
  login: string;
  kind: 'user' | 'org';
}

export class MissingScopeError extends Error {}

async function readJson<T>(request: Promise<Response>): Promise<T> {
  return readJsonBase<T>(request, ({ body }) =>
    body?.missingScope
      ? new MissingScopeError(typeof body.error === 'string' ? body.error : 'missing project scope')
      : undefined
  );
}

const enc = encodeURIComponent;

export const projectsAuth = (): Promise<ProjectsAuth> => readJson(fetch('/api/projects/auth'));

export const projectsList = (): Promise<{ login: string; projects: ProjectSummary[] }> =>
  readJson(fetch('/api/projects/list'));

export const projectsBoard = (id: string): Promise<ProjectBoard> =>
  readJson(fetch(`/api/projects/board?id=${enc(id)}`));

export const projectsItemDetail = (id: string): Promise<{ item: ItemDetail }> =>
  readJson(fetch(`/api/projects/item?id=${enc(id)}`));

export const projectsOwners = (): Promise<{ owners: ProjectOwner[] }> => readJson(fetch('/api/projects/owners'));

function post<T = { ok: true }>(pathname: string, payload: Record<string, unknown>): Promise<T> {
  return readJson(
    fetch(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
}

export type FieldValuePayload =
  | { clear: true }
  | { text: string }
  | { number: number }
  | { date: string }
  | { optionId: string }
  | { iterationId: string };

export const setFieldValue = (projectId: string, itemId: string, fieldId: string, value: FieldValuePayload): Promise<{ ok: true }> =>
  post('/api/projects/field-value', { projectId, itemId, fieldId, ...value });

export const moveItemPosition = (projectId: string, itemId: string, afterId: string | null): Promise<{ ok: true }> =>
  post('/api/projects/position', { projectId, itemId, afterId });

export const addItemByUrl = (projectId: string, url: string): Promise<{ ok: true }> =>
  post('/api/projects/item-add', { projectId, url });

export const createDraft = (projectId: string, title: string, body?: string): Promise<{ ok: true; itemId: string }> =>
  post('/api/projects/draft-create', { projectId, title, body });

export const editDraft = (draftId: string, title?: string, body?: string): Promise<{ ok: true }> =>
  post('/api/projects/draft-edit', { draftId, title, body });

export const convertDraft = (itemId: string, repo: string): Promise<{ ok: true }> =>
  post('/api/projects/draft-convert', { itemId, repo });

export const archiveItem = (projectId: string, itemId: string, unarchive = false): Promise<{ ok: true }> =>
  post('/api/projects/item-archive', { projectId, itemId, unarchive });

export const deleteItem = (projectId: string, itemId: string): Promise<{ ok: true }> =>
  post('/api/projects/item-delete', { projectId, itemId });

export const editIssue = (
  repo: string,
  number: number,
  kind: 'issue' | 'pr',
  edits: {
    state?: 'close' | 'reopen';
    addAssignees?: string[];
    removeAssignees?: string[];
    addLabels?: string[];
    removeLabels?: string[];
  }
): Promise<{ ok: true }> => post('/api/projects/issue-edit', { repo, number, kind, ...edits });

export const commentOnItem = (repo: string, number: number, kind: 'issue' | 'pr', body: string): Promise<{ ok: true }> =>
  post('/api/projects/comment', { repo, number, kind, body });

export const postStatusUpdate = (
  projectId: string,
  body: string,
  status?: ProjectStatusUpdate['status'],
  startDate?: string,
  targetDate?: string
): Promise<{ ok: true }> => post('/api/projects/status-update', { projectId, body, status, startDate, targetDate });

export const deleteStatusUpdate = (statusUpdateId: string): Promise<{ ok: true }> =>
  post('/api/projects/status-update', { delete: true, statusUpdateId });

export const createProject = (ownerId: string, title: string): Promise<{ ok: true; project: { id: string; number: number } }> =>
  post('/api/projects/project-create', { ownerId, title });

export const editProjectMeta = (
  projectId: string,
  edits: { title?: string; shortDescription?: string; closed?: boolean; public?: boolean }
): Promise<{ ok: true }> => post('/api/projects/project-edit', { projectId, ...edits });

export const linkProjectRepo = (projectId: string, repo: string): Promise<{ ok: true }> =>
  post('/api/projects/project-link', { projectId, repo });
