import { type QuickCreateEntryPoint, SESSION_QUICK_CREATE_ENTRY_POINTS } from '@rpg/content';
import type { ActorRef, SessionQuickAction } from '@rpg/contracts';

/**
 * D-14 / B-4: Session Mode quick create without a frozen-contract change. Each action implements
 * the frozen `SessionQuickAction`; `invoke({ actor, sessionId })` asks the one mounted
 * `ContentQuickCreateHost` (app shell) to open feature 16's own overlay and resolves when it
 * closes, saved or cancelled. It never throws on cancel. Feature 18 lists and invokes these
 * without importing feature 16; placing them on the Session Mode screen is its work.
 */

export type QuickCreateClose = 'saved' | 'cancelled';

export interface QuickCreateRequest {
  readonly entry: QuickCreateEntryPoint;
  readonly actor: ActorRef;
  readonly sessionId: string;
  /** Called once by the host when the overlay closes. */
  close(result: QuickCreateClose): void;
}

type Host = (request: QuickCreateRequest) => void;

let host: Host | undefined;

/** The app shell's host registers itself; the returned function unregisters it. */
export function registerQuickCreateHost(next: Host): () => void {
  host = next;
  return () => {
    if (host === next) host = undefined;
  };
}

/**
 * Opens the overlay for `entry`. Without a mounted host nothing can open: the call resolves as
 * cancelled (never throws).
 */
export function openContentQuickCreate(
  entry: QuickCreateEntryPoint,
  context: { readonly actor: ActorRef; readonly sessionId: string },
): Promise<QuickCreateClose> {
  const current = host;
  if (current === undefined) return Promise.resolve('cancelled');
  return new Promise((resolve) => {
    let closed = false;
    try {
      current({
        entry,
        actor: context.actor,
        sessionId: context.sessionId,
        close(result) {
          if (closed) return;
          closed = true;
          resolve(result);
        },
      });
    } catch {
      closed = true;
      resolve('cancelled');
    }
  });
}

export const CONTENT_SESSION_QUICK_ACTIONS: readonly SessionQuickAction[] =
  SESSION_QUICK_CREATE_ENTRY_POINTS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    async invoke(context) {
      await openContentQuickCreate(entry, context);
    },
  }));
