import { PERSONAL_NOTE_CLASS, type PersonalNoteRecord } from '@rpg/content';
import { type FormEvent, useState } from 'react';
import { contentErrorMessage } from './content-model.ts';
import type { ContentSource } from './content-source.ts';
import { PersonalNoteView } from './EntityViews.tsx';
import { LongTextEditor } from './LongTextEditor.tsx';

/**
 * A player's private notes (BR-007): only the author's replica holds them. Title plus a body
 * edited through the same hold/draft editor as descriptions. No Visibility controls, no
 * attachments, no links (D-15).
 */
export function PersonalNotes(props: {
  readonly source: ContentSource;
  readonly notes: readonly PersonalNoteRecord[];
}) {
  const { source } = props;
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const note = props.notes.find((candidate) => candidate.id === selected);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await source.notes.create({ name: title });
    if (!created.ok) {
      setError(contentErrorMessage(created.error));
      return;
    }
    setError(undefined);
    setTitle('');
    setSelected(created.value.id);
  }

  return (
    <section aria-label="My notes">
      <h3>My notes</h3>
      <form aria-label="New note" onSubmit={(event) => void create(event)}>
        <label>
          Note title
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>{' '}
        <button type="submit">Add my note</button>
        {error !== undefined && <p role="alert">{error}</p>}
      </form>
      {props.notes.length === 0 ? (
        <p>No notes yet.</p>
      ) : (
        <ul>
          {props.notes.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                aria-pressed={candidate.id === selected}
                onClick={() => setSelected(candidate.id)}
              >
                {candidate.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {note !== undefined && (
        <PersonalNoteView note={note}>
          <LongTextEditor
            source={source}
            field={{ resourceClass: PERSONAL_NOTE_CLASS, recordId: note.id, fieldPath: 'body' }}
            label="Body"
            text={note.body}
            version={note.version}
            save={(text, hold) => source.notes.saveBody(note.id, text, hold)}
          />{' '}
          <button
            type="button"
            onClick={() => {
              void source.notes.remove(note.id, note.version);
              setSelected(undefined);
            }}
          >
            Delete note
          </button>
        </PersonalNoteView>
      )}
    </section>
  );
}
