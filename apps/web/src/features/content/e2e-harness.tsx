import type { ActorRef, SessionQuickAction } from '@rpg/contracts';
import type { BrowserSyncSession } from '@rpg/sync/browser';
import { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { SyncStatusIndicator } from '../sync/SyncStatus.tsx';
import { useBrowserSync } from '../sync/useBrowserSync.ts';
import { ContentQuickCreateHost } from './ContentQuickCreateHost.tsx';
import { ContentWorkspace } from './ContentWorkspace.tsx';
import { browserContentSource } from './content-source.ts';
import { CONTENT_SESSION_QUICK_ACTIONS } from './session-quick-actions.ts';

/**
 * Playwright-only host (imported dynamically from `content.e2e.ts`; never from production code).
 * It is the dashboard's content composition without the rest of the dashboard: the production
 * `useBrowserSync` (browser replica through the PowerSync web SDK), `browserContentSource`,
 * `ContentWorkspace`, and the one `ContentQuickCreateHost`.
 */

let session: BrowserSyncSession | undefined;
let campaign: string | undefined;

function Harness(props: { readonly userId: string; readonly campaignId: string }) {
  const sync = useBrowserSync(props.userId, props.campaignId);
  const source = useMemo(
    () =>
      sync.session === undefined || sync.drafts === undefined
        ? undefined
        : browserContentSource(sync.session, {
            userId: props.userId,
            campaignId: props.campaignId,
            drafts: sync.drafts,
          }),
    [sync.session, sync.drafts, props.userId, props.campaignId],
  );
  useEffect(() => {
    session = sync.session;
  }, [sync.session]);
  return (
    <main>
      {sync.status !== undefined && <SyncStatusIndicator status={sync.status} />}
      <ContentQuickCreateHost {...(source === undefined ? {} : { source })} />
      {source !== undefined && <ContentWorkspace source={source} />}
      <button type="button" onClick={() => void sync.signOut()}>
        Sign out of this device
      </button>
    </main>
  );
}

export function mountContent(input: { readonly userId: string; readonly campaignId: string }) {
  campaign = input.campaignId;
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  createRoot(host).render(<Harness {...input} />);
}

function current(): BrowserSyncSession {
  if (session === undefined) throw new Error('no session');
  return session;
}

/** Pauses provider sync (no upload, no download) without touching the network. */
export async function pauseSync(): Promise<void> {
  await current().disconnect();
}

export async function resumeSync(): Promise<void> {
  await current().connect(campaign);
}

export async function pendingCount(): Promise<number> {
  return current().store.pendingCount();
}

/** Every pending-mutation row (for "queued, never sent" assertions). */
export async function queuedTables(): Promise<string[]> {
  const rows = await current().database.getAll<{ table_name: string; state: string }>(
    "SELECT table_name, state FROM sync_pending_mutations WHERE state != 'accepted' ORDER BY causal_sequence",
  );
  return rows.map((row) => `${row.table_name}:${row.state}`);
}

const outcomes = new Map<string, string>();

/** Invokes a frozen `SessionQuickAction` the way feature 18 will; records when it resolves. */
export function invokeQuickAction(input: {
  readonly id: string;
  readonly actor: ActorRef;
  readonly sessionId: string;
  readonly ticket: string;
}): void {
  const action: SessionQuickAction | undefined = CONTENT_SESSION_QUICK_ACTIONS.find(
    (candidate) => candidate.id === input.id,
  );
  outcomes.set(input.ticket, 'pending');
  void action
    ?.invoke({ actor: input.actor, sessionId: input.sessionId })
    .then(() => outcomes.set(input.ticket, 'resolved'))
    .catch(() => outcomes.set(input.ticket, 'threw'));
}

export function quickActionOutcome(ticket: string): string | undefined {
  return outcomes.get(ticket);
}
