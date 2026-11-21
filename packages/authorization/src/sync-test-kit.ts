import type { ActorRef, Role, Visibility } from '@rpg/contracts';
import { AuthorizationService, SyncPredicateCompiler } from './authorization.ts';
import type { ResourceFacts, ResourcePolicyRegistry } from './registry.ts';
import { evaluateSyncRule, type SyncRequester, type SyncRule } from './sync-predicate.ts';

/**
 * Exhaustive API-vs-sync truth table (`_bdd.md`, Both rules come from one declaration; `_db.md`,
 * Synchronization). For one registered class it enumerates requesters (every MVP role, a removed
 * member, a non-member, a member of another campaign, and a second player) against rows
 * (every Visibility mode, targets naming each requester or several, every author fact, live and
 * tombstoned, in the requester's campaign and another one).
 *
 * `api` is the pure decision a read would get: no current membership in the row's campaign
 * means no Actor, so the read is denied; otherwise `AuthorizationService.decide`. A tombstone is
 * expected exactly where the last live facts were readable. `synced` is the compiled AST
 * evaluated in-process. Provider adapters evaluate the same `rule` as SQL and compare through
 * `findSyncDivergences`.
 */

export interface SyncTruthMembership {
  readonly campaignId: string;
  readonly role: Role;
  readonly removed: boolean;
}

export interface SyncTruthRequester {
  readonly label: string;
  readonly userId: string;
  readonly memberships: readonly SyncTruthMembership[];
}

export interface SyncTruthRow {
  readonly label: string;
  readonly id: string;
  readonly facts: ResourceFacts;
  readonly deleted: boolean;
}

export interface SyncTruthCase {
  readonly requester: SyncTruthRequester;
  readonly row: SyncTruthRow;
  readonly api: boolean;
  readonly synced: boolean;
}

export interface SyncTruthTable {
  readonly resourceClass: string;
  readonly rule: SyncRule;
  readonly campaignId: string;
  readonly otherCampaignId: string;
  readonly partyId: string;
  readonly requesters: readonly SyncTruthRequester[];
  readonly rows: readonly SyncTruthRow[];
  readonly cases: readonly SyncTruthCase[];
}

export interface SyncDivergence {
  readonly requester: string;
  readonly row: string;
  readonly api: boolean;
  readonly observed: boolean;
}

export interface SyncTruthTableOptions {
  /** ID source. Defaults to deterministic UUIDs, which suits test-scoped tables. */
  readonly newId?: () => string;
}

