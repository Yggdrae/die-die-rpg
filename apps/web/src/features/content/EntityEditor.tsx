import type { EntityRecord } from '@rpg/content';
import { type FormEvent, useId, useRef, useState } from 'react';
import {
  type CustomFieldRow,
  contentErrorMessage,
  creatableTypes,
  customFieldRows,
  fieldsFromRows,
  parseTagInput,
  tagSuggestions,
  typeLabel,
} from './content-model.ts';
import type { ContentSource } from './content-source.ts';

/**
 * Structured edit (name, type, summary, tags, free-form custom fields) through the device
 * repository: validated with the same rules as the authority, written locally at once, queued
 * with the version it was based on (BR-011). A stale upload becomes a feature 03 conflict with
 * both values; nothing is overwritten silently. Tag suggestions come from locally visible rows
 * only. Custom fields (D-01) are the same rows for every type: no type configuration is read.
 */
export function EntityEditor(props: {
  readonly source: ContentSource;
  readonly record: EntityRecord;
  readonly visibleRecords: readonly EntityRecord[];
  readonly onDone: () => void;
}) {
  const { record } = props;
  const [name, setName] = useState(record.name);
  const [type, setType] = useState(record.type);
  const [summary, setSummary] = useState(record.summary);
  const [tags, setTags] = useState(record.tags.join(', '));
  const [fieldRows, setFieldRows] = useState<CustomFieldRow[]>(() =>
    customFieldRows(record.fields),
  );
  const nextRow = useRef(fieldRows.length);
  const [error, setError] = useState<string>();
  const suggestionsId = useId();
  const types = creatableTypes();
  const typeChoices = types.some((definition) => definition.id === record.type)
    ? types
    : [{ id: record.type, label: typeLabel(record.type) }, ...types];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = fieldsFromRows(fieldRows);
    if (!fields.ok) {
      setError(contentErrorMessage(fields.error));
      return;
    }
    const saved = await props.source.entities.update(
      record.id,
      { name, type, summary, tags: parseTagInput(tags), fields: fields.value },
      record.version,
    );
    if (!saved.ok) {
      setError(contentErrorMessage(saved.error));
      return;
    }
    props.onDone();
  }

  const editRow = (key: string, change: Partial<Pick<CustomFieldRow, 'label' | 'value'>>) =>
    setFieldRows((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const addRow = () => {
    nextRow.current += 1;
    setFieldRows((rows) => [...rows, { key: `n${nextRow.current}`, label: '', value: '' }]);
  };
  const removeRow = (key: string) => setFieldRows((rows) => rows.filter((row) => row.key !== key));

  const typed = tags.split(',').map((tag) => tag.trim());
  const prefix = typed.slice(0, -1).join(', ');
  return (
    <form aria-label={`Edit ${record.name}`} onSubmit={(event) => void submit(event)}>
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>{' '}
      <label>
        Type
        <select value={type} onChange={(event) => setType(event.target.value)}>
          {typeChoices.map((definition) => (
            <option key={definition.id} value={definition.id}>
              {definition.label}
            </option>
          ))}
        </select>
      </label>{' '}
      <label>
        Summary
        <input value={summary} onChange={(event) => setSummary(event.target.value)} />
      </label>{' '}
      <label>
        Tags (comma-separated)
        <input
          value={tags}
          list={suggestionsId}
          onChange={(event) => setTags(event.target.value)}
        />
      </label>
      <datalist id={suggestionsId}>
        {tagSuggestions(props.visibleRecords, tags).map((tag) => (
          <option key={tag} value={prefix === '' ? tag : `${prefix}, ${tag}`} />
        ))}
      </datalist>
      <fieldset aria-label="Custom fields">
        <legend>Custom fields</legend>
        {fieldRows.map((row, index) => (
          <div key={row.key} data-testid="custom-field-row">
            <label>
              Field label {index + 1}
              <input
                value={row.label}
                onChange={(event) => editRow(row.key, { label: event.target.value })}
              />
            </label>{' '}
            <label>
              Field value {index + 1}
              <input
                value={row.value}
                onChange={(event) => editRow(row.key, { value: event.target.value })}
              />
            </label>{' '}
            <button
              type="button"
              aria-label={`Remove field ${index + 1}`}
              onClick={() => removeRow(row.key)}
            >
              Remove
            </button>
          </div>
        ))}
        <button type="button" onClick={addRow}>
          Add field
        </button>
      </fieldset>{' '}
      <button type="submit">Save changes</button>{' '}
      <button type="button" onClick={props.onDone}>
        Cancel
      </button>
      {error !== undefined && <p role="alert">{error}</p>}
    </form>
  );
}
