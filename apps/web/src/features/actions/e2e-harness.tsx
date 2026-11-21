import { ACTIONS_REPLICA_TABLES, EMPTY_TARGET_STATE, type ResolvedPlan } from '@rpg/actions';
import type { BrowserSyncSession } from '@rpg/sync/browser';
import { reconcileMembershipCache } from '../sync/membership-rule.ts';
import { browserEffectRepository } from './effect-source.ts';

/**
 * Playwright-only host (imported dynamically from `effects.e2e.ts`; never from production code). The
 * production browser replica through the PowerSync web SDK, and `browserEffectRepository`. Feature 11 has no
 * screen of its own, so this drives the published device API directly.
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
    tables: ACTIONS_REPLICA_TABLES,
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
  return (await current().store.cachedMembership(who().campaignId))?.role;
}

export async function applyDamage(input: {
  readonly targetId: string;
  readonly amount: number;
}): Promise<{ readonly id?: string; readonly error?: string }> {
  const path = 'resources.hp.current';
  const plan: ResolvedPlan = {
    action: 'hit',
    operations: [
      { operation: { op: 'delta', path, value: -input.amount } },
      { operation: { op: 'clamp', path, min: 0, max: 20 } },
    ],
    changes: [],
    followUps: [],
    edited: false,
  };
  const applied = await browserEffectRepository(current(), who()).apply(
    { targetClass: 'campaign_entity', targetId: input.targetId, visibility: { mode: 'everyone' } },
    plan,
  );
  return applied.ok ? { id: applied.value.id } : { error: applied.error.code };
}

/** The target as displayed: the overlay over a base the page is told, as an owner's replica would be. */
export async function displayedHp(input: {
  readonly targetId: string;
  readonly base: number;
}): Promise<number | undefined> {
  const state = await browserEffectRepository(current(), who()).displayedState(
    { targetClass: 'campaign_entity', targetId: input.targetId },
    { ...EMPTY_TARGET_STATE, resources: { hp: { current: input.base } } },
  );
  return state.resources.hp?.current;
}

export async function record(id: string) {
  return (await browserEffectRepository(current(), who()).get(id)) ?? null;
}

export async function pendingCount(): Promise<number> {
  return current().store.pendingCount();
}

export async function storedIds(): Promise<readonly string[]> {
  const rows = await current().database.getAll<{ id: string }>(
    'SELECT id FROM effect_applications ORDER BY id',
  );
  return rows.map((row) => row.id);
}

export async function oplogHolds(id: string): Promise<boolean> {
  const row = await current().database.getOptional<{ count: number }>(
    'SELECT count(*) AS count FROM ps_oplog WHERE row_id = ? OR data LIKE ?',
    [id, `%${id}%`],
  );
  return (row?.count ?? 0) > 0;
}
