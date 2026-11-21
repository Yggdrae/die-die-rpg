import type { SheetEdit } from '@rpg/characters';
import { AD_HOC_PARTICIPANT_TYPE } from '@rpg/content';
import {
  conditionControls,
  type EncounterNoteRecord,
  type EncounterRecord,
  type LocalEncounterError,
  type ParticipantDraft,
  participantControls,
} from '@rpg/encounters';
import type { SystemPackage } from '@rpg/systems';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useRouteTarget } from '../../routes.ts';
import type { EncounterSource } from './encounter-source.ts';
import { ENCOUNTER_ROUTE } from './search-contribution.ts';
import {
  type EncounterData,
  type EntityChoice,
  type ParticipantView,
  useEncounterData,
} from './useEncounterData.ts';

/**
 * Feature 19 tracker (`PRD.md` s.46, s.47): the GM starts an encounter in one form, then runs it from one screen
 * where every control is one feature 11 application (D-08). What each participant shows and offers comes from the
 * pinned package's declarations (D-07); there is no turn order (D-09). Players see a different, smaller view (D-12).
 */

const MESSAGES: Readonly<Record<string, string>> = {
  ended: 'This encounter has ended.',
  invalid_text: 'Check the name and the text.',
  invalid_label: 'Give the participant a name.',
  invalid_count: 'Add between 1 and 20 at a time.',
  not_found: 'That participant is no longer here.',
};

function message(error: LocalEncounterError | { readonly code: string }): string {
  if (error.code === 'edit' && 'failure' in error) {
    return error.failure === 'nothing_to_change' ? '' : 'That change cannot be made.';
  }
  return MESSAGES[error.code] ?? `Not saved (${error.code}).`;
}

/** What the start and add forms produce: party members, one creature group, one improvised group. */
export interface AddInput {
  readonly characterIds: readonly string[];
  readonly entity?: { readonly id: string; readonly count: number; readonly hidden: boolean };
  readonly improvised?: { readonly name: string; readonly count: number };
}

function count(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : 1;
}

