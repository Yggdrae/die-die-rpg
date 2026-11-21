import type { LocalContentError } from '@rpg/content';
import type { Result } from '@rpg/contracts';
import type { LongTextHold } from '@rpg/sync';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HoldRenewalController } from '../sync/hold-client.ts';
import { contentErrorMessage } from './content-model.ts';
import type { ContentSource } from './content-source.ts';
import type { DraftKey } from './draft-store.ts';
import type { HoldField } from './hold-api.ts';

/**
 * Single-writer long text (FR-006, D-10, D-17): a plain-text Markdown textarea that can save only
 * under a current feature 03 hold. Everything typed is also kept in the device draft store, so a
 * lost hold (takeover, expiry), an offline session, or a reload never loses text; the draft is
 * cleared only by a successful held save, an explicit discard, or the feature 03 purge
 * (revocation, campaign deletion, sign-out). A draft is never queued.
 */

export type LockState =
  | { readonly kind: 'acquiring' }
  | { readonly kind: 'held'; readonly hold: LongTextHold }
  | { readonly kind: 'busy' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'lost' };

export const LOCK_MESSAGES: Readonly<Record<LockState['kind'], string>> = {
  acquiring: 'Getting the editing lock…',
  held: 'You are editing. Others cannot change this text until you save or close.',
  busy: 'Someone else is editing this text right now. You can take over.',
  offline:
    'Offline or the server is unreachable. Your text is kept on this device as a draft and is not sent. Reconnect to get the editing lock, then save.',
  lost: 'Another editor took over this text (or your lock expired). Your unsaved text is kept on this device as a draft.',
};

export interface LongTextEditorProps {
  readonly source: ContentSource;
  readonly field: HoldField;
  readonly label: string;
  /** The stored text (local replica). */
  readonly text: string;
  /** The record's current local version (the save's expected version). */
  readonly version: number;
  readonly save: (
    text: string,
    hold: { readonly expectedVersion: number; readonly holdVersion: number },
  ) => Promise<Result<unknown, LocalContentError>>;
}

export function LongTextEditor(props: LongTextEditorProps) {
  const { source, field } = props;
  const key: DraftKey = { campaignId: source.campaignId, ...field };
  const [editing, setEditing] = useState(false);
  // Read on every render: a held save clears the draft once the authority accepted it.
  const hasDraft = source.drafts.get(key) !== undefined;
  const open = useCallback(() => setEditing(true), []);
  if (!editing) {
    return (
      <div data-long-text={field.fieldPath}>
        <button type="button" onClick={open}>
          Edit {props.label.toLowerCase()}
        </button>
        {hasDraft && <small> You have an unsaved draft on this device.</small>}
      </div>
    );
  }
  return <LongTextSession {...props} draftKey={key} onClose={() => setEditing(false)} />;
}

