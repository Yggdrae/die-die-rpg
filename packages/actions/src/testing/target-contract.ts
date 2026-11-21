import type { EffectTargetAdapter } from '../application.ts';
import { applyPlannedOperations, EMPTY_TARGET_STATE, type TargetState } from '../engine/state.ts';
import type { ActionsTransaction } from '../infra/postgres/repository.ts';

/**
 * What every target's owner must satisfy (D-12); features 15 and 19 run it against their own adapter. Each
 * entry is a problem found, and an empty list is a pass. It runs inside a transaction the caller rolls back.
 */
export async function runEffectTargetContract(input: {
  readonly adapter: EffectTargetAdapter;
  readonly transaction: ActionsTransaction;
  readonly campaignId: string;
  /** A live target in `campaignId`, holding an empty or arbitrary state. */
  readonly targetId: string;
  readonly otherCampaignId: string;
  readonly actorUserId: string;
}): Promise<readonly string[]> {
  const { adapter, transaction, campaignId, targetId } = input;
  const problems: string[] = [];
  const loaded = await adapter.load(transaction, { campaignId, targetId });
  if (loaded === undefined) return ['a live target does not load'];
  if (loaded.facts.resourceClass !== adapter.targetClass) {
    problems.push('facts name another class');
  }
  if (loaded.facts.campaignId !== campaignId) problems.push('facts name another campaign');
  if (
    (await adapter.load(transaction, { campaignId: input.otherCampaignId, targetId })) !== undefined
  ) {
    problems.push('a target loads from another campaign');
  }
  if (
    (await adapter.load(transaction, { campaignId, targetId: crypto.randomUUID() })) !== undefined
  ) {
    problems.push('a missing target loads');
  }
  const changed = applyPlannedOperations(loaded.state ?? EMPTY_TARGET_STATE, [
    { operation: { op: 'delta', path: 'conditions.contract_probe', value: 1 } },
    { operation: { op: 'set', path: 'fields.contract_probe', value: 'kept' } },
  ]);
  if (!changed.ok) return [...problems, 'the stored state does not take operations'];
  const next: TargetState = changed.value.state;
  await adapter.save(transaction, {
    campaignId,
    targetId,
    state: next,
    actorUserId: input.actorUserId,
  });
  const reloaded = await adapter.load(transaction, { campaignId, targetId });
  if (JSON.stringify(reloaded?.state.conditions) !== JSON.stringify(next.conditions)) {
    problems.push('a saved state does not read back');
  }
  if (reloaded?.state.fields.contract_probe !== 'kept') {
    problems.push('a saved field does not read back');
  }
  return problems;
}
