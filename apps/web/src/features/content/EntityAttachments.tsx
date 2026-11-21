import { CAMPAIGN_ENTITY_CLASS } from '@rpg/content';
import type { Visibility } from '@rpg/contracts';
import { type FormEvent, useRef, useState } from 'react';
import { AttachmentList } from '../attachments/Attachments.tsx';
import { type UploadOutcome, uploadAttachment } from '../attachments/attachments-api.ts';

/**
 * FR-009 / task 13: feature 05 attachments on an entity (never on a personal note, D-15). The
 * list is online (attachment metadata is not replicated); an upload sends `visibility` as the
 * attachment Visibility: the entity's own, or `everyone` for a type whose attachments follow the
 * entity (feature 17 D-06). Feature 05 intersects it with the owner, so it never widens it.
 */
export function EntityAttachments(props: {
  readonly campaignId: string;
  readonly entityId: string;
  readonly visibility: Visibility;
  readonly canAttach: boolean;
}) {
  const owner = { resourceClass: CAMPAIGN_ENTITY_CLASS, resourceId: props.entityId };
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (file === undefined || busy) return;
    setBusy(true);
    setStatus('Uploading…');
    const outcome = await uploadAttachment({
      campaignId: props.campaignId,
      owner,
      file,
      visibility: props.visibility,
    });
    setBusy(false);
    setStatus(uploadMessage(outcome));
    if (outcome.kind === 'attached') {
      if (input.current !== null) input.current.value = '';
      setRefresh((value) => value + 1);
    }
  }

  return (
    <section aria-label="Entity attachments">
      <AttachmentList key={refresh} campaignId={props.campaignId} owner={owner} />
      {props.canAttach && (
        <form aria-label="Attach a file" onSubmit={(event) => void upload(event)}>
          <label>
            File
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
            />
          </label>{' '}
          <button type="submit" disabled={busy}>
            Attach
          </button>
          {status !== undefined && <p role="status">{status}</p>}
        </form>
      )}
    </section>
  );
}

export function uploadMessage(outcome: UploadOutcome): string {
  if (outcome.kind === 'attached') return `Attached ${outcome.attachment.filename}.`;
  if (outcome.kind === 'rejected') return `The file was not accepted (${outcome.reason}).`;
  return 'The upload did not complete. Check your connection and try again.';
}