function LongTextSession(
  props: LongTextEditorProps & { readonly draftKey: DraftKey; readonly onClose: () => void },
) {
  const { source, draftKey } = props;
  const { resourceClass, recordId, fieldPath } = props.field;
  const field = useMemo<HoldField>(
    () => ({ resourceClass, recordId, fieldPath }),
    [resourceClass, recordId, fieldPath],
  );
  const initialDraft = useRef(source.drafts.get(draftKey));
  const [text, setText] = useState(initialDraft.current?.text ?? props.text);
  const [lock, setLock] = useState<LockState>({ kind: 'acquiring' });
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const lockRef = useRef<LockState>(lock);
  const renewal = useRef(new HoldRenewalController());

  const changeLock = useCallback((next: LockState) => {
    lockRef.current = next;
    setLock(next);
    if (next.kind !== 'held') renewal.current.stop();
  }, []);

  const hold = useCallback(
    (held: LongTextHold) => {
      changeLock({ kind: 'held', hold: held });
      renewal.current.start(
        async () => {
          const current = lockRef.current;
          if (current.kind !== 'held') return undefined;
          const renewed = await source.holds.renew(source.campaignId, field, current.hold.version);
          if (renewed.kind === 'held') return renewed.hold;
          // Unreachable is not a loss: keep the lock state until a save proves otherwise.
          if (renewed.kind === 'unavailable') return current.hold;
          return undefined;
        },
        () => changeLock({ kind: 'lost' }),
      );
    },
    [changeLock, source, field],
  );

  const claim = useCallback(
    async (action: 'acquire' | 'takeover') => {
      changeLock({ kind: 'acquiring' });
      const outcome =
        action === 'acquire'
          ? await source.holds.acquire(source.campaignId, field)
          : await source.holds.takeover(source.campaignId, field);
      if (outcome.kind === 'held') hold(outcome.hold);
      else changeLock({ kind: outcome.kind === 'busy' ? 'busy' : 'offline' });
    },
    [changeLock, hold, source, field],
  );

  // Acquire on open; give the lock back on close.
  useEffect(() => {
    void claim('acquire');
    const controller = renewal.current;
    return () => {
      controller.stop();
      const current = lockRef.current;
      if (current.kind === 'held') {
        void source.holds.release(source.campaignId, field, current.hold.version);
      }
    };
  }, [claim, source, field]);

  // Reconnect: an offline editor asks for the lock again.
  useEffect(() => {
    if (typeof globalThis.addEventListener !== 'function') return;
    const online = () => {
      if (lockRef.current.kind === 'offline') void claim('acquire');
    };
    globalThis.addEventListener('online', online);
    return () => globalThis.removeEventListener('online', online);
  }, [claim]);

  // A replicated hold with a newer version means someone else holds the field now (takeover).
  useEffect(
    () =>
      source.subscribe(() => {
        const current = lockRef.current;
        if (current.kind !== 'held') return;
        void source.replicatedHold(field).then((replicated) => {
          const still = lockRef.current;
          if (
            still.kind === 'held' &&
            replicated !== undefined &&
            replicated.version > still.hold.version
          ) {
            changeLock({ kind: 'lost' });
          }
        });
      }),
    [source, field, changeLock],
  );

  function edit(next: string) {
    setText(next);
    source.drafts.put(draftKey, next);
  }

  async function save() {
    const current = lockRef.current;
    if (current.kind !== 'held' || busy) return;
    setBusy(true);
    setMessage(undefined);
    source.drafts.put(draftKey, text);
    // The hold must still be ours at save time (a takeover is noticed here at the latest).
    const renewed = await source.holds.renew(source.campaignId, field, current.hold.version);
    if (renewed.kind !== 'held') {
      changeLock({ kind: renewed.kind === 'lost' ? 'lost' : 'offline' });
      setBusy(false);
      return;
    }
    const saved = await props.save(text, {
      expectedVersion: props.version,
      holdVersion: renewed.hold.version,
    });
    setBusy(false);
    if (!saved.ok) {
      setMessage(`${contentErrorMessage(saved.error)} Your text is kept as a draft.`);
      return;
    }
    // The hold stays ours until the queued write has reached the authority (it checks the hold
    // then); the draft is dropped only once the write is accepted.
    lockRef.current = { kind: 'acquiring' };
    renewal.current.stop();
    const savedText = text;
    void source.settleHeldWrite(field, renewed.hold.version).then((settled) => {
      if (settled === 'accepted' && source.drafts.get(draftKey)?.text === savedText) {
        source.drafts.delete(draftKey);
      }
    });
    props.onClose();
  }

  return (
    <div data-long-text={field.fieldPath} data-lock-state={lock.kind}>
      <label style={{ display: 'block' }}>
        {props.label} (Markdown, shown as plain text)
        <textarea
          rows={8}
          style={{ display: 'block', width: '100%', boxSizing: 'border-box' }}
          value={text}
          onChange={(event) => edit(event.target.value)}
        />
      </label>
      {initialDraft.current !== undefined && (
        <p data-testid="draft-restored">Restored your unsaved draft from this device.</p>
      )}
      <p role="status" data-testid="lock-status">
        {LOCK_MESSAGES[lock.kind]}
      </p>
      <button type="button" disabled={lock.kind !== 'held' || busy} onClick={() => void save()}>
        Save {props.label.toLowerCase()}
      </button>{' '}
      {(lock.kind === 'busy' || lock.kind === 'lost') && (
        <button type="button" onClick={() => void claim('takeover')}>
          Take over editing
        </button>
      )}
      {lock.kind === 'offline' && (
        <button type="button" onClick={() => void claim('acquire')}>
          Get editing lock
        </button>
      )}{' '}
      <button type="button" onClick={props.onClose}>
        Close
      </button>{' '}
      <button
        type="button"
        onClick={() => {
          source.drafts.delete(draftKey);
          props.onClose();
        }}
      >
        Discard draft
      </button>
      {message !== undefined && <p role="alert">{message}</p>}
    </div>
  );
}
