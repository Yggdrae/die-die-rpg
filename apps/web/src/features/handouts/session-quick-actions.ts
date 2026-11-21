import type { ActorRef, SessionQuickAction } from '@rpg/contracts';

/**
 * Feature 17 D-08: "Reveal handout" for Session Mode, on feature 16's pattern (its D-14). `invoke`
 * asks the one mounted `HandoutRevealHost` (app shell) to open the reveal overlay and resolves
 * when it closes. Without a host it resolves at once. Feature 18 places it.
 */

export interface HandoutOverlayRequest {
  readonly actor: ActorRef;
  readonly sessionId: string;
  close(): void;
}

type Host = (request: HandoutOverlayRequest) => void;

let host: Host | undefined;

export function registerHandoutHost(next: Host): () => void {
  host = next;
  return () => {
    if (host === next) host = undefined;
  };
}

export function openHandoutOverlay(context: {
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

export const HANDOUT_SESSION_QUICK_ACTIONS: readonly SessionQuickAction[] = [
  {
    id: 'handouts.reveal',
    label: 'Reveal handout',
    async invoke(context) {
      await openHandoutOverlay(context);
    },
  },
];
