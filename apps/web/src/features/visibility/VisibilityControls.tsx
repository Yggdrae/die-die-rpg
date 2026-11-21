import type { Visibility } from '@rpg/contracts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  loadCurrentMembers,
  submitVisibilityChange,
  type VisibilityTarget,
} from './visibility-api.ts';
import {
  audienceLabel,
  type MemberLike,
  mayShowRevealControls,
  outcomeMessage,
  PARTY_UNAVAILABLE,
  recipientsOf,
  requestFor,
  revealablePlayers,
  UNREVEAL_LIMITATION,
  type VisibilityIntent,
} from './visibility-model.ts';

export type PanelStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'notice'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }
  /** `reloaded` is true once the host has refetched the record, which enables Retry. */
  | { readonly kind: 'conflict'; readonly reloaded: boolean };

export type MembersState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly members: readonly MemberLike[] };

export interface VisibilityPanelProps {
  readonly visibility: Visibility;
  readonly members: MembersState;
  readonly selected: ReadonlySet<string>;
  readonly status: PanelStatus;
  readonly busy: boolean;
  readonly onToggle: (playerId: string) => void;
  readonly onIntent: (intent: VisibilityIntent) => void;
  readonly onReload: () => void;
  readonly onRetry: () => void;
}

/** Presentational panel. Holds no state, so every state can be rendered and tested directly. */
export function VisibilityPanel(props: VisibilityPanelProps) {
  const { visibility, members, status, busy } = props;
  const memberList = members.kind === 'ready' ? members.members : [];
  const candidates = revealablePlayers(memberList);
  const recipients = recipientsOf(visibility, memberList);
  const everyone = visibility.mode === 'everyone';
  const hidden = visibility.mode === 'gm_only';
  // Several panels can share a page (an entity and each of its relationships).
  const titleId = useId();

  return (
    <section aria-labelledby={titleId} data-visibility-mode={visibility.mode}>
      <h3 id={titleId}>Who can see this</h3>
      <p data-testid="visibility-current">
        Currently visible to: <strong>{audienceLabel(visibility)}</strong>
      </p>

      {visibility.mode === 'party' ? (
        <p data-testid="visibility-party-unavailable">{PARTY_UNAVAILABLE}</p>
      ) : (
        <>
          {recipients.length > 0 && (
            <ul aria-label="Players who can see this">
              {recipients.map((recipient) => (
                <li key={recipient.id}>
                  {recipient.label}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Remove ${recipient.label}`}
                    onClick={() =>
                      props.onIntent({ kind: 'unreveal_players', playerIds: [recipient.id] })
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <fieldset disabled={busy || everyone}>
            <legend>Reveal to players</legend>
            {members.kind === 'loading' && <p>Loading members.</p>}
            {members.kind === 'unavailable' && (
              <p role="alert">Members could not be loaded, so players cannot be chosen.</p>
            )}
            {members.kind === 'ready' && candidates.length === 0 && (
              <p>No players in this campaign yet.</p>
            )}
            {candidates.map((candidate) => (
              <label key={candidate.id} style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  checked={props.selected.has(candidate.id)}
                  onChange={() => props.onToggle(candidate.id)}
                />{' '}
                {candidate.username}
              </label>
            ))}
            <button
              type="button"
              disabled={busy || everyone || props.selected.size === 0}
              onClick={() =>
                props.onIntent({ kind: 'reveal_players', playerIds: [...props.selected] })
              }
            >
              Reveal to selected players
            </button>
          </fieldset>

          {everyone && <p>Already visible to everyone in the campaign.</p>}
          {!everyone && (
            <button
              type="button"
              disabled={busy}
              onClick={() => props.onIntent({ kind: 'reveal_everyone' })}
            >
              Reveal to everyone
            </button>
          )}
          {!hidden && (
            <button
              type="button"
              disabled={busy}
              onClick={() => props.onIntent({ kind: 'hide_everyone' })}
            >
              Hide from everyone
            </button>
          )}
          {!hidden && <p data-testid="visibility-unreveal-note">{UNREVEAL_LIMITATION}</p>}
        </>
      )}

      <div aria-live="polite">
        {status.kind === 'notice' && <p role="status">{status.message}</p>}
        {status.kind === 'error' && <p role="alert">{status.message}</p>}
        {status.kind === 'conflict' && (
          <div role="alert" data-testid="visibility-conflict">
            <p>
              This record changed since you opened it, so your change was not applied. Reload to see
              who can see it now, then retry if you still want the change.
            </p>
            <button type="button" disabled={busy} onClick={props.onReload}>
              Reload
            </button>
            <button type="button" disabled={busy || !status.reloaded} onClick={props.onRetry}>
              Retry my change
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export interface VisibilityControlsProps extends VisibilityTarget {
  readonly visibility: Visibility;
  /** Version of the record the host last loaded; sent as `expectedVersion`. */
  readonly version: number;
  /** The viewer's role, for showing the controls only. The server decides every change. */
  readonly viewerRole?: string;
  /** Called with the server's normalized result so the host can update its record. */
  readonly onChanged: (result: {
    readonly visibility: Visibility;
    readonly version: number;
  }) => void;
  /** Host refetches the record; the new `visibility` and `version` arrive through props. */
  readonly onReload: () => Promise<void>;
  /** Optional member list from the host; otherwise the current members are loaded. */
  readonly members?: readonly MemberLike[];
}

/** Generic reveal / un-reveal controls for any Resource Class. Renders nothing for non-GM roles. */
export function VisibilityControls(props: VisibilityControlsProps) {
  const { campaignId, resourceClass, resourceId } = props;
  const [loaded, setLoaded] = useState<MembersState>({ kind: 'loading' });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<PanelStatus>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const pending = useRef<VisibilityIntent | undefined>(undefined);
  const visible = mayShowRevealControls(props.viewerRole);
  const hostMembers = props.members;

  const refreshMembers = useCallback(async () => {
    try {
      setLoaded({ kind: 'ready', members: await loadCurrentMembers(campaignId) });
    } catch {
      setLoaded({ kind: 'unavailable' });
    }
  }, [campaignId]);

  useEffect(() => {
    if (visible && hostMembers === undefined) void refreshMembers();
  }, [visible, hostMembers, refreshMembers]);

  const run = useCallback(
    async (intent: VisibilityIntent) => {
      setBusy(true);
      pending.current = intent;
      const outcome = await submitVisibilityChange(
        { campaignId, resourceClass, resourceId },
        requestFor(intent, props.version),
      );
      setBusy(false);
      if (outcome.kind === 'applied') {
        pending.current = undefined;
        setSelected(new Set());
        props.onChanged({ visibility: outcome.visibility, version: outcome.version });
        setStatus({
          kind: 'notice',
          message: !outcome.changed
            ? 'Already revealed to that audience. Nothing changed.'
            : outcome.visibility.mode === 'gm_only'
              ? 'Hidden. No one else can see this now.'
              : 'Visibility updated.',
        });
      } else if (outcome.kind === 'conflict') {
        setStatus({ kind: 'conflict', reloaded: false });
      } else {
        if (outcome.kind === 'rejected' && outcome.reason === 'target_not_member') {
          setSelected(new Set());
          if (hostMembers === undefined) void refreshMembers();
        }
        setStatus({ kind: 'error', message: outcomeMessage(outcome) });
      }
    },
    [
      campaignId,
      resourceClass,
      resourceId,
      props.version,
      props.onChanged,
      hostMembers,
      refreshMembers,
    ],
  );

  async function reload() {
    setBusy(true);
    try {
      await Promise.all([
        props.onReload(),
        hostMembers === undefined ? refreshMembers() : undefined,
      ]);
      setStatus({ kind: 'conflict', reloaded: true });
    } catch {
      setStatus({ kind: 'error', message: 'The record could not be reloaded. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;
  const members: MembersState =
    hostMembers === undefined ? loaded : { kind: 'ready', members: hostMembers };
  return (
    <VisibilityPanel
      visibility={props.visibility}
      members={members}
      selected={selected}
      status={status}
      busy={busy}
      onToggle={(playerId) =>
        setSelected((current) => {
          const next = new Set(current);
          if (!next.delete(playerId)) next.add(playerId);
          return next;
        })
      }
      onIntent={(intent) => {
        setStatus({ kind: 'idle' });
        void run(intent);
      }}
      onReload={() => void reload()}
      onRetry={() => {
        const intent = pending.current;
        if (intent === undefined) return;
        setStatus({ kind: 'idle' });
        void run(intent);
      }}
    />
  );
}
