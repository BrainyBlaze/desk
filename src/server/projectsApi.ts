import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { readJsonBody, sendJson } from './httpUtil.js';

/**
 * /api/projects/* — GitHub Projects v2 via the gh CLI exclusively.
 *
 * Reads go through `gh api graphql` because the JSON from the `gh project`
 * porcelain drops the node/field/option IDs every mutation needs. Mutations
 * use GraphQL for project items (typed field values, position, drafts,
 * archive) and the gh issue/pr porcelain for content-side operations
 * (assignees, labels, close/reopen, comments).
 */

const GH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const ITEMS_PAGE = 100;
const MAX_ITEMS = 1000;

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run gh with optional stdin (no shell — args go straight to execve). */
function runGh(args: string[], input?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn('gh', args, {
      cwd: homedir(),
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, stdout, stderr: 'gh timed out' });
    }, GH_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr: err.message });
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout, stderr: stderr.trim() });
      }
    });
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

class GhError extends Error {
  constructor(message: string, readonly missingScope: boolean = false) {
    super(message);
  }
}

function isScopeError(text: string): boolean {
  return /missing required scopes|INSUFFICIENT_SCOPES|read:project/i.test(text);
}

/** Run a GraphQL document via `gh api graphql --input -`. Throws GhError. */
async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const result = await runGh(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables }));
  const text = result.stdout || result.stderr;
  if (!result.ok) {
    // gh prints GraphQL errors to stdout as JSON and transport errors to stderr.
    let message = result.stderr || 'gh api graphql failed';
    try {
      const parsed = JSON.parse(result.stdout) as { errors?: Array<{ message: string }> };
      if (parsed.errors?.length) {
        message = parsed.errors.map((e) => e.message).join('; ');
      }
    } catch {
      // keep stderr message
    }
    throw new GhError(message, isScopeError(text));
  }
  const parsed = JSON.parse(result.stdout) as { data: T; errors?: Array<{ message: string }> };
  if (parsed.errors?.length) {
    throw new GhError(parsed.errors.map((e) => e.message).join('; '), isScopeError(result.stdout));
  }
  return parsed.data;
}

/* ---------- read model ---------- */

const FIELD_FRAGMENT = `
  ... on ProjectV2FieldCommon { id name dataType }
  ... on ProjectV2SingleSelectField { options { id name color } }
  ... on ProjectV2IterationField {
    configuration {
      iterations { id title startDate duration }
      completedIterations { id title startDate duration }
    }
  }
`;

const FIELD_VALUE_FRAGMENT = `
  __typename
  ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id } } }
  ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id } } }
  ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id } } }
  ... on ProjectV2ItemFieldSingleSelectValue { optionId name color field { ... on ProjectV2FieldCommon { id } } }
  ... on ProjectV2ItemFieldIterationValue { iterationId title field { ... on ProjectV2FieldCommon { id } } }
  ... on ProjectV2ItemFieldLabelValue { labels(first: 12) { nodes { name color } } field { ... on ProjectV2FieldCommon { id } } }
  ... on ProjectV2ItemFieldUserValue { users(first: 6) { nodes { login } } field { ... on ProjectV2FieldCommon { id } } }
  ... on ProjectV2ItemFieldMilestoneValue { milestone { title } field { ... on ProjectV2FieldCommon { id } } }
  ... on ProjectV2ItemFieldRepositoryValue { repository { nameWithOwner } field { ... on ProjectV2FieldCommon { id } } }
`;

const CONTENT_FRAGMENT = `
  __typename
  ... on Issue {
    id number title state stateReason url
    repository { nameWithOwner }
    assignees(first: 6) { nodes { login } }
    labels(first: 12) { nodes { name color } }
    milestone { title }
  }
  ... on PullRequest {
    id number title state isDraft url
    repository { nameWithOwner }
    assignees(first: 6) { nodes { login } }
    labels(first: 12) { nodes { name color } }
  }
  ... on DraftIssue { id title }
`;

const PROJECT_LIST_QUERY = `
  query {
    viewer {
      login
      projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes { id number title closed public updatedAt shortDescription items(first: 0) { totalCount } owner { ... on User { login } ... on Organization { login } } }
      }
      organizations(first: 20) {
        nodes {
          login
          projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
            nodes { id number title closed public updatedAt shortDescription items(first: 0) { totalCount } owner { ... on User { login } ... on Organization { login } } }
          }
        }
      }
    }
  }
`;

