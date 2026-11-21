import { HANDOUT_ENTITY_TYPE } from '@rpg/content';
import type { SessionQuickAction } from '@rpg/contracts';
import {
  type ContextEntity,
  initialParticipants,
  type LogLine,
  provisionalNumber,
  type SessionChange,
  type SessionRecord,
  sceneContext,
  scenesOf,
  sessionLog,
} from '@rpg/sessions';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { ConflictSurface } from '../sync/SyncStatus.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import {
  availableActions,
  gmOnlyLine,
  logLineText,
  type PaletteEntry,
  type PaletteProvider,
  paletteEntries,
  statusLabel,
  timeText,
} from './session-model.ts';
import type { PartyMember, SessionSource } from './session-source.ts';
import { type SessionData, useSessionData } from './useSessionData.ts';

/**
 * Feature 18 Session Mode (`PRD.md` s.44): one screen for the GM (party, current scene, quick actions, GM notes,
 * the log) and a different, smaller view for players (D-13). Quick actions arrive from the app shell (D-11); this
 * feature never imports the features that contribute them.
 */
export function SessionWorkspace(props: {
  readonly source: SessionSource;
  readonly quickActions?: readonly SessionQuickAction[];
  /** D-12: palette providers from the app shell (feature 20 search); never imported here. */
  readonly paletteProviders?: readonly PaletteProvider[];
}) {
  const { source } = props;
  const data = useSessionData(source);
  const [error, setError] = useState<string>();
  const [lookup, setLookup] = useState<string>();
  const [palette, setPalette] = useState(false);
  const gm = data.mayRun;
  const open = data.open;
  const actions = availableActions(props.quickActions ?? [], data.capabilities);

  const report = (failure: { readonly code: string } | undefined) =>
    setError(failure === undefined ? undefined : `Not saved (${failure.code}).`);

  const change = useCallback(
    async (session: SessionRecord, next: SessionChange) => {
      const result = await source.sessions.change(session.id, next);
      setError(result.ok ? undefined : `Not saved (${result.error.code}).`);
    },
    [source],
  );

  const invoke = useCallback(
    (action: SessionQuickAction, session: SessionRecord) => {
      if (data.role === undefined) return;
      void action.invoke({
        actor: { userId: source.userId, campaignId: source.campaignId, role: data.role },
        sessionId: session.id,
      });
    },
    [data.role, source],
  );

  // `Ctrl + K` / `Cmd + K` opens the palette while a GM runs a session.
  useEffect(() => {
    if (!gm || open === undefined) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gm, open]);

  const runEntry = (entry: PaletteEntry) => {
    if (open === undefined) return;
    const run = entry.run;
    switch (run.kind) {
      case 'quick':
        invoke(run.action, open);
        return;
      case 'pause':
      case 'resume':
      case 'end':
        void change(open, { kind: run.kind });
        return;
      case 'scene':
        void change(open, { kind: 'scene', sceneId: run.sceneId });
        return;
      case 'lookup':
        setLookup(run.entityId);
        return;
      case 'note':
        void source.log.addNote(open.id, run.text, false).then((result) => {
          report(result.ok ? undefined : result.error);
        });
        return;
      case 'provided':
        // A record the session holds opens in the lookup panel, so the GM stays on the session screen.
        if (
          run.subjectId !== undefined &&
          data.entities.some(
            (entity) => entity.id === run.subjectId && entity.deletedAt === undefined,
          )
        ) {
          setLookup(run.subjectId);
          return;
        }
        run.open?.();
    }
  };

  if (!data.loaded) {
    return (
      <section aria-label="Session Mode" data-session-loaded="false">
        <h2>Session Mode</h2>
      </section>
    );
  }

  return (
    <section aria-label="Session Mode" data-session-loaded="true">
      {error !== undefined && <p role="alert">{error}</p>}
      {gm ? (
        open === undefined ? (
          <NoSessionView
            data={data}
            onStart={async () => {
              const started = await source.sessions.start(
                initialParticipants(
                  source.userId,
                  data.party.map((member) => ({ ownerUserId: member.ownerUserId })),
                ),
              );
              report(started.ok ? undefined : started.error);
            }}
          />
        ) : (
          <GmSessionView
            data={data}
            session={open}
            actions={actions}
            {...(lookup === undefined ? {} : { lookupId: lookup })}
            onChange={(next) => void change(open, next)}
            onInvoke={(action) => invoke(action, open)}
            onPalette={() => setPalette(true)}
            onCloseLookup={() => setLookup(undefined)}
            onSaveNotes={async (body) => {
              const saved = await source.notes.save(open.id, body, data.notes?.version ?? null);
              report(saved.ok ? undefined : saved.error);
              return saved.ok;
            }}
            onAddNote={async (text, shown) => {
              const added = await source.log.addNote(open.id, text, shown);
              report(added.ok ? undefined : added.error);
              return added.ok;
            }}
          />
        )
      ) : (
        <PlayerSessionView data={data} userId={source.userId} />
      )}
      {gm && (
        <ConflictSurface
          conflicts={data.conflicts}
          onDefer={() => undefined}
          onKeepAuthority={(id) => {
            const conflict = data.conflicts.find((item) => item.conflictId === id);
            if (conflict !== undefined) void source.resolveConflict(conflict, 'keep_authority');
          }}
          onResubmitMine={(id) => {
            const conflict = data.conflicts.find((item) => item.conflictId === id);
            if (conflict !== undefined) void source.resolveConflict(conflict, 'resubmit');
          }}
        />
      )}
      {palette && open !== undefined && (
        <CommandPalette
          entries={paletteEntries({
            session: open,
            actions,
            entities: data.entities,
            lookups: (props.paletteProviders ?? []).length === 0,
          })}
          {...(props.paletteProviders === undefined ? {} : { providers: props.paletteProviders })}
          onRun={runEntry}
          onClose={() => setPalette(false)}
        />
      )}
    </section>
  );
}

