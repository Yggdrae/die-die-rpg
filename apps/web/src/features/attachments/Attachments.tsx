import type { AttachmentOwnerRef } from '@rpg/attachments';
import { useCallback, useEffect, useState } from 'react';
import {
  formatSize,
  type ListedAttachment,
  type ReadOutcome,
  viewerKindOf,
} from './attachment-model.ts';
import { listAttachments, requestRead } from './attachments-api.ts';

/**
 * Feature 05 safe viewers (task 04). Uploaded content never enters the application document:
 *
 * - images load through `<img crossorigin="anonymous">` from the storage origin. An image cannot
 *   run script, CORS satisfies the app's `Cross-Origin-Embedder-Policy: require-corp`, and no
 *   cookie or referrer is sent;
 * - PDFs are never embedded (a cross-origin frame would need COEP/CORP headers the provider does
 *   not send, and a same-origin frame would put the document in the app origin). They open as a
 *   top-level `noopener,noreferrer` navigation on the storage origin, or download.
 *
 * Every read asks the API for a fresh five-minute URL; a denial or a fault shows "unavailable".
 */

export type ReadResolver = (
  attachmentId: string,
  disposition: 'inline' | 'attachment',
) => Promise<ReadOutcome>;

export interface AttachmentPreviewProps {
  readonly attachment: ListedAttachment;
  readonly resolveRead: ReadResolver;
  /** Opens a document URL; defaults to a `noopener,noreferrer` top-level window. */
  readonly openDocument?: (url: string) => void;
}

function openSeparately(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function Unavailable() {
  return (
    <p role="status" data-attachment-state="unavailable">
      Preview unavailable.
    </p>
  );
}

export function AttachmentPreview(props: AttachmentPreviewProps) {
  const { attachment, resolveRead } = props;
  const kind = viewerKindOf(attachment.mime);
  const [image, setImage] = useState<
    | { readonly state: 'loading' }
    | { readonly state: 'ready'; readonly url: string }
    | { readonly state: 'unavailable' }
  >({ state: 'loading' });
  const [documentState, setDocumentState] = useState<'idle' | 'opening' | 'unavailable'>('idle');

  useEffect(() => {
    if (kind !== 'image') return;
    let cancelled = false;
    setImage({ state: 'loading' });
    resolveRead(attachment.attachmentId, 'inline').then((outcome) => {
      if (cancelled) return;
      setImage(
        outcome.kind === 'granted'
          ? { state: 'ready', url: outcome.url }
          : { state: 'unavailable' },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [attachment.attachmentId, kind, resolveRead]);

  const openDocument = useCallback(
    async (disposition: 'inline' | 'attachment') => {
      setDocumentState('opening');
      const outcome = await resolveRead(attachment.attachmentId, disposition);
      if (outcome.kind !== 'granted') {
        setDocumentState('unavailable');
        return;
      }
      (props.openDocument ?? openSeparately)(outcome.url);
      setDocumentState('idle');
    },
    [attachment.attachmentId, resolveRead, props.openDocument],
  );

  return (
    <figure data-attachment-id={attachment.attachmentId} data-attachment-kind={kind}>
      {kind === 'image' && image.state === 'ready' ? (
        <img
          src={image.url}
          alt={attachment.filename}
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          decoding="async"
          draggable={false}
          style={{ maxWidth: '100%' }}
          onError={() => setImage({ state: 'unavailable' })}
        />
      ) : null}
      {kind === 'image' && image.state === 'loading' ? <p role="status">Loading preview…</p> : null}
      {kind === 'image' && image.state === 'unavailable' ? <Unavailable /> : null}
      {kind === 'document' ? (
        <div>
          <button
            type="button"
            disabled={documentState === 'opening'}
            onClick={() => void openDocument('inline')}
          >
            Open {attachment.filename}
          </button>{' '}
          <button
            type="button"
            disabled={documentState === 'opening'}
            onClick={() => void openDocument('attachment')}
          >
            Download
          </button>
          {documentState === 'unavailable' ? <Unavailable /> : null}
        </div>
      ) : null}
      {kind === 'unsupported' ? <Unavailable /> : null}
      <figcaption>
        {attachment.filename} <small>{formatSize(attachment.size)}</small>
      </figcaption>
    </figure>
  );
}

export interface AttachmentListProps {
  readonly campaignId: string;
  readonly owner: AttachmentOwnerRef;
}

export function AttachmentList(props: AttachmentListProps) {
  const { campaignId } = props;
  const { resourceClass, resourceId } = props.owner;
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly items: readonly ListedAttachment[] }
    | { readonly kind: 'unavailable' }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    listAttachments(campaignId, { resourceClass, resourceId }).then((result) => {
      if (!cancelled)
        setState(result.kind === 'ok' ? { kind: 'ready', items: result.items } : result);
    });
    return () => {
      cancelled = true;
    };
  }, [campaignId, resourceClass, resourceId]);

  const resolveRead = useCallback<ReadResolver>(
    (attachmentId, disposition) => requestRead(campaignId, attachmentId, disposition),
    [campaignId],
  );

  return <AttachmentListView state={state} resolveRead={resolveRead} />;
}

export function AttachmentListView(props: {
  readonly state:
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly items: readonly ListedAttachment[] }
    | { readonly kind: 'unavailable' };
  readonly resolveRead: ReadResolver;
}) {
  const { state } = props;
  return (
    <section aria-label="Attachments">
      <h3>Attachments</h3>
      {state.kind === 'loading' ? <p role="status">Loading attachments…</p> : null}
      {state.kind === 'unavailable' ? (
        <p role="status">Attachments are unavailable right now.</p>
      ) : null}
      {state.kind === 'ready' && state.items.length === 0 ? <p>No attachments.</p> : null}
      {state.kind === 'ready'
        ? state.items.map((item) => (
            <AttachmentPreview
              key={item.attachmentId}
              attachment={item}
              resolveRead={props.resolveRead}
            />
          ))
        : null}
    </section>
  );
}
