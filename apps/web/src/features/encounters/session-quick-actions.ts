import type { ActorRef, SessionQuickAction } from '@rpg/contracts';

/**
 * Feature 19 D-11: "Add encounter" for Session Mode, on feature 16's pattern (its D-14). `invoke` asks the one
 * mounted `EncounterHost` (app shell) to open the tracker over the session screen and resolves when it closes.
 * Without a host it resolves at once. Feature 18 lists it without importing this feature.
 */

export interface EncounterOverlayRequest {
  readonly actor: ActorRef;
  readonly sessionId: string;
  close(): void;
}

type Host = (request: EncounterOverlayRequest) => void;

let host: Host | undefined;

export function registerEncounterHost(next: Host): () => void {
  host = next;
  return () => {
    if (host === next) host = undefined;
  };
}

export function openEncounterOverlay(context: {
  readonly actor: ActorRef;
  readonly sessionId: string;
}): Promise<void> {
  const current = host;
  if (current === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      resolve();
    };
    try {
      current({ actor: context.actor, sessionId: context.sessionId, close });
    } catch {
      close();
    }
  });
}

export const ENCOUNTER_SESSION_QUICK_ACTIONS: readonly SessionQuickAction[] = [
  {
    id: 'encounters.add',
    label: 'Add encounter',
    async invoke(context) {
      await openEncounterOverlay(context);
    },
  },
];
