import type { TargetState } from '@rpg/actions';
import type { CharacterRecord, SheetEdit } from '@rpg/characters';
import type { SystemRef } from '@rpg/contracts';
import type { SystemPackage } from '@rpg/systems';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useRouteTarget } from '../../routes.ts';
import { ActionPanel } from './ActionPanel.tsx';
import type { CharacterSource } from './character-source.ts';
import { SheetView } from './SheetView.tsx';
import { CHARACTER_ROUTE } from './search-contribution.ts';

/**
 * Feature 15 screen: the campaign's characters on this device, creation against the pinned schema, and the
 * sheet with its actions. Local first (`PRD.md` s.76): every read is the replica plus pending edits, and every
 * edit is queued at once. The authority decides every write again.
 */

interface SheetData {
  readonly loaded: boolean;
  readonly pinned?: { readonly ref: SystemRef; readonly system: SystemPackage };
  readonly characters: readonly CharacterRecord[];
  readonly states: ReadonlyMap<string, TargetState>;
  readonly mayEditGmOnly: boolean;
}

async function readSheets(source: CharacterSource): Promise<SheetData> {
  const [pinned, characters, mayEditGmOnly, refused] = await Promise.all([
    source.system(),
    source.characters.list(),
    source.mayEditGmOnly(),
    source.refused(),
  ]);
  const states = new Map<string, TargetState>();
  for (const character of characters) {
    states.set(character.id, await source.characters.displayed(character, refused));
  }
  return {
    loaded: true,
    ...(pinned === undefined ? {} : { pinned }),
    characters,
    states,
    mayEditGmOnly,
  };
}

function useSheets(source: CharacterSource): SheetData {
  const [data, setData] = useState<SheetData>({
    loaded: false,
    characters: [],
    states: new Map(),
    mayEditGmOnly: false,
  });
  useEffect(() => {
    let cancelled = false;
    let running = false;
    let again = false;
    const load = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const next = await readSheets(source);
          if (!cancelled) setData(next);
        } while (again && !cancelled);
      } catch {
        // A replica read failure keeps the last good view.
      } finally {
        running = false;
      }
    };
    void load();
    const unsubscribe = source.subscribe(() => void load());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source]);
  return data;
}

const EDIT_MESSAGES: Readonly<Record<string, string>> = {
  unknown_field: 'That field is not part of this sheet.',
  invalid_value: 'That value is not allowed here.',
  too_long: 'That text is too long.',
  not_in_values: 'Choose one of the listed values.',
  gm_only: 'Only a GM can change that.',
  refused: 'That change cannot be made now.',
};

export function CharacterWorkspace(props: { readonly source: CharacterSource }) {
  const { source } = props;
  const data = useSheets(source);
  const [selectedId, setSelectedId] = useState<string>();
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const selected = data.characters.find((record) => record.id === selectedId);
  const state = selected === undefined ? undefined : data.states.get(selected.id);
  const system = data.pinned?.system;
  // Feature 20 D-10: a search result (or any link) to this view selects the record and shows it.
  const target = useRouteTarget(CHARACTER_ROUTE);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (target === undefined) return;
    setSelectedId(target.id);
    section.current?.scrollIntoView?.({ block: 'start' });
  }, [target]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (data.pinned === undefined) return;
    const created = await source.characters.create(data.pinned.system, data.pinned.ref, name);
    if (!created.ok) {
      setError(
        created.error.code === 'invalid_name' ? 'Give the character a name.' : 'Could not create.',
      );
      return;
    }
    setError(undefined);
    setName('');
    setSelectedId(created.value.id);
  };

  const edit = async (change: SheetEdit) => {
    if (selected === undefined || system === undefined) return;
    const result = await source.characters.edit(system, selected, change, data.mayEditGmOnly);
    if (result.ok) return setError(undefined);
    if (result.error.code === 'edit' && result.error.failure === 'nothing_to_change') return;
    setError(
      result.error.code === 'edit'
        ? (EDIT_MESSAGES[result.error.failure] ?? 'That change cannot be made.')
        : 'That change cannot be made.',
    );
  };

  return (
    <section ref={section} aria-label="Characters" data-characters-loaded={data.loaded}>
      <h2>Characters</h2>
      {data.loaded && data.pinned === undefined && (
        <p>The campaign's system is not on this device yet.</p>
      )}
      <ul aria-label="Character list">
        {data.characters.map((record) => (
          <li key={record.id}>
            <button
              type="button"
              aria-pressed={record.id === selectedId}
              onClick={() => setSelectedId(record.id)}
            >
              {record.name}
            </button>
          </li>
        ))}
      </ul>
      {data.pinned !== undefined && (
        <form onSubmit={(event) => void create(event)}>
          <label>
            New character name{' '}
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <button type="submit">Create character</button>
        </form>
      )}
      {error !== undefined && <p role="alert">{error}</p>}
      {selected !== undefined && state !== undefined && system !== undefined && (
        <article aria-label={`Sheet of ${selected.name}`}>
          <h3>{selected.name}</h3>
          <SheetView
            system={system}
            state={state}
            showGmOnly={data.mayEditGmOnly}
            onEdit={(change) => void edit(change)}
          />
          <ActionPanel
            source={source}
            system={system}
            character={selected}
            state={state}
            mayReadGmOnly={data.mayEditGmOnly}
            onError={setError}
          />
          <button
            type="button"
            onClick={() =>
              void source.characters
                .remove(selected.id, selected.version)
                .then(() => setSelectedId(undefined))
            }
          >
            Delete character
          </button>
        </article>
      )}
    </section>
  );
}
