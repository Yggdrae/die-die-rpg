import { type BrowserStorageBackend, createBrowserReplicaDatabase } from '@rpg/sync/browser';

export async function persistCampaignState(input: {
  readonly backend: BrowserStorageBackend;
  readonly filename: string;
  readonly campaignId: string;
}): Promise<void> {
  const { database } = createBrowserReplicaDatabase({
    filename: input.filename,
    forceBackend: input.backend,
  });
  await database.init();
  await database.execute(
    `INSERT OR REPLACE INTO sync_campaign_state (id, campaign_id, replica_state)
     VALUES (?, ?, 'available')`,
    [input.campaignId, input.campaignId],
  );
  await database.close();
}

export async function reopenCampaignState(input: {
  readonly backend: BrowserStorageBackend;
  readonly filename: string;
  readonly campaignId: string;
}): Promise<{ readonly state?: string; readonly openMs: number }> {
  const startedAt = performance.now();
  const { database } = createBrowserReplicaDatabase({
    filename: input.filename,
    forceBackend: input.backend,
  });
  await database.init();
  const row = await database.getOptional<{ replica_state: string }>(
    'SELECT replica_state FROM sync_campaign_state WHERE id = ?',
    [input.campaignId],
  );
  const openMs = performance.now() - startedAt;
  await database.close();
  return { ...(row === null ? {} : { state: row.replica_state }), openMs };
}
