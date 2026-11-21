import {
  attachmentVisibilityFor,
  type EntityRecord,
  type EntityVisibilityChange,
  HANDOUT_ENTITY_TYPE,
} from '@rpg/content';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { contentErrorMessage } from '../content/content-model.ts';
import type { ContentSource } from '../content/content-source.ts';
import { EntityAttachments } from '../content/EntityAttachments.tsx';
import { PlainText } from '../content/EntityViews.tsx';
import { useContentData } from '../content/useContentData.ts';
import { loadCurrentMembers } from '../visibility/visibility-api.ts';
import {
  type MemberLike,
  mayShowRevealControls,
  PARTY_UNAVAILABLE,
} from '../visibility/visibility-model.ts';
import {
  audienceOf,
  audienceText,
  confirmLabel,
  type DeliveryState,
  deliveryOf,
  deliveryText,
  HIDE_CHANGE,
  handoutsOf,
  type RevealChoice,
  revealCandidates,
  revealChange,
  UNREVEAL_NOTE,
} from './handout-model.ts';

/**
 * Feature 17 screen over the local replica. A GM prepares, previews, reveals, and hides handouts;
 * a player reads the handouts their device received, offline included. A reveal is a queued
 * mutation (D-03), so it works the same online and offline; the authority decides it.
 */

export type MembersLoader = (campaignId: string) => Promise<readonly MemberLike[]>;

/** D-05: the member list, loaded while online and kept for this page's life. */
const membersCache = new Map<string, readonly MemberLike[]>();

