import type { BrowserSyncSession } from '@rpg/sync/browser';
import { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { browserContentSource } from '../content/content-source.ts';
import { useBrowserSync } from '../sync/useBrowserSync.ts';
import { HandoutsWorkspace } from './HandoutsWorkspace.tsx';

/**
 * Playwright-only host (imported dynamically from `handouts.e2e.ts`; never from production code):
 * the dashboard's handout composition alone, over the production browser replica.
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
  return <main>{source !== undefined && <HandoutsWorkspace source={source} />}</main>;
}

export function mountHandouts(input: { readonly userId: string; readonly campaignId: string }) {
  campaign = input.campaignId;
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  createRoot(host).render(<Harness {...input} />);
}

function current(): BrowserSyncSession {
  if (session === undefined) throw new Error('no session');
  return session;
}

export async function pauseSync(): Promise<void> {
  await current().disconnect();
}

export async function resumeSync(): Promise<void> {
  await current().connect(campaign);
}

export async function pendingCount(): Promise<number> {
  return current().store.pendingCount();
}

/** Every entity row in the local database, with its text: absence means absent, not hidden. */
export async function storedEntities(): Promise<readonly string[]> {
  const rows = await current().database.getAll<{ id: string; name: string; description: string }>(
    'SELECT id, name, description FROM content_entities',
  );
  return rows.map((row) => `${row.id}|${row.name}|${row.description}`);
}
