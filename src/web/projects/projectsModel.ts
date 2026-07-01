import type { FieldValue, ProjectField, ProjectItem } from './projectsClient.js';

/**
 * Pure board logic: field-value lookup, filter parsing/matching (a practical
 * subset of GitHub's view filter syntax), grouping into board columns, and
 * sorting. Kept free of React/fetch so vitest covers it directly.
 */

/** Field value for an item by field id (fieldValues only carry set values). */
export function valueFor(item: ProjectItem, fieldId: string): FieldValue | undefined {
  return item.fieldValues.nodes.find((value) => value.field?.id === fieldId);
}

/** Human-readable string for any field value (used by table cells + filters). */
export function displayValue(value: FieldValue | undefined): string {
  if (!value) {
    return '';
  }
  if (value.text !== undefined) {
    return value.text;
  }
  if (value.number !== undefined) {
    return String(value.number);
  }
  if (value.date !== undefined) {
    return value.date;
  }
  if (value.name !== undefined) {
    return value.name;
  }
  if (value.title !== undefined) {
    return value.title;
  }
  if (value.labels) {
    return value.labels.nodes.map((label) => label.name).join(', ');
  }
  if (value.users) {
    return value.users.nodes.map((user) => user.login).join(', ');
  }
  if (value.milestone) {
    return value.milestone.title;
  }
  if (value.repository) {
    return value.repository.nameWithOwner;
  }
  return '';
}

/* ---------- filtering ---------- */

export interface FilterClause {
  key: string;
  value: string;
  negate: boolean;
}

export interface ItemFilter {
  text: string[];
  clauses: FilterClause[];
}

/**
 * Parse a GitHub-style filter string: free text plus `key:value` clauses
 * (`-key:value` negates; quoted values keep spaces: `status:"In Progress"`).
 */