export function syncTruthTable(
  registry: ResourcePolicyRegistry,
  resourceClass: string,
  options: SyncTruthTableOptions = {},
): SyncTruthTable {
  const policy = registry.get(resourceClass);
  if (policy === undefined) throw new Error(`unregistered_resource_class: ${resourceClass}`);
  const newId = options.newId ?? deterministicIds();
  const { rule } = new SyncPredicateCompiler(registry).compile(resourceClass, 'read');
  const campaignId = newId();
  const otherCampaignId = newId();
  const partyId = newId();

  const member = (role: Role, removed = false): SyncTruthMembership[] => [
    { campaignId, role, removed },
  ];
  const requesters: SyncTruthRequester[] = [
    ...(['owner', 'gm', 'assistant_gm', 'player', 'observer'] as const).map((role) => ({
      label: role,
      userId: newId(),
      memberships: member(role),
    })),
    { label: 'second_player', userId: newId(), memberships: member('player') },
    { label: 'removed_gm', userId: newId(), memberships: member('gm', true) },
    { label: 'non_member', userId: newId(), memberships: [] },
    {
      label: 'other_campaign_gm',
      userId: newId(),
      memberships: [{ campaignId: otherCampaignId, role: 'gm', removed: false }],
    },
  ];
  const user = (label: string) => requesters.find((item) => item.label === label)?.userId ?? '';

  const campaignWide =
    policy.sync.kind === 'replicated' && policy.sync.visibility === 'campaign_wide';
  const visibilities: { readonly label: string; readonly visibility: Visibility }[] = campaignWide
    ? [{ label: 'everyone', visibility: { mode: 'everyone' } }]
    : [
        { label: 'everyone', visibility: { mode: 'everyone' } },
        { label: 'gm_only', visibility: { mode: 'gm_only' } },
        { label: 'party', visibility: { mode: 'party', partyIds: [partyId] } },
        ...requesters.map((item) => ({
          label: `players[${item.label}]`,
          visibility: { mode: 'players' as const, playerIds: [item.userId] },
        })),
        {
          label: 'players[player,second_player]',
          visibility: {
            mode: 'players',
            playerIds: [user('player'), user('second_player')].sort(),
          },
        },
      ];
  const authors: { readonly label: string; readonly userId?: string }[] = campaignWide
    ? [{ label: 'no_author' }]
    : [
        { label: 'no_author' },
        ...requesters.map((item) => ({ label: `author=${item.label}`, userId: item.userId })),
      ];

  const rows: SyncTruthRow[] = [];
  for (const [campaignLabel, rowCampaign] of [
    ['campaign', campaignId],
    ['other_campaign', otherCampaignId],
  ] as const) {
    for (const { label: visibilityLabel, visibility } of visibilities) {
      for (const author of authors) {
        for (const deleted of [false, true]) {
          const id = newId();
          rows.push({
            label: `${campaignLabel}/${visibilityLabel}/${author.label}/${deleted ? 'tombstone' : 'live'}`,
            id,
            deleted,
            facts: {
              campaignId: rowCampaign,
              resourceClass,
              resourceId: id,
              visibility,
              version: 1,
              ...(author.userId === undefined ? {} : { authorUserId: author.userId }),
            },
          });
        }
      }
    }
  }

  const authorization = new AuthorizationService(registry);
  const cases: SyncTruthCase[] = [];
  for (const requester of requesters) {
    const sync = truthRequester(requester);
    for (const row of rows) {
      cases.push({
        requester,
        row,
        api: apiReads(authorization, requester, row.facts),
        synced: evaluateSyncRule(rule, sync, row.facts),
      });
    }
  }
  return {
    resourceClass,
    rule,
    campaignId,
    otherCampaignId,
    partyId,
    requesters,
    rows,
    cases,
  };
}

/** The requester as a provider sees it: only current (not removed) memberships count. */
export function truthRequester(requester: SyncTruthRequester): SyncRequester {
  return {
    userId: requester.userId,
    roleIn: (campaignId) =>
      requester.memberships.find((item) => item.campaignId === campaignId && !item.removed)?.role,
  };
}

/**
 * Compares the pure decision with an observed sync outcome per case; the default observation is
 * the in-process AST. Any returned divergence is a failure.
 */
export function findSyncDivergences(
  table: SyncTruthTable,
  observed?: (requester: SyncTruthRequester, row: SyncTruthRow) => boolean,
): SyncDivergence[] {
  const divergences: SyncDivergence[] = [];
  for (const item of table.cases) {
    const value = observed === undefined ? item.synced : observed(item.requester, item.row);
    if (value !== item.api) {
      divergences.push({
        requester: item.requester.label,
        row: item.row.label,
        api: item.api,
        observed: value,
      });
    }
  }
  return divergences;
}

function apiReads(
  authorization: AuthorizationService,
  requester: SyncTruthRequester,
  facts: ResourceFacts,
): boolean {
  const membership = requester.memberships.find(
    (item) => item.campaignId === facts.campaignId && !item.removed,
  );
  if (membership === undefined) return false;
  const actor: ActorRef = {
    userId: requester.userId,
    campaignId: facts.campaignId,
    role: membership.role,
  };
  return authorization.decide(actor, 'read', facts).allowed;
}

function deterministicIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${next.toString(16).padStart(12, '0')}`;
  };
}