const BOARD_QUERY = `
  query ($id: ID!, $cursor: String) {
    node(id: $id) {
      ... on ProjectV2 {
        id number title shortDescription readme public closed url
        owner { ... on User { login } ... on Organization { login } }
        fields(first: 50) { nodes { ${FIELD_FRAGMENT} } }
        views(first: 25) { nodes { id number name layout filter } }
        statusUpdates(first: 10) {
          nodes { id status body startDate targetDate createdAt creator { login } }
        }
        items(first: ${ITEMS_PAGE}, after: $cursor) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            id type isArchived updatedAt
            fieldValues(first: 30) { nodes { ${FIELD_VALUE_FRAGMENT} } }
            content { ${CONTENT_FRAGMENT} }
          }
        }
      }
    }
  }
`;

const ITEM_DETAIL_QUERY = `
  query ($id: ID!) {
    node(id: $id) {
      ... on ProjectV2Item {
        id
        content {
          __typename
          ... on Issue {
            id number title body url state
            repository { nameWithOwner }
            comments(last: 20) { nodes { author { login } body createdAt } }
          }
          ... on PullRequest {
            id number title body url state
            repository { nameWithOwner }
            comments(last: 20) { nodes { author { login } body createdAt } }
          }
          ... on DraftIssue { id title body }
        }
      }
    }
  }
`;

interface BoardPage {
  node: {
    items: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] };
  } & Record<string, unknown>;
}

async function readBoard(projectId: string): Promise<Record<string, unknown>> {
  let cursor: string | null = null;
  let project: (Record<string, unknown> & { items?: unknown }) | null = null;
  const items: unknown[] = [];
  let truncated = false;
  for (;;) {
    const data: BoardPage = await graphql<BoardPage>(BOARD_QUERY, { id: projectId, cursor });
    if (!data.node) {
      throw new GhError('project not found (or token lacks access)');
    }
    const page = data.node.items;
    if (!project) {
      project = data.node as Record<string, unknown> & { items?: unknown };
    }
    items.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) {
      break;
    }
    if (items.length >= MAX_ITEMS) {
      truncated = true;
      break;
    }
    cursor = page.pageInfo.endCursor;
  }
  return { ...project, items, truncated };
}

/* ---------- mutation documents ---------- */

const MUTATIONS = {
  setText: `mutation ($p: ID!, $i: ID!, $f: ID!, $v: String!) {
    updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { text: $v } }) { projectV2Item { id } } }`,
  setNumber: `mutation ($p: ID!, $i: ID!, $f: ID!, $v: Float!) {
    updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { number: $v } }) { projectV2Item { id } } }`,
  setDate: `mutation ($p: ID!, $i: ID!, $f: ID!, $v: Date!) {
    updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { date: $v } }) { projectV2Item { id } } }`,
  setOption: `mutation ($p: ID!, $i: ID!, $f: ID!, $v: String!) {
    updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $v } }) { projectV2Item { id } } }`,
  setIteration: `mutation ($p: ID!, $i: ID!, $f: ID!, $v: String!) {
    updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { iterationId: $v } }) { projectV2Item { id } } }`,
  clearValue: `mutation ($p: ID!, $i: ID!, $f: ID!) {
    clearProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f }) { projectV2Item { id } } }`,
  position: `mutation ($p: ID!, $i: ID!, $after: ID) {
    updateProjectV2ItemPosition(input: { projectId: $p, itemId: $i, afterId: $after }) { items(first: 0) { totalCount } } }`,
  addItem: `mutation ($p: ID!, $c: ID!) {
    addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }`,
  addDraft: `mutation ($p: ID!, $title: String!, $body: String) {
    addProjectV2DraftIssue(input: { projectId: $p, title: $title, body: $body }) { projectItem { id } } }`,
  editDraft: `mutation ($d: ID!, $title: String, $body: String) {
    updateProjectV2DraftIssue(input: { draftIssueId: $d, title: $title, body: $body }) { draftIssue { id } } }`,
  convertDraft: `mutation ($i: ID!, $r: ID!) {
    convertProjectV2DraftIssueItemToIssue(input: { itemId: $i, repositoryId: $r }) { item { id } } }`,
  archive: `mutation ($p: ID!, $i: ID!) {
    archiveProjectV2Item(input: { projectId: $p, itemId: $i }) { item { id } } }`,
  unarchive: `mutation ($p: ID!, $i: ID!) {
    unarchiveProjectV2Item(input: { projectId: $p, itemId: $i }) { item { id } } }`,
  deleteItem: `mutation ($p: ID!, $i: ID!) {
    deleteProjectV2Item(input: { projectId: $p, itemId: $i }) { deletedItemId } }`,
  createStatus: `mutation ($p: ID!, $body: String!, $status: ProjectV2StatusUpdateStatus, $start: Date, $target: Date) {
    createProjectV2StatusUpdate(input: { projectId: $p, body: $body, status: $status, startDate: $start, targetDate: $target }) { statusUpdate { id } } }`,
  deleteStatus: `mutation ($s: ID!) {
    deleteProjectV2StatusUpdate(input: { statusUpdateId: $s }) { projectV2 { id } } }`,
  createProject: `mutation ($o: ID!, $title: String!) {
    createProjectV2(input: { ownerId: $o, title: $title }) { projectV2 { id number title } } }`,
  updateProject: `mutation ($p: ID!, $title: String, $desc: String, $closed: Boolean, $public: Boolean) {
    updateProjectV2(input: { projectId: $p, title: $title, shortDescription: $desc, closed: $closed, public: $public }) { projectV2 { id } } }`,
  linkRepo: `mutation ($p: ID!, $r: ID!) {
    linkProjectV2ToRepository(input: { projectId: $p, repositoryId: $r }) { repository { id } } }`
} as const;