export function parseFilter(input: string): ItemFilter {
  const text: string[] = [];
  const clauses: FilterClause[] = [];
  const tokens = input.match(/(?:[^\s"]+"[^"]*"?|"[^"]*"?|\S)+/g) ?? [];
  for (const token of tokens) {
    const match = /^(-?)([\w.-]+):(.*)$/.exec(token);
    if (match && match[3] !== undefined) {
      const raw = match[3];
      clauses.push({
        key: match[2]!.toLowerCase(),
        value: raw.replace(/^"|"$/g, '').toLowerCase(),
        negate: match[1] === '-'
      });
    } else if (token.trim() !== '') {
      text.push(token.replace(/^"|"$/g, '').toLowerCase());
    }
  }
  return { text, clauses };
}

function itemKind(item: ProjectItem): string {
  if (item.type === 'PULL_REQUEST') {
    return 'pr';
  }
  if (item.type === 'DRAFT_ISSUE') {
    return 'draft';
  }
  return 'issue';
}

function itemState(item: ProjectItem): string {
  const state = item.content?.state?.toLowerCase() ?? '';
  if (state === 'merged') {
    return 'merged';
  }
  return state === 'closed' ? 'closed' : 'open';
}

function matchClause(item: ProjectItem, clause: FilterClause, fields: ProjectField[]): boolean {
  const { key, value } = clause;
  if (key === 'is') {
    if (['issue', 'pr', 'draft'].includes(value)) {
      return itemKind(item) === value;
    }
    if (['open', 'closed', 'merged'].includes(value)) {
      return itemState(item) === value;
    }
    if (value === 'archived') {
      return item.isArchived;
    }
    return false;
  }
  if (key === 'assignee') {
    return (item.content?.assignees?.nodes ?? []).some((user) => user.login.toLowerCase() === value);
  }
  if (key === 'label') {
    return (item.content?.labels?.nodes ?? []).some((label) => label.name.toLowerCase() === value);
  }
  if (key === 'repo') {
    const repo = item.content?.repository?.nameWithOwner.toLowerCase() ?? '';
    return repo === value || repo.endsWith(`/${value}`);
  }
  if (key === 'no') {
    const field = fields.find((candidate) => candidate.name.toLowerCase() === value);
    return field ? valueFor(item, field.id) === undefined : false;
  }
  // any project field by name (status:done, iteration:"sprint 1", priority:p1…)
  const field = fields.find((candidate) => candidate.name.toLowerCase() === key);
  if (field) {
    return displayValue(valueFor(item, field.id)).toLowerCase() === value;
  }
  return false;
}

export function matchesFilter(item: ProjectItem, filter: ItemFilter, fields: ProjectField[]): boolean {
  for (const clause of filter.clauses) {
    if (matchClause(item, clause, fields) === clause.negate) {
      return false;
    }
  }
  if (filter.text.length > 0) {
    const haystack = [
      item.content?.title ?? '',
      item.content?.repository?.nameWithOwner ?? '',
      item.content?.number !== undefined ? `#${item.content.number}` : ''
    ]
      .join(' ')
      .toLowerCase();
    return filter.text.every((needle) => haystack.includes(needle));
  }
  return true;
}

/* ---------- grouping (board columns) ---------- */

export interface BoardColumn {
  key: string;
  label: string;
  /** github option color name (PINK, RED, …) or '' */
  color: string;
  /** value payload that moves an item into this column; null = clears */
  optionId: string | null;
  iterationId: string | null;
  items: ProjectItem[];
}

export function groupableFields(fields: ProjectField[]): ProjectField[] {
  return fields.filter((field) => field.dataType === 'SINGLE_SELECT' || field.dataType === 'ITERATION');
}

/** Group items into columns for a single-select or iteration field. */
export function groupItems(items: ProjectItem[], field: ProjectField): BoardColumn[] {
  const columns: BoardColumn[] = [];
  if (field.dataType === 'SINGLE_SELECT') {
    for (const option of field.options ?? []) {
      columns.push({ key: option.id, label: option.name, color: option.color, optionId: option.id, iterationId: null, items: [] });
    }
  } else if (field.dataType === 'ITERATION') {
    const iterations = [
      ...(field.configuration?.iterations ?? []),
      ...(field.configuration?.completedIterations ?? []).slice(0, 3)
    ];
    for (const iteration of iterations) {
      columns.push({
        key: iteration.id,
        label: iteration.title,
        color: '',
        optionId: null,
        iterationId: iteration.id,
        items: []
      });
    }
  }
  const noValue: BoardColumn = { key: '__none', label: `No ${field.name}`, color: '', optionId: null, iterationId: null, items: [] };
  const byKey = new Map(columns.map((column) => [column.key, column]));
  for (const item of items) {
    const value = valueFor(item, field.id);
    const key = value?.optionId ?? value?.iterationId;
    const column = key !== undefined ? byKey.get(key) : undefined;
    (column ?? noValue).items.push(item);
  }
  // "No value" leads, like GitHub's board.
  return [noValue, ...columns];
}

/* ---------- sorting ---------- */

export type SortDirection = 'asc' | 'desc';

export function sortItems(items: ProjectItem[], field: ProjectField | null, direction: SortDirection): ProjectItem[] {
  if (!field) {
    return items;
  }
  const sorted = [...items].sort((a, b) => {
    const va = valueFor(a, field.id);
    const vb = valueFor(b, field.id);
    // empty values sink to the bottom regardless of direction
    if (!va && !vb) {
      return 0;
    }
    if (!va) {
      return 1;
    }
    if (!vb) {
      return -1;
    }
    if (va.number !== undefined && vb.number !== undefined) {
      return direction === 'asc' ? va.number - vb.number : vb.number - va.number;
    }
    const result = displayValue(va).localeCompare(displayValue(vb), undefined, { numeric: true });
    return direction === 'asc' ? result : -result;
  });
  return sorted;
}

/* ---------- github option colors → desk-ish hues ---------- */

const OPTION_COLOR_HUES: Record<string, string> = {
  GRAY: 'var(--desk-text-dim)',
  BLUE: '#58a6ff',
  GREEN: 'var(--desk-ok)',
  YELLOW: '#ffd166',
  ORANGE: '#f0883e',
  RED: 'var(--desk-error)',
  PINK: '#f778ba',
  PURPLE: '#bc8cff'
};

export function optionColor(color: string): string {
  return OPTION_COLOR_HUES[color] ?? 'var(--desk-accent)';
}
