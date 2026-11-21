import {
  DICE_REPLICA_TABLES,
  type RollContext,
  type RollRecord,
  type RollRequest,
} from '@rpg/dice';
import type { BrowserSyncSession } from '@rpg/sync/browser';
import { reconcileMembershipCache } from '../sync/membership-rule.ts';
import { browserRollRepository } from './roll-source.ts';

/**
 * Playwright-only host (imported dynamically from `dice.e2e.ts`; never from production code). The
 * production browser replica through the PowerSync web SDK, and `browserRollRepository`. Feature 09 has
 * no screen of its own (D-17), so this drives the published device API directly.
 */

let session: BrowserSyncSession | undefined;
let identity: { readonly userId: string; readonly campaignId: string } | undefined;

function current(): BrowserSyncSession {
  if (session === undefined) throw new Error('no session');
  return session;
}

function who(): { readonly userId: string; readonly campaignId: string } {
  if (identity === undefined) throw new Error('no identity');
  return identity;
}

export async function open(input: {
  readonly userId: string;
  readonly campaignId: string;
}): Promise<void> {
  identity = input;
  const { BrowserSyncSession } = await import('@rpg/sync/browser');
  session = await BrowserSyncSession.open({
    userId: input.userId,
    reconcile: reconcileMembershipCache,
    tables: DICE_REPLICA_TABLES,
  });
  await session.connect(input.campaignId);
}

export async function pauseSync(): Promise<void> {
  await current().disconnect();
}

export async function resumeSync(): Promise<void> {
  await current().connect(who().campaignId);
}

export async function role(): Promise<string | undefined> {
  const cached = await current().store.cachedMembership(who().campaignId);
  return cached?.role;
}

/** Rolls through the published device API; a refusal comes back as data. */
export async function roll(
  input: RollRequest & RollContext,
): Promise<{ readonly record?: RollRecord; readonly error?: string }> {
  const rolled = await browserRollRepository(current(), who()).roll(input);
  return rolled.ok ? { record: rolled.value } : { error: rolled.error.code };
}

export async function rollIds(): Promise<readonly string[]> {
  return (await browserRollRepository(current(), who()).list()).map((record) => record.id);
}

export async function pendingCount(): Promise<number> {
  return current().store.pendingCount();
}

export async function queuedAudit(): Promise<readonly boolean[]> {
  const rows = await current().database.getAll<{ payload: string }>(
    'SELECT payload FROM sync_pending_mutations',
  );
  return rows.map((row) => 'audit' in (JSON.parse(row.payload) as object));
}

/** What the replica physically stores, by SQL: no repository or rendering is involved. */
export async function storedRows(): Promise<
  readonly {
    readonly id: string;
    readonly roll_visibility: string;
    readonly visibility_mode: string;
  }[]
> {
  return current().database.getAll(
    'SELECT id, roll_visibility, visibility_mode FROM dice_rolls ORDER BY id',
  );
}

/** Whether an id appears anywhere in the provider's raw oplog, not only in the table view. */
export async function oplogHolds(id: string): Promise<boolean> {
  const row = await current().database.getOptional<{ count: number }>(
    'SELECT count(*) AS count FROM ps_oplog WHERE row_id = ? OR data LIKE ?',
    [id, `%${id}%`],
  );
  return (row?.count ?? 0) > 0;
}