export function ParticipantPicker(props: {
  readonly label: string;
  readonly submit: string;
  readonly party: EncounterData['party'];
  readonly sources: readonly EntityChoice[];
  readonly preselectParty: boolean;
  readonly withName?: string;
  readonly onSubmit: (input: AddInput, name: string) => void | Promise<void>;
}) {
  const [name, setName] = useState(props.withName ?? '');
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [entityId, setEntityId] = useState('');
  const [entityCount, setEntityCount] = useState('1');
  const [hidden, setHidden] = useState<boolean>();
  const [improvised, setImprovised] = useState('');
  const [improvisedCount, setImprovisedCount] = useState('1');
  const selected = (id: string) => (props.preselectParty ? !unchecked.has(id) : checked.has(id));
  const toggle = (id: string) => {
    const flip = (set: ReadonlySet<string>) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    };
    if (props.preselectParty) setUnchecked(flip);
    else setChecked(flip);
  };
  const entity = props.sources.find((item) => item.id === entityId);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await props.onSubmit(
      {
        characterIds: props.party.map((item) => item.id).filter(selected),
        ...(entity === undefined
          ? {}
          : {
              entity: { id: entity.id, count: count(entityCount), hidden: hidden ?? entity.hidden },
            }),
        ...(improvised.trim() === ''
          ? {}
          : { improvised: { name: improvised, count: count(improvisedCount) } }),
      },
      name,
    );
    setEntityId('');
    setImprovised('');
    setHidden(undefined);
  };
  return (
    <form aria-label={props.label} onSubmit={(event) => void submit(event)}>
      {props.withName !== undefined && (
        <label>
          Encounter name{' '}
          <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
      )}
      {props.party.length > 0 && (
        <fieldset>
          <legend>Party</legend>
          {props.party.map((character) => (
            <label key={character.id}>
              <input
                type="checkbox"
                checked={selected(character.id)}
                onChange={() => toggle(character.id)}
              />
              {character.name}
            </label>
          ))}
        </fieldset>
      )}
      <fieldset>
        <legend>Creatures</legend>
        {props.sources.length > 0 && (
          <label>
            Creature{' '}
            <select value={entityId} onChange={(event) => setEntityId(event.target.value)}>
              <option value="">None</option>
              {props.sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {entity !== undefined && (
          <>
            <label>
              Creature count{' '}
              <input
                type="number"
                min={1}
                max={20}
                value={entityCount}
                onChange={(event) => setEntityCount(event.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={hidden ?? entity.hidden}
                onChange={(event) => setHidden(event.target.checked)}
              />
              Hide from players
            </label>
          </>
        )}
        <label>
          Improvised enemy{' '}
          <input
            value={improvised}
            maxLength={100}
            onChange={(event) => setImprovised(event.target.value)}
          />
        </label>
        <label>
          Improvised count{' '}
          <input
            type="number"
            min={1}
            max={20}
            value={improvisedCount}
            onChange={(event) => setImprovisedCount(event.target.value)}
          />
        </label>
      </fieldset>
      <button type="submit">{props.submit}</button>
    </form>
  );
}

function ParticipantCard(props: {
  readonly view: ParticipantView;
  readonly system?: SystemPackage;
  readonly active: boolean;
  readonly onEdit: (edit: SheetEdit) => void;
  readonly onReveal: () => void;
  readonly onRemove: () => void;
}) {
  const { view, system } = props;
  const label = view.record.name;
  const hidden = view.record.visibility.mode !== 'everyone';
  const state = view.state;
  return (
    <article aria-label={label} data-participant={view.record.sourceKind}>
      <h4>
        {label}
        {hidden && <small> (hidden from players)</small>}
      </h4>
      {view.summary.length > 0 && (
        <p data-testid="participant-summary">
          {view.summary.map((value) => `${value.label} ${value.text}`).join(' · ')}
        </p>
      )}
      {view.conditions.length > 0 && <p>Conditions: {view.conditions.join(', ')}</p>}
      {props.active && system !== undefined && state !== undefined && (
        <fieldset aria-label={`Controls for ${label}`}>
          {participantControls(system, state).map((control) => (
            <span key={control.key}>
              {control.label}{' '}
              {control.buttons.map((button) => (
                <button
                  key={button.label}
                  type="button"
                  aria-label={`${control.label} ${button.label}`}
                  {...(button.pressed === undefined ? {} : { 'aria-pressed': button.pressed })}
                  onClick={() => props.onEdit(button.edit)}
                >
                  {button.label}
                </button>
              ))}{' '}
            </span>
          ))}
          {conditionControls(system, state).map((condition) => (
            <span key={condition.key}>
              {condition.label} {condition.count > 0 ? `(${condition.count})` : ''}{' '}
              <button
                type="button"
                aria-label={`Add ${condition.label}`}
                onClick={() => props.onEdit(condition.add)}
              >
                +
              </button>
              {condition.count > 0 && (
                <button
                  type="button"
                  aria-label={`Remove ${condition.label}`}
                  onClick={() => props.onEdit(condition.remove)}
                >
                  −
                </button>
              )}{' '}
            </span>
          ))}
        </fieldset>
      )}
      {props.active && hidden && (
        <button type="button" onClick={props.onReveal}>
          Reveal {label}
        </button>
      )}
      {props.active && (
        <button type="button" onClick={props.onRemove}>
          Remove {label}
        </button>
      )}
    </article>
  );
}

export function GmEncounterView(props: {
  readonly encounter: EncounterRecord;
  readonly data: EncounterData;
  readonly onEdit: (view: ParticipantView, edit: SheetEdit) => void;
  readonly onAdd: (input: AddInput) => void | Promise<void>;
  readonly onReveal: (view: ParticipantView) => void;
  readonly onRemove: (view: ParticipantView) => void;
  readonly onEnvironment: (environment: string, locationId: string | undefined) => void;
  readonly onSaveNote: (body: string, note: EncounterNoteRecord | undefined) => void;
  readonly onEnd: () => void;
}) {
  const { encounter, data } = props;
  const participants = data.participants.get(encounter.id) ?? [];
  const active = encounter.status === 'active';
  const note = data.notes.get(encounter.id);
  const [environment, setEnvironment] = useState(encounter.environment);
  const [locationId, setLocationId] = useState(encounter.locationId ?? '');
  const [body, setBody] = useState<string>();
  const location = data.locations.find((item) => item.id === encounter.locationId);
  return (
    <section aria-label="Tracker" data-encounter-status={encounter.status}>
      <h3>{encounter.name}</h3>
      <p role="status">{active ? 'In progress' : 'Ended'}</p>
      {location !== undefined && <p>Location: {location.name}</p>}
      <ul aria-label="Participants">
        {participants.map((view) => (
          <li key={view.record.id}>
            <ParticipantCard
              view={view}
              {...(data.system === undefined ? {} : { system: data.system })}
              active={active}
              onEdit={(edit) => props.onEdit(view, edit)}
              onReveal={() => props.onReveal(view)}
              onRemove={() => props.onRemove(view)}
            />
          </li>
        ))}
      </ul>
      {active && (
        <>
          <ParticipantPicker
            label="Add participants"
            submit="Add to encounter"
            party={data.party.filter(
              (character) => !participants.some((view) => view.record.sourceId === character.id),
            )}
            sources={data.sources}
            preselectParty={false}
            onSubmit={(input) => props.onAdd(input)}
          />
          <form
            aria-label="Environment"
            onSubmit={(event) => {
              event.preventDefault();
              props.onEnvironment(environment, locationId === '' ? undefined : locationId);
            }}
          >
            <label>
              Environment{' '}
              <textarea
                value={environment}
                maxLength={2000}
                onChange={(event) => setEnvironment(event.target.value)}
              />
            </label>
            {data.locations.length > 0 && (
              <label>
                Location{' '}
                <select value={locationId} onChange={(event) => setLocationId(event.target.value)}>
                  <option value="">None</option>
                  {data.locations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="submit">Save environment</button>
          </form>
        </>
      )}
      {!active && encounter.environment !== '' && <p>{encounter.environment}</p>}
      <section aria-label="Encounter notes">
        <label>
          Encounter notes{' '}
          <textarea
            value={body ?? note?.body ?? ''}
            maxLength={5000}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={body === undefined}
          onClick={() => {
            if (body !== undefined) props.onSaveNote(body, note);
            setBody(undefined);
          }}
        >
          Save encounter notes
        </button>
      </section>
      {active && (
        <button type="button" onClick={props.onEnd}>
          End encounter
        </button>
      )}
    </section>
  );
}

export function PlayerEncounterView(props: {
  readonly encounter: EncounterRecord;
  readonly data: EncounterData;
}) {
  const { encounter, data } = props;
  const participants = data.participants.get(encounter.id) ?? [];
  return (
    <section aria-label="Encounter" data-encounter-status={encounter.status}>
      <h3>{encounter.name}</h3>
      {encounter.environment !== '' && <p>{encounter.environment}</p>}
      <ul aria-label="Participants">
        {participants.map((view) => (
          <li key={view.record.id}>
            <strong>{view.record.name}</strong>
            {view.summary.length > 0 && (
              <span data-testid="participant-summary">
                {' '}
                {view.summary.map((value) => `${value.label} ${value.text}`).join(' · ')}
              </span>
            )}
            {view.conditions.length > 0 && <span> — {view.conditions.join(', ')}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function EncounterWorkspace(props: {
  readonly source: EncounterSource;
  /** The session the encounter starts from (Session Mode quick action, D-11). */
  readonly sessionId?: string;
  /** Opens straight on the start form (the quick action). */
  readonly starting?: boolean;
}) {
  const { source } = props;
  const data = useEncounterData(source);
  const [selectedId, setSelectedId] = useState<string>();
  const [starting, setStarting] = useState(props.starting === true);
  const [error, setError] = useState<string>();
  const system = data.system;
  const active = data.encounters.filter((encounter) => encounter.status === 'active');
  const selected =
    data.encounters.find((encounter) => encounter.id === selectedId) ??
    (starting ? undefined : active[0]);
  // Feature 20 D-10: a search result (or any link) to this view selects the record and shows it.
  const target = useRouteTarget(ENCOUNTER_ROUTE);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (target === undefined) return;
    setStarting(false);
    setSelectedId(target.id);
    section.current?.scrollIntoView?.({ block: 'start' });
  }, [target]);

  const report = (failure: LocalEncounterError | undefined) =>
    setError(failure === undefined ? undefined : message(failure) || undefined);

  const add = async (encounter: EncounterRecord, input: AddInput): Promise<boolean> => {
    if (system === undefined) return false;
    const drafts: ParticipantDraft[] = input.characterIds.flatMap((id) => {
      const character = data.party.find((item) => item.id === id);
      return character === undefined
        ? []
        : [{ sourceKind: 'character' as const, sourceId: id, label: character.name }];
    });
    if (input.entity !== undefined) {
      const entity = data.sources.find((item) => item.id === input.entity?.id);
      if (entity !== undefined) {
        drafts.push({
          sourceKind: 'entity',
          sourceId: entity.id,
          label: entity.name,
          count: input.entity.count,
          hidden: input.entity.hidden,
        });
      }
    }
    if (input.improvised !== undefined) {
      // D-03: an improvised enemy is a real entity, GM-only by default, created before its participant.
      const created = await source.entities.create({
        type: AD_HOC_PARTICIPANT_TYPE,
        name: input.improvised.name,
      });
      if (!created.ok) {
        setError(MESSAGES.invalid_label);
        return false;
      }
      drafts.push({
        sourceKind: 'entity',
        sourceId: created.value.id,
        label: created.value.name,
        count: input.improvised.count,
      });
    }
    if (drafts.length === 0) return true;
    const added = await source.participants.add(system, encounter, drafts);
    report(added.ok ? undefined : added.error);
    return added.ok;
  };

  const start = async (input: AddInput, name: string) => {
    const started = await source.encounters.start({
      name: name.trim() === '' ? `Encounter ${data.encounters.length + 1}` : name,
      ...(props.sessionId === undefined ? {} : { sessionId: props.sessionId }),
    });
    if (!started.ok) return report(started.error);
    setStarting(false);
    setSelectedId(started.value.id);
    await add(started.value, input);
  };

  const edit = async (encounter: EncounterRecord, view: ParticipantView, change: SheetEdit) => {
    if (system === undefined) return;
    const result =
      view.character !== undefined
        ? await source.participants.editCharacter(
            system,
            encounter,
            source.characters,
            view.character,
            change,
            data.mayEditGmOnly,
          )
        : await source.participants.edit(system, encounter, view.record, change);
    report(result.ok ? undefined : result.error);
  };

  if (!data.loaded) {
    return (
      <section ref={section} aria-label="Encounters" data-encounters-loaded="false">
        <p>Loading encounters…</p>
      </section>
    );
  }
  return (
    <section ref={section} aria-label="Encounters" data-encounters-loaded="true">
      <h2>Encounters</h2>
      {error !== undefined && <p role="alert">{error}</p>}
      {system === undefined && <p>The campaign's system is not on this device yet.</p>}
      {data.gm ? (
        <>
          {data.encounters.length > 0 && (
            <ul aria-label="Encounter list">
              {data.encounters.map((encounter) => (
                <li key={encounter.id}>
                  <button
                    type="button"
                    aria-pressed={encounter.id === selected?.id}
                    onClick={() => {
                      setStarting(false);
                      setSelectedId(encounter.id);
                    }}
                  >
                    {encounter.name}
                    {encounter.status === 'ended' ? ' (ended)' : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {starting || selected === undefined ? (
            system !== undefined && (
              <ParticipantPicker
                label="Start encounter"
                submit="Start encounter"
                party={data.party}
                sources={data.sources}
                preselectParty
                withName={`Encounter ${data.encounters.length + 1}`}
                onSubmit={start}
              />
            )
          ) : (
            <>
              <button type="button" onClick={() => setStarting(true)}>
                New encounter
              </button>
              <GmEncounterView
                key={selected.id}
                encounter={selected}
                data={data}
                onEdit={(view, change) => void edit(selected, view, change)}
                onAdd={(input) => void add(selected, input)}
                onReveal={(view) =>
                  void source.participants
                    .reveal(view.record)
                    .then((result) => report(result.ok ? undefined : result.error))
                }
                onRemove={(view) =>
                  void source.participants
                    .remove(view.record)
                    .then((result) => report(result.ok ? undefined : result.error))
                }
                onEnvironment={(environment, locationId) =>
                  void source.encounters
                    .change(selected.id, {
                      kind: 'environment',
                      environment,
                      ...(locationId === undefined ? {} : { locationId }),
                    })
                    .then((result) => report(result.ok ? undefined : result.error))
                }
                onSaveNote={(body, note) =>
                  void source.notes
                    .save(selected.id, body, note?.version ?? null)
                    .then((result) => report(result.ok ? undefined : result.error))
                }
                onEnd={() =>
                  void source.encounters
                    .end(selected.id)
                    .then((result) => report(result.ok ? undefined : result.error))
                }
              />
            </>
          )}
        </>
      ) : active.length === 0 ? (
        <p>No encounter is running.</p>
      ) : (
        active.map((encounter) => (
          <PlayerEncounterView key={encounter.id} encounter={encounter} data={data} />
        ))
      )}
    </section>
  );
}
