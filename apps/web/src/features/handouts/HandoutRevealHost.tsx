import { useEffect, useState } from 'react';
import type { ContentSource } from '../content/content-source.ts';
import { HandoutsWorkspace } from './HandoutsWorkspace.tsx';
import { type HandoutOverlayRequest, registerHandoutHost } from './session-quick-actions.ts';

/**
 * D-08: the handout overlay, mounted once by the app shell, opened by the session quick action. `onRevealed` tells
 * the shell which session a reveal was made in, so feature 18 can log it without either feature importing the other.
 */
export function HandoutRevealHost(props: {
  readonly source?: ContentSource;
  readonly onRevealed?: (reveal: {
    readonly sessionId: string;
    readonly handoutId: string;
  }) => void;
}) {
  const [request, setRequest] = useState<HandoutOverlayRequest>();

  useEffect(
    () =>
      registerHandoutHost((next) =>
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
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reveal handout"
      style={{
        position: 'fixed',
        inset: '5% auto auto 50%',
        transform: 'translateX(-50%)',
        background: 'Canvas',
        color: 'CanvasText',
        border: '1px solid',
        padding: '1rem',
        zIndex: 10,
        maxHeight: '90vh',
        overflow: 'auto',
      }}
    >
      {available ? (
        <HandoutsWorkspace
          source={source}
          onRevealed={(handoutId) =>
            props.onRevealed?.({ sessionId: request.sessionId, handoutId })
          }
        />
      ) : (
        <p role="alert">This campaign is not open on this device.</p>
      )}
      <button type="button" onClick={close}>
        Close
      </button>
    </div>
  );
}
