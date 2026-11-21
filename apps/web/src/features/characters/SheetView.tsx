import type { TargetState } from '@rpg/actions';
import {
  computedValues,
  entriesOf,
  itemsOf,
  type SheetEdit,
  type SheetField,
  sheetLayout,
} from '@rpg/characters';
import type { SystemPackage } from '@rpg/systems';
import { type FormEvent, useState } from 'react';

/**
 * Feature 15 FR-001 and FR-002: one sheet for any package. Every component is chosen from the declaration;
 * nothing here knows which system it renders (`PRD.md` s.89). Edits are reported as `SheetEdit`s, and the
 * caller turns them into feature 11 applications.
 */

export interface SheetViewProps {
  readonly system: SystemPackage;
  readonly state: TargetState;
  /** GM-only fields are hidden unless the viewer may read them (they are absent from a player's device). */
  readonly showGmOnly: boolean;
  readonly onEdit?: (edit: SheetEdit) => void;
  /** Ids for new entries and items; injectable for static tests. */
  readonly newId?: () => string;
}

function label(field: SheetField['field']) {
  return field.label;
}

function TextInput(props: {
  readonly id: string;
  readonly value: string;
  readonly multiline?: boolean;
  readonly label: string;
  readonly onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  const commit = () => {
    if (draft !== props.value) props.onCommit(draft);
  };
  return props.multiline === true ? (
    <textarea
      id={props.id}
      aria-label={props.label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
    />
  ) : (
    <input
      id={props.id}
      aria-label={props.label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
}

function Stepper(props: {
  readonly label: string;
  readonly value: number | string;
  readonly onStep?: (by: number) => void;
}) {
  return (
    <span data-stepper={props.label}>
      <button
        type="button"
        aria-label={`Decrease ${props.label}`}
        onClick={() => props.onStep?.(-1)}
      >
        −
      </button>
      <output aria-label={props.label}>{props.value}</output>
      <button
        type="button"
        aria-label={`Increase ${props.label}`}
        onClick={() => props.onStep?.(1)}
      >
        +
      </button>
    </span>
  );
}

function FieldView(props: SheetViewProps & { readonly item: SheetField }) {
  const { system, state, item, onEdit } = props;
  const { field } = item;
  const id = `sheet-${field.key}`;
  const value = Object.hasOwn(state.fields, field.key) ? state.fields[field.key] : undefined;
  switch (item.component) {
    case 'text':
    case 'rich_text':
      return (
        <TextInput
          key={`${field.key}:${String(value)}`}
          id={id}
          label={label(field)}
          value={typeof value === 'string' ? value : ''}
          multiline={item.component === 'rich_text'}
          onCommit={(text) => onEdit?.({ kind: 'set_field', field: field.key, value: text })}
        />
      );
    case 'number':
      return (
        <Stepper
          label={label(field)}
          value={typeof value === 'number' ? value : 0}
          onStep={(by) => onEdit?.({ kind: 'adjust_field', field: field.key, by })}
        />
      );
    case 'boolean':
      return (
        <input
          id={id}
          type="checkbox"
          aria-label={label(field)}
          checked={value === true}
          onChange={(event) =>
            onEdit?.({ kind: 'set_field', field: field.key, value: event.target.checked })
          }
        />
      );
    case 'select':
      return field.type === 'select' ? (
        <select
          id={id}
          aria-label={label(field)}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) =>
            onEdit?.({ kind: 'set_field', field: field.key, value: event.target.value })
          }
        >
          {field.values.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : null;
    case 'computed':
      return (
        <output aria-label={label(field)}>
          {String(computedValues(system, state)[field.key] ?? '—')}
        </output>
      );
    case 'resource_pool':
    case 'resource_track':
      return <ResourceView {...props} />;
    case 'conditions':
      return <ConditionsView {...props} />;
    case 'inventory':
      return <InventoryView {...props} />;
    case 'list':
    case 'repeater':
      return <EntriesView {...props} />;
    default:
      return (
        <p role="note" data-unsupported-field={field.key}>
          Component unavailable: {field.label}
        </p>
      );
  }
}

function ResourceView(props: SheetViewProps & { readonly item: SheetField }) {
  const { system, state, item, onEdit } = props;
  if (item.field.type !== 'resource') return null;
  const key = item.field.resourceKey;
  const resource = system.resources.find((candidate) => candidate.key === key);
  if (resource === undefined) return null;
  if (resource.shape === 'pool') {
    const current = state.resources[key]?.current ?? 0;
    const temporary = state.resources[key]?.temporary;
    return (
      <span data-resource={key}>
        <Stepper
          label={resource.label}
          value={current}
          onStep={(by) => onEdit?.({ kind: 'adjust_resource', resource: key, by })}
        />
        {temporary !== undefined && temporary > 0 && <small> +{temporary} temporary</small>}
      </span>
    );
  }
  return (
    <fieldset data-track={key}>
      <legend>{resource.label}</legend>
      {resource.boxes.map((box) => (
        <label key={box.id}>
          <input
            type="checkbox"
            checked={state.tracks[key]?.[box.id] === true}
            onChange={() => onEdit?.({ kind: 'toggle_box', resource: key, box: box.id })}
          />
          {box.label}
        </label>
      ))}
    </fieldset>
  );
}

function ConditionsView(props: SheetViewProps) {
  const { system, state, onEdit, showGmOnly } = props;
  return (
    <ul data-conditions="">
      {system.mechanics.conditions
        .filter((condition) => showGmOnly || condition.visibility !== 'gm_only')
        .map((condition) => {
          const count = state.conditions[condition.key] ?? 0;
          return (
            <li key={condition.key}>
              {condition.label}{' '}
              <Stepper
                label={condition.label}
                value={count}
                onStep={(by) =>
                  onEdit?.({
                    kind: 'adjust_condition',
                    condition: condition.key,
                    by: by > 0 ? 1 : -1,
                  })
                }
              />
            </li>
          );
        })}
    </ul>
  );
}

function InventoryView(props: SheetViewProps) {
  const { system, state, onEdit, newId } = props;
  const inventory = system.mechanics.inventory;
  const [name, setName] = useState('');
  if (inventory === undefined) return null;
  const items = itemsOf(state, inventory.key);
  const used =
    items.reduce((total, item) => total + item.size, 0) +
    system.mechanics.conditions.reduce(
      (total, condition) =>
        total + (condition.occupiesSlots ?? 0) * (state.conditions[condition.key] ?? 0),
      0,
    );
  const capacity = typeof inventory.capacity === 'number' ? inventory.capacity : undefined;
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') return;
    onEdit?.({
      kind: 'add_item',
      id: (newId ?? (() => crypto.randomUUID()))(),
      name,
      slot: items.length + 1,
    });
    setName('');
  };
  return (
    <div data-inventory={inventory.key}>
      <p>
        {inventory.label}: {used}
        {capacity === undefined ? '' : ` / ${capacity}`} {inventory.unit}
        {capacity !== undefined && used > capacity && <strong role="status"> over capacity</strong>}
      </p>
      <ol>
        {items.map((item) => (
          <li key={item.id}>
            {item.name} (slot {item.slot}){' '}
            <button type="button" onClick={() => onEdit?.({ kind: 'remove_item', id: item.id })}>
              Remove {item.name}
            </button>
          </li>
        ))}
      </ol>
      <form onSubmit={add}>
        <input
          aria-label={`New item for ${inventory.label}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit">Add item</button>
      </form>
    </div>
  );
}

function EntriesView(props: SheetViewProps & { readonly item: SheetField }) {
  const { state, item, onEdit, newId } = props;
  const { field } = item;
  const [entryType, setEntryType] = useState<string>();
  if (field.type !== 'list' && field.type !== 'repeater') return null;
  const subfields =
    field.type === 'list'
      ? [{ key: 'text', label: field.label, type: 'text' as const }]
      : field.of.map((nested) => ({ key: nested.key, label: nested.label, type: nested.type }));
  const entries = entriesOf(state, field.key);
  const types = field.type === 'repeater' ? field.entryTypes : undefined;
  const slots = field.type === 'repeater' ? field.slots : undefined;
  return (
    <div data-entries={field.key}>
      {slots !== undefined && (
        <ul data-slots={field.key}>
          {slots.map((slot) => {
            const text = state.slots[field.key]?.[slot.id] ?? '';
            return (
              <li key={slot.id}>
                <span>
                  {slot.label} ({slot.severity}){' '}
                  <TextInput
                    key={`${slot.id}:${text}`}
                    id={`slot-${field.key}-${slot.id}`}
                    label={`${field.label} ${slot.label}`}
                    value={text}
                    onCommit={(value) =>
                      onEdit?.({ kind: 'set_slot', field: field.key, slot: slot.id, text: value })
                    }
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {slots === undefined && (
        <>
          <ul>
            {entries.map((entry) => (
              <li key={entry.id} data-entry={entry.id}>
                {typeof entry.values._type === 'string' && (
                  <small>{types?.find((type) => type.id === entry.values._type)?.label} </small>
                )}
                {subfields.map((sub) =>
                  sub.type === 'number' || sub.type === 'counter' ? (
                    <Stepper
                      key={sub.key}
                      label={`${sub.label} of ${field.label}`}
                      value={Number(entry.values[sub.key] ?? 0)}
                      onStep={(by) =>
                        onEdit?.({
                          kind: 'set_entry',
                          field: field.key,
                          id: entry.id,
                          subfield: sub.key,
                          value: Number(entry.values[sub.key] ?? 0) + by,
                        })
                      }
                    />
                  ) : (
                    <TextInput
                      key={`${sub.key}:${String(entry.values[sub.key])}`}
                      id={`entry-${field.key}-${entry.id}-${sub.key}`}
                      label={`${sub.label} of ${field.label}`}
                      value={
                        typeof entry.values[sub.key] === 'string'
                          ? (entry.values[sub.key] as string)
                          : ''
                      }
                      multiline={sub.type === 'rich_text'}
                      onCommit={(value) =>
                        onEdit?.({
                          kind: 'set_entry',
                          field: field.key,
                          id: entry.id,
                          subfield: sub.key,
                          value,
                        })
                      }
                    />
                  ),
                )}
                <button
                  type="button"
                  onClick={() => onEdit?.({ kind: 'remove_entry', field: field.key, id: entry.id })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {types !== undefined && (
            <select
              aria-label={`Type of new ${field.label}`}
              value={entryType ?? ''}
              onChange={(event) => setEntryType(event.target.value || undefined)}
            >
              <option value="">—</option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.label}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() =>
              onEdit?.({
                kind: 'add_entry',
                field: field.key,
                id: (newId ?? (() => crypto.randomUUID()))(),
                ...(entryType === undefined ? {} : { entryType }),
              })
            }
          >
            Add to {field.label}
          </button>
        </>
      )}
    </div>
  );
}

export function SheetView(props: SheetViewProps) {
  const layout = sheetLayout(props.system);
  return (
    <div data-sheet={props.system.manifest.ref.systemId}>
      {layout.map((group) => {
        const fields = group.fields.filter((item) => props.showGmOnly || !item.gmOnly);
        if (fields.length === 0) return null;
        return (
          <fieldset key={group.key} data-group={group.key}>
            <legend>{group.key}</legend>
            {fields.map((item) => (
              <div key={item.field.key} data-field={item.field.key} data-component={item.component}>
                <label htmlFor={`sheet-${item.field.key}`}>{item.field.label}</label>{' '}
                <FieldView {...props} item={item} />
              </div>
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}