function useMembers(campaignId: string, enabled: boolean, load: MembersLoader) {
  const [members, setMembers] = useState<readonly MemberLike[] | undefined>(
    membersCache.get(campaignId),
  );
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    load(campaignId)
      .then((loaded) => {
        membersCache.set(campaignId, loaded);
        if (!cancelled) setMembers(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [campaignId, enabled, load]);
  return members;
}

function useDelivery(
  source: ContentSource,
  handouts: readonly EntityRecord[],
): ReadonlyMap<string, DeliveryState> {
  const [delivery, setDelivery] = useState<ReadonlyMap<string, DeliveryState>>(new Map());
  const key = handouts.map((record) => `${record.id}:${record.version}`).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the handout list.
  useEffect(() => {
    const read = source.mutationState;
    if (read === undefined) return;
    let cancelled = false;
    const refresh = async () => {
      const states = await Promise.all(
        handouts.map(async (record) => [record.id, deliveryOf(await read(record.id))] as const),
      );
      if (!cancelled) setDelivery(new Map(states));
    };
    void refresh();
    const dispose = source.subscribe(() => void refresh());
    return () => {
      cancelled = true;
      dispose();
    };
  }, [source, key]);
  return delivery;
}

export function HandoutsWorkspace(props: {
  readonly source: ContentSource;
  readonly loadMembers?: MembersLoader;
  /** Called after a reveal is written locally (feature 18 logs reveals made from Session Mode). */
  readonly onRevealed?: (handoutId: string) => void;
}) {
  const { source } = props;
  const data = useContentData(source);
  const gm = mayShowRevealControls(data.role);
  const members = useMembers(source.campaignId, gm, props.loadMembers ?? loadCurrentMembers);
  const handouts = handoutsOf(data.entities);
  const delivery = useDelivery(source, gm ? handouts : []);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = handouts.find((record) => record.id === selectedId);

  return (
    <section aria-label="Handouts" data-handouts-loaded={data.loaded}>
      <h2>Handouts</h2>
      {gm && <NewHandoutForm source={source} onCreated={setSelectedId} />}
      <HandoutListView
        handouts={handouts}
        members={members ?? []}
        delivery={delivery}
        gm={gm}
        {...(selectedId === undefined ? {} : { selectedId })}
        onSelect={setSelectedId}
      />
      {selected !== undefined &&
        (gm ? (
          <HandoutPreview
            key={selected.id}
            record={selected}
            campaignId={source.campaignId}
            canAttach={true}
          >
            <RevealPanel
              record={selected}
              {...(members === undefined ? {} : { members })}
              delivery={delivery.get(selected.id)}
              onChange={async (change) => {
                const written = await source.entities.changeVisibility(
                  selected.id,
                  change,
                  selected.version,
                );
                if (written.ok && change.operation === 'reveal') props.onRevealed?.(selected.id);
                return written;
              }}
            />
          </HandoutPreview>
        ) : (
          <HandoutPreview
            key={selected.id}
            record={selected}
            campaignId={source.campaignId}
            canAttach={false}
          />
        ))}
    </section>
  );
}

function NewHandoutForm(props: {
  readonly source: ContentSource;
  readonly onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await props.source.entities.create({
      type: HANDOUT_ENTITY_TYPE,
      name: title,
      description: body,
    });
    if (!created.ok) {
      setError(contentErrorMessage(created.error));
      return;
    }
    setTitle('');
    setBody('');
    setError(undefined);
    props.onCreated(created.value.id);
  }

  return (
    <form aria-label="New handout" onSubmit={(event) => void submit(event)}>
      <label>
        Handout title <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        Handout text
        <textarea value={body} rows={4} onChange={(event) => setBody(event.target.value)} />
      </label>
      <button type="submit">Prepare handout</button>
      <p>New handouts are hidden until you reveal them.</p>
      {error !== undefined && <p role="alert">{error}</p>}
    </form>
  );
}

export function HandoutListView(props: {
  readonly handouts: readonly EntityRecord[];
  readonly members: readonly MemberLike[];
  readonly delivery: ReadonlyMap<string, DeliveryState>;
  readonly gm: boolean;
  readonly selectedId?: string;
  readonly onSelect: (id: string) => void;
}) {
  if (props.handouts.length === 0) {
    return <p>{props.gm ? 'No handouts prepared yet.' : 'No handouts yet.'}</p>;
  }
  return (
    <ul aria-label="Handout list">
      {props.handouts.map((record) => {
        const waiting = props.delivery.get(record.id) === 'waiting';
        return (
          <li
            key={record.id}
            data-handout-id={record.id}
            data-handout-audience={record.visibility.mode}
          >
            <button
              type="button"
              aria-pressed={props.selectedId === record.id}
              onClick={() => props.onSelect(record.id)}
            >
              {record.name}
            </button>
            {props.gm && (
              <span data-testid="handout-audience">
                {' '}
                {audienceText(audienceOf(record, props.members))}
                {waiting ? ' · waiting to send' : ''}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** What a recipient sees (FR-003: the GM's preview is the same view). */
export function HandoutPreview(props: {
  readonly record: EntityRecord;
  readonly campaignId: string;
  readonly canAttach: boolean;
  readonly children?: ReactNode;
}) {
  const { record } = props;
  return (
    <article aria-label={`Handout ${record.name}`} data-handout-id={record.id}>
      <h3>{record.name}</h3>
      {record.description === '' ? (
        <p>No text.</p>
      ) : (
        <PlainText text={record.description} testId="handout-text" />
      )}
      <EntityAttachments
        campaignId={props.campaignId}
        entityId={record.id}
        visibility={attachmentVisibilityFor(record.type, record.visibility)}
        canAttach={props.canAttach}
      />
      {props.children}
    </article>
  );
}

export function RevealPanel(props: {
  readonly record: EntityRecord;
  readonly members?: readonly MemberLike[];
  readonly delivery: DeliveryState;
  readonly onChange: (
    change: EntityVisibilityChange,
  ) => Promise<{ readonly ok: boolean; readonly error?: unknown }>;
}) {
  const { record } = props;
  const members = props.members ?? [];
  const [choice, setChoice] = useState<RevealChoice>({ kind: 'players', playerIds: [] });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const candidates = revealCandidates(record, members);
  const label = confirmLabel(choice, members);
  const hidden = record.visibility.mode === 'gm_only';
  const everyone = record.visibility.mode === 'everyone';
  const message = deliveryText(props.delivery);

  async function run(change: EntityVisibilityChange) {
    setBusy(true);
    const result = await props.onChange(change);
    setBusy(false);
    if (!result.ok) {
      setError('This change could not be queued. Nothing was revealed.');
      return;
    }
    setError(undefined);
    setChoice({ kind: 'players', playerIds: [] });
  }

  const toggle = (playerId: string) =>
    setChoice((current) => {
      const ids = current.kind === 'players' ? current.playerIds : [];
      return {
        kind: 'players',
        playerIds: ids.includes(playerId)
          ? ids.filter((id) => id !== playerId)
          : [...ids, playerId],
      };
    });

  return (
    <section aria-labelledby={titleId} data-reveal-panel={record.id}>
      <h4 id={titleId}>Reveal</h4>
      <p data-testid="handout-recipients">{audienceText(audienceOf(record, members))}</p>
      {message !== undefined && (
        <p role="status" data-delivery={props.delivery}>
          {message}
        </p>
      )}
      {record.visibility.mode === 'party' ? (
        <p>{PARTY_UNAVAILABLE}</p>
      ) : (
        !everyone && (
          <fieldset>
            <legend>Recipients</legend>
            <label>
              <input
                type="radio"
                name={`${record.id}-audience`}
                checked={choice.kind === 'everyone'}
                onChange={() => setChoice({ kind: 'everyone' })}
              />{' '}
              Everyone
            </label>
            {props.members === undefined ? (
              <p>The player list needs a connection. You can still reveal to everyone.</p>
            ) : (
              candidates.map((player) => (
                <label key={player.id}>
                  <input
                    type="checkbox"
                    checked={choice.kind === 'players' && choice.playerIds.includes(player.id)}
                    onChange={() => toggle(player.id)}
                  />{' '}
                  {player.username}
                </label>
              ))
            )}
            <button
              type="button"
              disabled={busy || label === undefined}
              onClick={() => void run(revealChange(choice))}
            >
              {label ?? 'Choose who receives it'}
            </button>
          </fieldset>
        )
      )}
      {!hidden && record.visibility.mode !== 'party' && (
        <div>
          <p>{UNREVEAL_NOTE}</p>
          <button type="button" disabled={busy} onClick={() => void run(HIDE_CHANGE)}>
            Hide again
          </button>
        </div>
      )}
      {error !== undefined && <p role="alert">{error}</p>}
    </section>
  );
}
