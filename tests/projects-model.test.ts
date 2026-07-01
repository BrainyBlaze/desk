import { describe, expect, it } from 'vitest';
import {
  displayValue,
  groupItems,
  matchesFilter,
  parseFilter,
  sortItems,
  valueFor
} from '../src/web/projects/projectsModel';
import type { ProjectField, ProjectItem } from '../src/web/projects/projectsClient';

const statusField: ProjectField = {
  id: 'F_status',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'opt_todo', name: 'Todo', color: 'GREEN' },
    { id: 'opt_doing', name: 'In Progress', color: 'YELLOW' },
    { id: 'opt_done', name: 'Done', color: 'PURPLE' }
  ]
};

const pointsField: ProjectField = { id: 'F_points', name: 'Points', dataType: 'NUMBER' };

function makeItem(
  id: string,
  overrides: Partial<ProjectItem> & { status?: string; points?: number; title?: string } = {}
): ProjectItem {
  const fieldValues = [];
  if (overrides.status) {
    const option = statusField.options!.find((candidate) => candidate.name === overrides.status)!;
    fieldValues.push({ __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { id: 'F_status' }, optionId: option.id, name: option.name });
  }
  if (overrides.points !== undefined) {
    fieldValues.push({ __typename: 'ProjectV2ItemFieldNumberValue', field: { id: 'F_points' }, number: overrides.points });
  }
  return {
    id,
    type: overrides.type ?? 'ISSUE',
    isArchived: overrides.isArchived ?? false,
    updatedAt: '2026-06-11T00:00:00Z',
    fieldValues: { nodes: fieldValues },
    content: overrides.content ?? {
      __typename: 'Issue',
      id: `c_${id}`,
      title: overrides.title ?? `Item ${id}`,
      number: 1,
      state: 'OPEN',
      repository: { nameWithOwner: 'acme/web' },
      assignees: { nodes: [{ login: 'ada' }] },
      labels: { nodes: [{ name: 'bug', color: 'ff0000' }] }
    }
  };
}

describe('parseFilter', () => {
  it('splits free text and key:value clauses with negation and quotes', () => {
    const filter = parseFilter('login bug -label:wontfix status:"In Progress" is:issue');
    expect(filter.text).toEqual(['login', 'bug']);
    expect(filter.clauses).toEqual([
      { key: 'label', value: 'wontfix', negate: true },
      { key: 'status', value: 'in progress', negate: false },
      { key: 'is', value: 'issue', negate: false }
    ]);
  });
});

describe('matchesFilter', () => {
  const fields = [statusField, pointsField];

  it('matches project fields by name, assignee, label, repo, and is:', () => {
    const item = makeItem('1', { status: 'In Progress' });
    expect(matchesFilter(item, parseFilter('status:"in progress"'), fields)).toBe(true);
    expect(matchesFilter(item, parseFilter('status:done'), fields)).toBe(false);
    expect(matchesFilter(item, parseFilter('assignee:ada label:bug repo:web is:issue is:open'), fields)).toBe(true);
    expect(matchesFilter(item, parseFilter('-label:bug'), fields)).toBe(false);
    expect(matchesFilter(item, parseFilter('no:points'), fields)).toBe(true);
  });

  it('free text searches title, repo, and number', () => {
    const item = makeItem('1', { title: 'Fix login redirect' });
    expect(matchesFilter(item, parseFilter('login'), [])).toBe(true);
    expect(matchesFilter(item, parseFilter('acme'), [])).toBe(true);
    expect(matchesFilter(item, parseFilter('#1'), [])).toBe(true);
    expect(matchesFilter(item, parseFilter('checkout'), [])).toBe(false);
  });
});

describe('groupItems', () => {
  it('buckets items into option columns with a leading no-value column', () => {
    const items = [
      makeItem('1', { status: 'Todo' }),
      makeItem('2', { status: 'In Progress' }),
      makeItem('3', { status: 'Todo' }),
      makeItem('4')
    ];
    const columns = groupItems(items, statusField);
    expect(columns.map((column) => column.label)).toEqual(['No Status', 'Todo', 'In Progress', 'Done']);
    expect(columns[0]!.items.map((item) => item.id)).toEqual(['4']);
    expect(columns[1]!.items.map((item) => item.id)).toEqual(['1', '3']);
    expect(columns[1]!.optionId).toBe('opt_todo');
    expect(columns[3]!.items).toEqual([]);
  });
});

describe('sortItems', () => {
  it('sorts numbers numerically and sinks empty values', () => {
    const items = [makeItem('a', { points: 5 }), makeItem('b'), makeItem('c', { points: 1 })];
    expect(sortItems(items, pointsField, 'asc').map((item) => item.id)).toEqual(['c', 'a', 'b']);
    expect(sortItems(items, pointsField, 'desc').map((item) => item.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('valueFor / displayValue', () => {
  it('finds values by field id and formats every value shape', () => {
    const item = makeItem('1', { status: 'Done', points: 3 });
    expect(displayValue(valueFor(item, 'F_status'))).toBe('Done');
    expect(displayValue(valueFor(item, 'F_points'))).toBe('3');
    expect(displayValue(valueFor(item, 'F_missing'))).toBe('');
    expect(displayValue({ __typename: 'x', labels: { nodes: [{ name: 'a', color: '' }, { name: 'b', color: '' }] } })).toBe('a, b');
    expect(displayValue({ __typename: 'x', users: { nodes: [{ login: 'ada' }] } })).toBe('ada');
  });
});
