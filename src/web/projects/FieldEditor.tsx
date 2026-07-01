import { useState } from 'react';
import { DeskSelect } from '../arwes/primitives.js';
import type { FieldValuePayload, ProjectField } from './projectsClient.js';

const CLEAR = '__clear';

/**
 * Editor for one project field value. Single-select/iteration render as a
 * DeskSelect; text/number/date as a commit-on-Enter input. Emits the typed
 * payload the field-value endpoint expects.
 */
export function FieldEditor({
  field,
  current,
  onApply
}: {
  field: ProjectField;
  /** current display value ('' when unset) */
  current: string;
  onApply: (value: FieldValuePayload) => void;
}): JSX.Element | null {
  const [draft, setDraft] = useState(current);

  if (field.dataType === 'SINGLE_SELECT') {
    const options = [
      { value: CLEAR, label: '—' },
      ...(field.options ?? []).map((option) => ({ value: option.id, label: option.name }))
    ];
    const selected = (field.options ?? []).find((option) => option.name === current)?.id ?? CLEAR;
    return (
      <DeskSelect
        value={selected}
        options={options}
        onChange={(value) => onApply(value === CLEAR ? { clear: true } : { optionId: value })}
      />
    );
  }

  if (field.dataType === 'ITERATION') {
    const iterations = [
      ...(field.configuration?.iterations ?? []),
      ...(field.configuration?.completedIterations ?? [])
    ];
    const options = [
      { value: CLEAR, label: '—' },
      ...iterations.map((iteration) => ({ value: iteration.id, label: iteration.title }))
    ];
    const selected = iterations.find((iteration) => iteration.title === current)?.id ?? CLEAR;
    return (
      <DeskSelect
        value={selected}
        options={options}
        onChange={(value) => onApply(value === CLEAR ? { clear: true } : { iterationId: value })}
      />
    );
  }

  if (field.dataType === 'TEXT' || field.dataType === 'NUMBER' || field.dataType === 'DATE') {
    const commit = (): void => {
      const value = draft.trim();
      if (value === '') {
        onApply({ clear: true });
      } else if (field.dataType === 'NUMBER') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          onApply({ number: parsed });
        }
      } else if (field.dataType === 'DATE') {
        onApply({ date: value });
      } else {
        onApply({ text: value });
      }
    };
    return (
      <input
        className="treeInlineInput"
        type={field.dataType === 'DATE' ? 'date' : 'text'}
        inputMode={field.dataType === 'NUMBER' ? 'decimal' : undefined}
        value={draft}
        placeholder={field.name}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
          }
        }}
        onBlur={() => {
          if (draft !== current) {
            commit();
          }
        }}
      />
    );
  }

  // assignees/labels/milestone/repository are issue properties — edited via
  // the drawer's issue actions, not here.
  return null;
}
