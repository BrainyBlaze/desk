import { useState, type MouseEvent } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { DeskBleepName } from '../arwes/bleeps.js';
import type { FieldValuePayload, ProjectField, ProjectItem } from './projectsClient.js';
import { displayValue, valueFor, type SortDirection } from './projectsModel.js';
import { FieldEditor } from './FieldEditor.js';
import { itemIcon } from './BoardView.js';

const EDITABLE = new Set(['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'ITERATION']);
/** issue-side fields rendered from content, not editable inline */
const HIDDEN = new Set(['TITLE', 'LINKED_PULL_REQUESTS', 'REVIEWERS', 'TRACKS', 'TRACKED_BY', 'PARENT_ISSUE', 'SUB_ISSUES_PROGRESS']);

export interface TableViewProps {
  items: ProjectItem[];
  fields: ProjectField[];
  sortField: ProjectField | null;
  sortDirection: SortDirection;
  activeItemId: string | null;
  onSort: (field: ProjectField) => void;
  onSelectItem: (item: ProjectItem) => void;
  onItemMenu: (event: MouseEvent, item: ProjectItem) => void;
  onSetField: (item: ProjectItem, field: ProjectField, value: FieldValuePayload) => void;
}

export function TableView({
  items,
  fields,
  sortField,
  sortDirection,
  activeItemId,
  onSort,
  onSelectItem,
  onItemMenu,
  onSetField
}: TableViewProps): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [editing, setEditing] = useState<{ itemId: string; fieldId: string } | null>(null);
  const columns = fields.filter((field) => !HIDDEN.has(field.dataType));

  return (
    <div className="projTableWrap">
      <table className="projTable">
        <thead>
          <tr>
            <th className="projTableTitleCol">Item</th>
            {columns.map((field) => (
              <th key={field.id}>
                <button
                  type="button"
                  className="projTableSort"
                  onMouseEnter={() => bleeps.hover?.play()}
                  onClick={() => {
                    bleeps.click?.play();
                    onSort(field);
                  }}
                >
                  <span>{field.name}</span>
                  {sortField?.id === field.id ? (sortDirection === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />) : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <Animator combine manager="stagger" duration={{ stagger: 0.012, limit: 20 }}>
            {items.map((item) => (
              <Animator key={item.id}>
                <Animated
                  as="tr"
                  className={`projTableRow ${item.id === activeItemId ? 'selected' : ''}`}
                  animated={['fade']}
                  onContextMenu={(event: MouseEvent) => onItemMenu(event, item)}
                >
                  <td className="projTableTitleCol">
                    <button
                      type="button"
                      className="projTableTitle"
                      title={item.content?.title}
                      onMouseEnter={() => bleeps.hover?.play()}
                      onClick={() => {
                        bleeps.click?.play();
                        onSelectItem(item);
                      }}
                    >
                      {itemIcon(item)}
                      <span>{item.content?.title ?? '(untitled)'}</span>
                      <small>
                        {item.content?.repository
                          ? `${item.content.repository.nameWithOwner.split('/')[1]}#${item.content.number}`
                          : 'draft'}
                      </small>
                    </button>
                  </td>
                  {columns.map((field) => {
                    const value = displayValue(valueFor(item, field.id));
                    const editable = EDITABLE.has(field.dataType);
                    const isEditing = editing?.itemId === item.id && editing.fieldId === field.id;
                    return (
                      <td key={field.id} className={editable ? 'projCellEditable' : ''}>
                        {isEditing ? (
                          <FieldEditor
                            field={field}
                            current={value}
                            onApply={(payload) => {
                              setEditing(null);
                              onSetField(item, field, payload);
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="projCellValue"
                            disabled={!editable}
                            onMouseEnter={() => editable && bleeps.hover?.play()}
                            onClick={() => {
                              if (editable) {
                                bleeps.click?.play();
                                setEditing({ itemId: item.id, fieldId: field.id });
                              }
                            }}
                          >
                            {value || '—'}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </Animated>
              </Animator>
            ))}
          </Animator>
        </tbody>
      </table>
    </div>
  );
}