const RESOLVE_URL_QUERY = `
  query ($url: URI!) {
    resource(url: $url) { ... on Issue { id } ... on PullRequest { id } }
  }
`;

/* ---------- validation ---------- */

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** GraphQL node ids are base64-ish tokens — never shell metacharacters. */
function requireNodeId(value: unknown, name: string): string {
  const id = requireString(value, name);
  if (!/^[A-Za-z0-9_=-]+$/.test(id)) {
    throw new Error(`${name} is not a valid node id`);
  }
  return id;
}

function requireRepo(value: unknown): string {
  const repo = requireString(value, 'repo');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('repo must be owner/name');
  }
  return repo;
}

function requireIssueNumber(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('number must be a positive integer');
  }
  return String(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : [];
}

function ghErrorPayload(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof GhError && error.missingScope) {
    return { status: 403, body: { error: error.message, missingScope: true } };
  }
  return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
}

/* ---------- request handling ---------- */

export async function handleProjectsRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/projects/')) {
    return false;
  }
  try {
    if (req.method === 'GET') {
      if (url.pathname === '/api/projects/auth') {
        const status = await runGh(['auth', 'status']);
        const login = /account (\S+)/.exec(status.stdout + status.stderr)?.[1] ?? null;
        if (!status.ok) {
          sendJson(res, 200, { ok: false, login, reason: 'not logged in to gh' });
          return true;
        }
        try {
          await graphql('query { viewer { projectsV2(first: 1) { totalCount } } }');
          sendJson(res, 200, { ok: true, login });
        } catch (err) {
          const scope = err instanceof GhError && err.missingScope;
          sendJson(res, 200, {
            ok: false,
            login,
            missingScope: scope,
            reason: err instanceof Error ? err.message : String(err)
          });
        }
        return true;
      }

      if (url.pathname === '/api/projects/list') {
        interface ListData {
          viewer: {
            login: string;
            projectsV2: { nodes: Array<Record<string, unknown>> };
            organizations: { nodes: Array<{ login: string; projectsV2: { nodes: Array<Record<string, unknown>> } }> };
          };
        }
        const data = await graphql<ListData>(PROJECT_LIST_QUERY);
        const seen = new Set<string>();
        const projects: Array<Record<string, unknown>> = [];
        const push = (node: Record<string, unknown>): void => {
          const id = node.id as string;
          if (!seen.has(id)) {
            seen.add(id);
            projects.push(node);
          }
        };
        for (const node of data.viewer.projectsV2.nodes) {
          push(node);
        }
        for (const org of data.viewer.organizations.nodes) {
          for (const node of org.projectsV2.nodes) {
            push(node);
          }
        }
        sendJson(res, 200, { login: data.viewer.login, projects });
        return true;
      }

      if (url.pathname === '/api/projects/board') {
        const id = requireNodeId(url.searchParams.get('id'), 'id');
        sendJson(res, 200, await readBoard(id));
        return true;
      }

      if (url.pathname === '/api/projects/item') {
        const id = requireNodeId(url.searchParams.get('id'), 'id');
        const data = await graphql<{ node: unknown }>(ITEM_DETAIL_QUERY, { id });
        sendJson(res, 200, { item: data.node });
        return true;
      }

      if (url.pathname === '/api/projects/owners') {
        const data = await graphql<{
          viewer: { id: string; login: string; organizations: { nodes: Array<{ id: string; login: string }> } };
        }>('query { viewer { id login organizations(first: 20) { nodes { id login } } } }');
        sendJson(res, 200, {
          owners: [
            { id: data.viewer.id, login: data.viewer.login, kind: 'user' },
            ...data.viewer.organizations.nodes.map((org) => ({ ...org, kind: 'org' }))
          ]
        });
        return true;
      }
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);

      if (url.pathname === '/api/projects/field-value') {
        const projectId = requireNodeId(body.projectId, 'projectId');
        const itemId = requireNodeId(body.itemId, 'itemId');
        const fieldId = requireNodeId(body.fieldId, 'fieldId');
        if (body.clear === true) {
          await graphql(MUTATIONS.clearValue, { p: projectId, i: itemId, f: fieldId });
        } else if (typeof body.text === 'string') {
          await graphql(MUTATIONS.setText, { p: projectId, i: itemId, f: fieldId, v: body.text });
        } else if (typeof body.number === 'number') {
          await graphql(MUTATIONS.setNumber, { p: projectId, i: itemId, f: fieldId, v: body.number });
        } else if (typeof body.date === 'string') {
          await graphql(MUTATIONS.setDate, { p: projectId, i: itemId, f: fieldId, v: body.date });
        } else if (typeof body.optionId === 'string') {
          await graphql(MUTATIONS.setOption, { p: projectId, i: itemId, f: fieldId, v: requireNodeId(body.optionId, 'optionId') });
        } else if (typeof body.iterationId === 'string') {
          await graphql(MUTATIONS.setIteration, { p: projectId, i: itemId, f: fieldId, v: requireNodeId(body.iterationId, 'iterationId') });
        } else {
          throw new Error('one of clear/text/number/date/optionId/iterationId is required');
        }
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (url.pathname === '/api/projects/position') {
        await graphql(MUTATIONS.position, {
          p: requireNodeId(body.projectId, 'projectId'),
          i: requireNodeId(body.itemId, 'itemId'),
          after: body.afterId === null || body.afterId === undefined ? null : requireNodeId(body.afterId, 'afterId')
        });
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (url.pathname === '/api/projects/item-add') {
        const projectId = requireNodeId(body.projectId, 'projectId');
        const itemUrl = requireString(body.url, 'url');
        if (!/^https:\/\/github\.com\//.test(itemUrl)) {
          throw new Error('url must be a github.com issue or pull request URL');
        }
        const resolved = await graphql<{ resource: { id?: string } | null }>(RESOLVE_URL_QUERY, { url: itemUrl });
        if (!resolved.resource?.id) {
          throw new Error('URL does not resolve to an issue or pull request');
        }
        await graphql(MUTATIONS.addItem, { p: projectId, c: resolved.resource.id });
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (url.pathname === '/api/projects/draft-create') {
        const data = await graphql<{ addProjectV2DraftIssue: { projectItem: { id: string } } }>(MUTATIONS.addDraft, {
          p: requireNodeId(body.projectId, 'projectId'),
          title: requireString(body.title, 'title'),
          body: optionalString(body.body) ?? ''
        });
        sendJson(res, 200, { ok: true, itemId: data.addProjectV2DraftIssue.projectItem.id });
        return true;
      }

      if (url.pathname === '/api/projects/draft-edit') {
        await graphql(MUTATIONS.editDraft, {
          d: requireNodeId(body.draftId, 'draftId'),
          title: optionalString(body.title) ?? null,
          body: typeof body.body === 'string' ? body.body : null
        });
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (url.pathname === '/api/projects/draft-convert') {
        const repo = requireRepo(body.repo);
        const repoData = await runGh(['api', `repos/${repo}`, '--jq', '.node_id']);
        if (!repoData.ok) {
          throw new Error(repoData.stderr || `cannot resolve repository ${repo}`);
        }
        await graphql(MUTATIONS.convertDraft, {
          i: requireNodeId(body.itemId, 'itemId'),
          r: repoData.stdout.trim()
        });
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (url.pathname === '/api/projects/item-archive') {
        const mutation = body.unarchive === true ? MUTATIONS.unarchive : MUTATIONS.archive;
        await graphql(mutation, { p: requireNodeId(body.projectId, 'projectId'), i: requireNodeId(body.itemId, 'itemId') });
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (url.pathname === '/api/projects/item-delete') {
        await graphql(MUTATIONS.deleteItem, {
          p: requireNodeId(body.projectId, 'projectId'),
          i: requireNodeId(body.itemId, 'itemId')
        });
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (url.pathname === '/api/projects/issue-edit') {
        const repo = requireRepo(body.repo);
        const number = requireIssueNumber(body.number);
        const kind = body.kind === 'pr' ? 'pr' : 'issue';
        const state = optionalString(body.state);
        if (state) {
          if (!['close', 'reopen'].includes(state)) {
            throw new Error('state must be close or reopen');
          }
          const result = await runGh([kind, state, number, '-R', repo]);
          if (!result.ok) {
            throw new Error(result.stderr || `gh ${kind} ${state} failed`);
          }
          sendJson(res, 200, { ok: true });
          return true;
        }
        const args = [kind, 'edit', number, '-R', repo];
        for (const login of stringArray(body.addAssignees)) {
          args.push('--add-assignee', login);
        }
        for (const login of stringArray(body.removeAssignees)) {
          args.push('--remove-assignee', login);
        }
        for (const label of stringArray(body.addLabels)) {
          args.push('--add-label', label);
        }
        for (const label of stringArray(body.removeLabels)) {
          args.push('--remove-label', label);
        }
        if (args.length === 5) {
          throw new Error('nothing to edit');
        }
        const result = await runGh(args);
        if (!result.ok) {
          throw new Error(result.stderr || 'gh edit failed');
        }
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (url.pathname === '/api/projects/comment') {
        const repo = requireRepo(body.repo);
        const number = requireIssueNumber(body.number);
        const kind = body.kind === 'pr' ? 'pr' : 'issue';
        const result = await runGh([kind, 'comment', number, '-R', repo, '--body', requireString(body.body, 'body')]);
        if (!result.ok) {
          throw new Error(result.stderr || 'gh comment failed');
        }
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (url.pathname === '/api/projects/status-update') {
        if (body.delete === true) {
          await graphql(MUTATIONS.deleteStatus, { s: requireNodeId(body.statusUpdateId, 'statusUpdateId') });
          sendJson(res, 200, { ok: true });
          return true;
        }
        const status = optionalString(body.status);
        if (status && !['INACTIVE', 'ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'COMPLETE'].includes(status)) {
          throw new Error('invalid status');
        }
        await graphql(MUTATIONS.createStatus, {
          p: requireNodeId(body.projectId, 'projectId'),
          body: requireString(body.body, 'body'),
          status: status ?? null,
          start: optionalString(body.startDate) ?? null,
          target: optionalString(body.targetDate) ?? null
        });
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (url.pathname === '/api/projects/project-create') {
        const data = await graphql<{ createProjectV2: { projectV2: { id: string; number: number } } }>(
          MUTATIONS.createProject,
          { o: requireNodeId(body.ownerId, 'ownerId'), title: requireString(body.title, 'title') }
        );
        sendJson(res, 200, { ok: true, project: data.createProjectV2.projectV2 });
        return true;
      }

      if (url.pathname === '/api/projects/project-edit') {
        await graphql(MUTATIONS.updateProject, {
          p: requireNodeId(body.projectId, 'projectId'),
          title: optionalString(body.title) ?? null,
          desc: typeof body.shortDescription === 'string' ? body.shortDescription : null,
          closed: typeof body.closed === 'boolean' ? body.closed : null,
          public: typeof body.public === 'boolean' ? body.public : null
        });
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (url.pathname === '/api/projects/project-link') {
        const repo = requireRepo(body.repo);
        const repoData = await runGh(['api', `repos/${repo}`, '--jq', '.node_id']);
        if (!repoData.ok) {
          throw new Error(repoData.stderr || `cannot resolve repository ${repo}`);
        }
        await graphql(MUTATIONS.linkRepo, { p: requireNodeId(body.projectId, 'projectId'), r: repoData.stdout.trim() });
        sendJson(res, 200, { ok: true });
        return true;
      }
    }

    sendJson(res, 404, { error: `unknown projects route ${url.pathname}` });
    return true;
  } catch (error) {
    const payload = ghErrorPayload(error);
    sendJson(res, payload.status, payload.body);
    return true;
  }
}