function names(entities: readonly ContextEntity[]): ReadonlyMap<string, string> {
  return new Map(entities.map((entity) => [entity.id, entity.name]));
}

function linesOf(data: SessionData, session: SessionRecord): LogLine[] {
  return sessionLog({
    session,
    entries: data.entries,
    rolls: data.rolls,
    effects: data.effects,
  });
}

export function NoSessionView(props: {
  readonly data: Pick<SessionData, 'sessions'>;
  readonly onStart: () => void;
}) {
  const next = provisionalNumber(props.data.sessions);
  return (
    <>
      <h2>Session Mode</h2>
      <p>No session in progress.</p>
      <button type="button" onClick={props.onStart}>
        Start session {next}
      </button>
      {props.data.sessions.length > 0 && (
        <section aria-label="Past sessions">
          <h3>Past sessions</h3>
          <ul>
            {props.data.sessions.map((session) => (
              <li key={session.id}>
                {session.name}, {statusLabel(session.status).toLowerCase()}
                {session.endedAt === undefined
                  ? ''
                  : ` ${new Date(session.endedAt).toLocaleDateString()}`}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Region(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section aria-label={props.label}>
      <h3>{props.label}</h3>
      {props.children}
    </section>
  );
}

function Summary(props: { readonly member: PartyMember }) {
  return (
    <>
      <strong>{props.member.name}</strong>
      {props.member.summary.map((value) => (
        <span key={value.key} data-summary={value.key}>
          {' '}
          {value.label} {value.text}
        </span>
      ))}
    </>
  );
}

function LogList(props: {
  readonly lines: readonly LogLine[];
  readonly names: ReadonlyMap<string, string>;
}) {
  if (props.lines.length === 0) return <p>Nothing logged yet.</p>;
  return (
    <ol data-testid="session-log">
      {props.lines.map((line) => (
        <li key={`${line.kind}:${line.id}`} data-log-kind={line.kind}>
          <small>{timeText(line.at)}</small> {logLineText(line, props.names)}
          {gmOnlyLine(line) && <small> (GM only)</small>}
        </li>
      ))}
    </ol>
  );
}

export function GmSessionView(props: {
  readonly data: SessionData;
  readonly session: SessionRecord;
  readonly actions: readonly SessionQuickAction[];
  readonly lookupId?: string;
  readonly onChange: (change: SessionChange) => void;
  readonly onInvoke: (action: SessionQuickAction) => void;
  readonly onPalette: () => void;
  readonly onCloseLookup: () => void;
  readonly onSaveNotes: (body: string) => Promise<boolean>;
  readonly onAddNote: (text: string, shown: boolean) => Promise<boolean>;
}) {
  const { data, session } = props;
  const [confirmEnd, setConfirmEnd] = useState(false);
  const scenes = scenesOf(data.entities);
  const context = sceneContext(session.currentSceneId, data.entities, data.relationships);
  const lookup = data.entities.find((entity) => entity.id === props.lookupId);
  const known = names(data.entities);

  return (
    <>
      <header>
        <h2>{session.name}</h2>
        <p role="status" data-session-status={session.status}>
          {statusLabel(session.status)} since {timeText(session.startedAt)}
        </p>
        {session.status === 'active' ? (
          <button type="button" onClick={() => props.onChange({ kind: 'pause' })}>
            Pause
          </button>
        ) : (
          <button type="button" onClick={() => props.onChange({ kind: 'resume' })}>
            Resume
          </button>
        )}{' '}
        {confirmEnd ? (
          <button
            type="button"
            onClick={() => {
              setConfirmEnd(false);
              props.onChange({ kind: 'end' });
            }}
          >
            Confirm end of {session.name}
          </button>
        ) : (
          <button type="button" onClick={() => setConfirmEnd(true)}>
            End session
          </button>
        )}{' '}
        <button type="button" onClick={props.onPalette} aria-keyshortcuts="Control+K">
          Command palette (Ctrl+K)
        </button>
      </header>

      <Region label="Party">
        {data.party.length === 0 ? (
          <p>No characters yet.</p>
        ) : (
          <ul>
            {data.party.map((member) => {
              const present = session.participantUserIds.includes(member.ownerUserId);
              return (
                <li key={member.id} data-party-member={member.id}>
                  <Summary member={member} />{' '}
                  <label>
                    <input
                      type="checkbox"
                      checked={present}
                      onChange={() =>
                        props.onChange({
                          kind: 'present',
                          userId: member.ownerUserId,
                          present: !present,
                        })
                      }
                    />
                    Present
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Region>

      <Region label="Current scene">
        <label>
          Scene{' '}
          <select
            value={session.currentSceneId ?? ''}
            onChange={(event) =>
              props.onChange({
                kind: 'scene',
                sceneId: event.target.value === '' ? undefined : event.target.value,
              })
            }
          >
            <option value="">No scene</option>
            {scenes.map((scene) => (
              <option key={scene.id} value={scene.id}>
                {scene.name}
              </option>
            ))}
          </select>
        </label>
        <SceneDetails context={context} />
      </Region>

      <Region label="Quick actions">
        {props.actions.length === 0 ? (
          <p>No quick actions are installed.</p>
        ) : (
          props.actions.map((action) => (
            <button key={action.id} type="button" onClick={() => props.onInvoke(action)}>
              {action.label}
            </button>
          ))
        )}
      </Region>

      <NotesEditor
        key={session.id}
        saved={data.notes?.body ?? ''}
        version={data.notes?.version}
        onSave={props.onSaveNotes}
      />

      <Region label="Session log">
        <LogNoteForm onAdd={props.onAddNote} />
        <LogList lines={linesOf(data, session)} names={known} />
      </Region>

      {lookup !== undefined && (
        <section aria-label="Lookup">
          <h3>{lookup.name}</h3>
          <p>
            <small>{lookup.type}</small>
          </p>
          {lookup.summary !== '' && <p>{lookup.summary}</p>}
          <button type="button" onClick={props.onCloseLookup}>
            Close lookup
          </button>
        </section>
      )}
    </>
  );
}

function SceneDetails(props: { readonly context: ReturnType<typeof sceneContext> }) {
  const { scene, locations, present } = props.context;
  if (scene === undefined) return <p>No current scene.</p>;
  if (scene === 'unavailable') return <p>The current scene is not available on this device.</p>;
  return (
    <div data-testid="current-scene">
      <h4>{scene.name}</h4>
      {scene.summary !== '' && <p>{scene.summary}</p>}
      {locations.length > 0 && <p>Location: {locations.map((item) => item.name).join(', ')}</p>}
      {present.length > 0 && (
        <>
          <h5>NPCs</h5>
          <ul aria-label="NPCs in the scene">
            {present.map((item) => (
              <li key={item.id}>
                {item.name}
                {item.summary === '' ? '' : ` — ${item.summary}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function NotesEditor(props: {
  readonly saved: string;
  readonly version: number | undefined;
  readonly onSave: (body: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(props.saved);
  const [dirty, setDirty] = useState(false);
  // A newer saved body (another GM, a resolved conflict) replaces the text only while nothing is typed.
  useEffect(() => {
    if (!dirty) setDraft(props.saved);
  }, [props.saved, dirty]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await props.onSave(draft)) setDirty(false);
  }

  return (
    <section aria-label="GM notes">
      <h3>GM notes</h3>
      <form onSubmit={submit}>
        <textarea
          aria-label="GM notes text"
          rows={6}
          value={draft}
          maxLength={20_000}
          onChange={(event) => {
            setDraft(event.target.value);
            setDirty(true);
          }}
        />
        <button type="submit" disabled={!dirty}>
          Save notes
        </button>{' '}
        <small role="status">
          {dirty ? 'Unsaved changes' : props.version === undefined ? 'Empty' : 'Saved'}
        </small>
      </form>
    </section>
  );
}

function LogNoteForm(props: {
  readonly onAdd: (text: string, shown: boolean) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [shown, setShown] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await props.onAdd(text, shown)) {
      setText('');
      setShown(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <label>
        Log note{' '}
        <input value={text} maxLength={500} onChange={(event) => setText(event.target.value)} />
      </label>{' '}
      <label>
        <input type="checkbox" checked={shown} onChange={() => setShown(!shown)} />
        Show to players
      </label>{' '}
      <button type="submit" disabled={text.trim() === ''}>
        Add to log
      </button>
    </form>
  );
}

/** D-13: what a player's device holds, and nothing else: no GM control is rendered. */
export function PlayerSessionView(props: { readonly data: SessionData; readonly userId: string }) {
  const { data } = props;
  const session = data.open ?? data.sessions[0];
  const own = data.party.filter((member) => member.ownerUserId === props.userId);
  const handouts = data.entities.filter(
    (entity) => entity.type === HANDOUT_ENTITY_TYPE && entity.deletedAt === undefined,
  );
  if (session === undefined) {
    return (
      <>
        <h2>Session Mode</h2>
        <p>No session yet.</p>
      </>
    );
  }
  const context = sceneContext(session.currentSceneId, data.entities, data.relationships);
  return (
    <>
      <h2>{session.name}</h2>
      <p role="status" data-session-status={session.status}>
        {statusLabel(session.status)}
      </p>
      <Region label="Current scene">
        <SceneDetails
          context={context.scene === 'unavailable' ? { ...context, scene: undefined } : context}
        />
      </Region>
      <Region label="Your character">
        {own.length === 0 ? (
          <p>No character yet.</p>
        ) : (
          <ul>
            {own.map((member) => (
              <li key={member.id}>
                <Summary member={member} />
              </li>
            ))}
          </ul>
        )}
      </Region>
      <Region label="Revealed handouts">
        {handouts.length === 0 ? (
          <p>Nothing revealed yet.</p>
        ) : (
          <ul>
            {handouts.map((handout) => (
              <li key={handout.id}>{handout.name}</li>
            ))}
          </ul>
        )}
      </Region>
      <Region label="Session log">
        <LogList lines={linesOf(data, session)} names={names(data.entities)} />
      </Region>
    </>
  );
}
