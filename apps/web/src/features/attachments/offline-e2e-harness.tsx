import { OfflineAttachmentStore } from '@rpg/attachments/offline';
import { createRoot } from 'react-dom/client';
import { OfflineAttachments } from './OfflineAttachments.tsx';
import { IndexedDbOfflineAttachmentDb, offlineAttachmentDbName } from './offline-db.ts';
import { httpOfflineAttachmentSource } from './offline-source.ts';

/**
 * Playwright-only host for `e2e/attachments-offline.e2e.ts` (never imported by production code).
 * Mounts the production `OfflineAttachments` panel over the production IndexedDB store and HTTP
 * source, exactly as `useBrowserSync` composes them, and exposes the store so the spec can drive
 * the removal signals (`replicaPurged`, `reconcileAll`) and read what the device holds.
 */
declare global {
  interface Window {
    __offlineAttachments?: {
      readonly store: OfflineAttachmentStore;
      readonly db: IndexedDbOfflineAttachmentDb;
    };
  }
}

export async function mountOfflineHarness(options: {
  readonly userId: string;
  readonly campaignId: string;
}): Promise<void> {
  const db = await IndexedDbOfflineAttachmentDb.open(offlineAttachmentDbName(options.userId));
  const store = new OfflineAttachmentStore({ db, source: httpOfflineAttachmentSource() });
  await store.start();
  window.__offlineAttachments = { store, db };
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  createRoot(host).render(
    <main>
      <h1 data-testid="app-shell">Campaign</h1>
      <OfflineAttachments campaignId={options.campaignId} store={store} />
    </main>,
  );
}
