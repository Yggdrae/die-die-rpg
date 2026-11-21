import { useEffect, useState } from 'react';
import { contentErrorMessage } from './content-model.ts';
import type { ContentSource } from './content-source.ts';
import { QuickCreateForm } from './EntityViews.tsx';
import { type QuickCreateRequest, registerQuickCreateHost } from './session-quick-actions.ts';

/**
 * D-14: feature 16's own quick-create overlay, mounted once by the app shell. A
 * `CONTENT_SESSION_QUICK_ACTIONS` invocation opens it; it closes on save or cancel, which resolves
 * the invocation. It creates in the open campaign only, through the device repository (local
 * write, visible at once offline).
 */
export function ContentQuickCreateHost(props: { readonly source?: ContentSource }) {
  const [request, setRequest] = useState<QuickCreateRequest>();

  useEffect(
    () =>
      registerQuickCreateHost((next) =>
        setRequest((current) => {
          // One overlay at a time: an earlier request is closed as cancelled.
          current?.close('cancelled');
          return next;
        }),
      ),
    [],
  );

  if (request === undefined) return null;
  const close = (result: 'saved' | 'cancelled') => {
    request.close(result);
    setRequest(undefined);
  };
  const source = props.source;
  const available = source !== undefined && request.actor.campaignId === source.campaignId;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quick create"
      data-quick-create-overlay={request.entry.id}
      style={{
        position: 'fixed',
        inset: '10% auto auto 50%',
        transform: 'translateX(-50%)',
        background: 'Canvas',
        color: 'CanvasText',
        border: '1px solid',
        padding: '1rem',
        zIndex: 10,
      }}
    >
      {available ? (
        <QuickCreateForm
          entry={request.entry}
          onCancel={() => close('cancelled')}
          onSave={async (input) => {
            const created = await source.entities.quickCreate(input);
            if (!created.ok) return contentErrorMessage(created.error);
            close('saved');
            return undefined;
          }}
        />
      ) : (
        <>
          <p role="alert">This campaign is not open on this device.</p>
          <button type="button" onClick={() => close('cancelled')}>
            Close
          </button>
        </>
      )}
    </div>
  );
}
