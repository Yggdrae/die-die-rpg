import type {
  AvailabilityState,
  LocalAttachment,
  OfflineAttachmentStore,
  PinPlan,
  PinProgress,
} from '@rpg/attachments/offline';
import { useCallback, useEffect, useState } from 'react';
import { formatSize, viewerKindOf } from './attachment-model.ts';

/**
 * Campaign offline availability (feature 05 task 05, FR-009–FR-011). Nothing downloads until the
 * user confirms the displayed size estimate. Local content is opened only as inert content:
 * images through `<img>` from a typed local blob (an image cannot run script), PDFs only as a
 * download (never rendered in the application origin).
 */

const LABELS: Readonly<Record<AvailabilityState, string>> = {
  cloud_only: 'Cloud only',
  cached: 'Cached',
  pinned: 'Available offline',
  downloading: 'Downloading',
  unavailable: 'Unavailable offline',
};

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'planning' }
  | { readonly kind: 'confirm'; readonly plan: PinPlan }
  | { readonly kind: 'downloading'; readonly progress: PinProgress }
  | { readonly kind: 'done'; readonly progress: PinProgress }
  | { readonly kind: 'message'; readonly text: string };

type Row = LocalAttachment & { readonly availability: AvailabilityState };

export function OfflineAttachments(props: {
  readonly campaignId: string;
  readonly store: OfflineAttachmentStore | undefined;
}) {
  const { campaignId, store } = props;
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [opened, setOpened] = useState<
    | { readonly attachmentId: string; readonly kind: 'image'; readonly url: string }
    | { readonly attachmentId: string; readonly kind: 'unavailable' }
    | undefined
  >();

  const refresh = useCallback(() => {
    if (store === undefined) return;
    store
      .list(campaignId)
      .then(setRows)
      .catch(() => setRows([]));
  }, [campaignId, store]);

  useEffect(() => {
    refresh();
    if (store === undefined) return;
    const unsubscribe = store.subscribe(refresh);
    globalThis.addEventListener('online', refresh);
    globalThis.addEventListener('offline', refresh);
    return () => {
      unsubscribe();
      globalThis.removeEventListener('online', refresh);
      globalThis.removeEventListener('offline', refresh);
    };
  }, [refresh, store]);

  useEffect(
    () => () => {
      if (opened?.kind === 'image') URL.revokeObjectURL(opened.url);
    },
    [opened],
  );

  if (store === undefined) return null;

  const estimate = async () => {
    setPhase({ kind: 'planning' });
    const result = await store.plan(campaignId).catch(() => ({ kind: 'offline' as const }));
    if (result.kind === 'offline') {
      setPhase({ kind: 'message', text: 'Connect to the network to make attachments available.' });
    } else if (result.kind === 'denied') {
      setPhase({ kind: 'message', text: 'Attachments are unavailable for this campaign.' });
    } else if (result.plan.items.length === 0) {
      setPhase({ kind: 'message', text: 'No attachments to make available offline.' });
    } else if (result.plan.download.length === 0) {
      await store.pin(result.plan);
      setPhase({
        kind: 'message',
        text: `All ${result.plan.items.length} attachments are already available offline.`,
      });
    } else {
      setPhase({ kind: 'confirm', plan: result.plan });
    }
  };

  const confirm = async (plan: PinPlan) => {
    // Best effort: ask the browser not to evict pinned bytes under storage pressure.
    void globalThis.navigator?.storage?.persist?.().catch(() => false);
    const progress = await store.pin(plan, (update) =>
      setPhase(
        update.done
          ? { kind: 'done', progress: update }
          : { kind: 'downloading', progress: update },
      ),
    );
    setPhase({ kind: 'done', progress });
  };

  const open = async (row: Row) => {
    const result = await store.openLocal(row.attachmentId);
    if (result.kind !== 'local') {
      setOpened({ attachmentId: row.attachmentId, kind: 'unavailable' });
      return;
    }
    const blob = new Blob([result.bytes.slice().buffer], { type: result.attachment.mime });
    const url = URL.createObjectURL(blob);
    if (viewerKindOf(result.attachment.mime) === 'image') {
      setOpened({ attachmentId: row.attachmentId, kind: 'image', url });
      return;
    }
    // Documents are only saved, never rendered here.
    const link = document.createElement('a');
    link.href = url;
    link.download = result.attachment.filename;
    link.rel = 'noopener';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setOpened(undefined);
  };

  return (
    <section aria-label="Offline attachments">
      <h3>Offline attachments</h3>
      {phase.kind === 'idle' || phase.kind === 'message' || phase.kind === 'done' ? (
        <button type="button" onClick={() => void estimate()}>
          Make available offline
        </button>
      ) : null}
      {phase.kind === 'planning' ? <p role="status">Estimating download size…</p> : null}
      {phase.kind === 'message' ? <p role="status">{phase.text}</p> : null}
      {phase.kind === 'confirm' ? (
        <div role="dialog" aria-label="Confirm offline download">
          <p data-estimated-bytes={phase.plan.estimatedBytes}>
            Download {phase.plan.download.length} attachment
            {phase.plan.download.length === 1 ? '' : 's'} ({formatSize(phase.plan.estimatedBytes)})
            to this device?
          </p>
          <button type="button" onClick={() => void confirm(phase.plan)}>
            Download
          </button>{' '}
          <button type="button" onClick={() => setPhase({ kind: 'idle' })}>
            Not now
          </button>
        </div>
      ) : null}
      {phase.kind === 'downloading' ? (
        <div role="status">
          <progress
            value={phase.progress.downloadedBytes}
            max={Math.max(1, phase.progress.totalBytes)}
          />{' '}
          Downloading {phase.progress.completed + phase.progress.failed} of {phase.progress.total} (
          {formatSize(phase.progress.downloadedBytes)} of {formatSize(phase.progress.totalBytes)})
        </div>
      ) : null}
      {phase.kind === 'done' ? (
        <p role="status" data-stored-bytes={phase.progress.storedBytes}>
          {phase.progress.completed} of {phase.progress.total} downloaded.
          {phase.progress.failed > 0 ? ` ${phase.progress.failed} could not be downloaded.` : ''}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul>
          {rows.map((row) => (
            <li
              key={row.attachmentId}
              data-attachment-id={row.attachmentId}
              data-availability={row.availability}
            >
              {row.filename} <small>{formatSize(row.size)}</small> — {LABELS[row.availability]}{' '}
              {row.availability !== 'cloud_only' && row.availability !== 'downloading' ? (
                <button type="button" onClick={() => void open(row)}>
                  Open {row.filename}
                </button>
              ) : null}
              {opened?.attachmentId === row.attachmentId && opened.kind === 'image' ? (
                <img
                  src={opened.url}
                  alt={row.filename}
                  draggable={false}
                  style={{ maxWidth: '100%', display: 'block' }}
                />
              ) : null}
              {opened?.attachmentId === row.attachmentId && opened.kind === 'unavailable' ? (
                <span role="status" data-attachment-state="unavailable">
                  {' '}
                  Preview unavailable.
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
