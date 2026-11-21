import { useEffect, useState } from 'react';
import { EncounterWorkspace } from './EncounterWorkspace.tsx';
import type { EncounterSource } from './encounter-source.ts';
import { type EncounterOverlayRequest, registerEncounterHost } from './session-quick-actions.ts';

/**
 * D-11: the tracker overlay, mounted once by the app shell. An "Add encounter" invocation opens it on the start
 * form, over the session screen, for the session it came from; closing it resolves the invocation.
 */
export function EncounterHost(props: { readonly source?: EncounterSource }) {
  const [request, setRequest] = useState<EncounterOverlayRequest>();

  useEffect(
    () =>
      registerEncounterHost((next) =>
        setRequest((current) => {
          current?.close();
          return next;
        }),
      ),
    [],
  );

  if (request === undefined) return null;
  const close = () => {
    request.close();
    setRequest(undefined);
  };
  const source = props.source;
  const available = source !== undefined && request.actor.campaignId === source.campaignId;
  return (
    <div role="dialog" aria-modal="true" aria-label="Encounter tracker">
      {available ? (
        <EncounterWorkspace source={source} sessionId={request.sessionId} starting />
      ) : (
        <p role="alert">This campaign is not open on this device.</p>
      )}
      <button type="button" onClick={close}>
        Close tracker
      </button>
    </div>
  );
}
