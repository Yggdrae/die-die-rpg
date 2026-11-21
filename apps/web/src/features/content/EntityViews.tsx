import {
  CONTENT_CONFIGURATION,
  type ContentConfiguration,
  type EntityRecord,
  type LocalEntityFilter,
  type PersonalNoteRecord,
  type QuickCreateEntryPoint,
} from '@rpg/content';
import type { Visibility } from '@rpg/contracts';
import { type FormEvent, type ReactNode, useState } from 'react';
import { audienceLabel } from '../visibility/visibility-model.ts';
import { type RelationshipView, sortedFields, typeLabel, typeOptions } from './content-model.ts';

/**
 * Stateless feature 16 views (one generic screen for every type, ADR-001). Everything typed by a
 * user renders as React text: a description is Markdown source shown as escaped plain text with
 * its line breaks (D-10), never parsed as HTML.
 */

/** Escaped plain text, line breaks preserved (D-10). */
export function PlainText(props: { readonly text: string; readonly testId?: string }) {
  return (
    <p data-testid={props.testId} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {props.text}
    </p>
  );
}

export function EntityFiltersView(props: {
  readonly filter: LocalEntityFilter;
  readonly tags: readonly string[];
  readonly visibilityModes: readonly Visibility['mode'][];
  readonly onChange: (filter: LocalEntityFilter) => void;
  readonly config?: ContentConfiguration;
}) {
  const { filter, onChange } = props;
  const set = (patch: Partial<LocalEntityFilter>) => {
    const next: Record<string, unknown> = { ...filter, ...patch };
    for (const key of Object.keys(next))
      if (next[key] === '' || next[key] === undefined) delete next[key];
    onChange(next as LocalEntityFilter);
  };
  return (
    <search>
      <form aria-label="Find entities" onSubmit={(event) => event.preventDefault()}>
        <label>
          Search by name
          <input
            type="search"
            value={filter.nameFragment ?? ''}
            onChange={(event) => set({ nameFragment: event.target.value })}
          />
        </label>{' '}
        <label>
          Type
          <select value={filter.type ?? ''} onChange={(event) => set({ type: event.target.value })}>
            <option value="">All types</option>
            {typeOptions(props.config).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Tag
          <select value={filter.tag ?? ''} onChange={(event) => set({ tag: event.target.value })}>
            <option value="">All tags</option>
            {props.tags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Visibility
          <select
            value={filter.visibilityMode ?? ''}
            onChange={(event) =>
              set({ visibilityMode: (event.target.value || undefined) as Visibility['mode'] })
            }
          >
            <option value="">Anyone</option>
            {props.visibilityModes.map((mode) => (
              <option key={mode} value={mode}>
                {audienceLabel(visibilityOfMode(mode))}
              </option>
            ))}
          </select>
        </label>
      </form>
    </search>
  );
}

function visibilityOfMode(mode: Visibility['mode']): Visibility {
  if (mode === 'players') return { mode, playerIds: [] };
  if (mode === 'party') return { mode, partyIds: [] };
  return { mode };
}

export function EntityListView(props: {
  readonly records: readonly EntityRecord[];
  readonly total: number;
  readonly selectedId?: string;
  readonly onSelect: (id: string) => void;
  readonly config?: ContentConfiguration;
}) {
  return (
    <section aria-label="Entities">
      <p role="status" data-testid="entity-count">
        {props.records.length} of {props.total} entities
      </p>
      {props.records.length === 0 ? (
        <p>No entity matches.</p>
      ) : (
        <ul>
          {props.records.map((record) => (
            <li key={record.id} data-entity-id={record.id} data-entity-type={record.type}>
              <button
                type="button"
                aria-pressed={record.id === props.selectedId}
                onClick={() => props.onSelect(record.id)}
              >
                {record.name}
              </button>{' '}
              <small>
                {typeLabel(record.type, props.config)} · {audienceLabel(record.visibility)}
              </small>
              {record.summary !== '' && <small> — {record.summary}</small>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function EntityDetailView(props: {
  readonly record: EntityRecord;
  readonly config?: ContentConfiguration;
  /** Controls mounted by the container (editor, Visibility, relationships, attachments). */
  readonly children?: ReactNode;
}) {
  const { record } = props;
  const fields = sortedFields(record.fields);
  return (
    <article aria-label={`${record.name} details`} data-entity-id={record.id}>
      <h3>{record.name}</h3>
      <p>
        <span data-testid="entity-type">{typeLabel(record.type, props.config)}</span> ·{' '}
        <span data-testid="entity-audience">{audienceLabel(record.visibility)}</span>
      </p>
      {record.summary !== '' && <PlainText text={record.summary} testId="entity-summary" />}
      {record.tags.length > 0 && (
        <ul aria-label="Tags">
          {record.tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      )}
      {fields.length > 0 && (
        <dl aria-label="Custom fields">
          {fields.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <section aria-label="Description">
        <h4>Description</h4>
        {record.description === '' ? (
          <p>No description.</p>
        ) : (
          <PlainText text={record.description} testId="entity-description" />
        )}
      </section>
      {props.children}
    </article>
  );
}

/**
 * A personal note (BR-007, D-15): title and body only. No Visibility controls, no attachments,
 * no links.
 */
export function PersonalNoteView(props: {
  readonly note: PersonalNoteRecord;
  readonly children?: ReactNode;
}) {
  return (
    <article aria-label={`${props.note.name} note`} data-note-id={props.note.id}>
      <h4>{props.note.name}</h4>
      {props.note.body === '' ? (
        <p>Empty note.</p>
      ) : (
        <PlainText text={props.note.body} testId="note-body" />
      )}
      {props.children}
    </article>
  );
}

export function RelationshipListView(props: {
  readonly rows: readonly RelationshipView[];
  readonly config?: ContentConfiguration;
  readonly onOpen?: (entityId: string) => void;
  /** Per-link controls (remove, Visibility) mounted by the container. */
  readonly controls?: (row: RelationshipView) => ReactNode;
}) {
  if (props.rows.length === 0) return <p>No links.</p>;
  return (
    <ul aria-label="Links">
      {props.rows.map((row) => (
        <li key={row.link.id} data-link-id={row.link.id} data-link-deleted={row.otherDeleted}>
          <span>{row.label}</span>{' '}
          {row.otherDeleted || row.otherName === undefined ? (
            <em data-testid="broken-link">
              {row.otherDeleted ? 'Deleted entity' : 'Unavailable entity'}
            </em>
          ) : (
            <button type="button" onClick={() => props.onOpen?.(row.otherId)}>
              {row.otherName}
            </button>
          )}
          {row.otherType !== undefined && !row.otherDeleted && (
            <small> ({typeLabel(row.otherType, props.config)})</small>
          )}{' '}
          <small>{audienceLabel(row.link.visibility)}</small>
          {props.controls?.(row)}
        </li>
      ))}
    </ul>
  );
}

/**
 * FR-005 quick create: the name input is focused on open, the summary is optional, Enter saves.
 * The type comes from the entry point; without one it is the configured default (D-09).
 */
export function QuickCreateForm(props: {
  readonly entry?: QuickCreateEntryPoint;
  readonly config?: ContentConfiguration;
  /** Resolves with an error message, or undefined when saved. */
  readonly onSave: (input: {
    readonly type: string;
    readonly name: string;
    readonly summary: string;
  }) => Promise<string | undefined>;
  readonly onCancel: () => void;
}) {
  const config = props.config ?? CONTENT_CONFIGURATION;
  const type = props.entry?.type ?? config.defaultQuickCreateType;
  const title = props.entry?.label ?? `New ${typeLabel(type, config)}`;
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const failure = await props.onSave({ type, name, summary });
    setBusy(false);
    setError(failure);
  }

  return (
    <form aria-label={title} data-quick-create-type={type} onSubmit={(event) => void submit(event)}>
      <h3>{title}</h3>
      <label>
        Name
        {/* biome-ignore lint/a11y/noAutofocus: quick create opens straight into the name (FR-005). */}
        <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      </label>{' '}
      <label>
        Summary (optional)
        <input value={summary} onChange={(event) => setSummary(event.target.value)} />
      </label>{' '}
      <button type="submit" disabled={busy}>
        Save
      </button>{' '}
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
      {error !== undefined && <p role="alert">{error}</p>}
    </form>
  );
}
