import type { AuditSqlExecutor } from '@rpg/audit';
import type { ActorRef, Role, Visibility } from '@rpg/contracts';

export type Capability =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'reveal'
  | 'manage_members'
  | 'export'
  | (string & {});

export const KNOWN_ROLES: readonly Role[] = ['owner', 'gm', 'assistant_gm', 'player', 'observer'];

/** Record facts an Ownership Rule may compare to the Actor. Owners keep the column. */
export type OwnershipField = 'authorUserId';

export interface ResourceFacts {
  readonly campaignId: string;
  readonly resourceClass: string;
  readonly resourceId: string;
  readonly visibility: Visibility;
  readonly version: number;
  readonly authorUserId?: string;
  /** Party memberships of the Actor, supplied only by a registered party resolver (P1). */
  readonly partyIds?: readonly string[];
}

/**
 * A restriction narrower than role and Visibility (`_domain.md`, Ownership Rule).
 *
 * For each listed capability the record's `field` must equal the Actor's user ID, unless the
 * Actor holds one of `exemptRoles`. An author-private note lists every capability and no exempt
 * role, so no GM-role override applies.
 */
export interface OwnershipRule {
  readonly field: OwnershipField;
  readonly capabilities: readonly Capability[];
  readonly exemptRoles: readonly Role[];
}

/** Targeted modes a visibility change may name for this class. */
export type TargetMode = 'players' | 'party';

/**
 * Where the class's rows replicate from, in provider-neutral terms. Feature 03 translates it.
 * Tombstones follow the same predicate as live rows.
 */
export interface ReplicatedSync {
  readonly kind: 'replicated';
  /** Owner row source (table or view) name. */
  readonly source: string;
  readonly campaignColumn: string;
  /**
   * Standard Visibility columns (`_db.md`), or `campaign_wide` for a class whose rows carry no
   * Visibility and replicate to every current member (requires an `everyone` default).
   */
  readonly visibility:
    | { readonly modeColumn: string; readonly targetsColumn: string }
    | 'campaign_wide';
  readonly deletedAtColumn: string | null;
  /** Column per ownership field; required when the Ownership Rule covers `read`. */
  readonly ownershipColumns?: Readonly<Partial<Record<OwnershipField, string>>>;
}

/** Explicit opt-out: rows never leave the authority. Still a declaration, never a default. */
export interface ServerOnlySync {
  readonly kind: 'server_only';
}

export type SyncDeclaration = ReplicatedSync | ServerOnlySync;

/** The single Resource Class declaration (`_domain.md`, Declaration). */
export interface ResourcePolicy {
  readonly resourceClass: string;
  readonly capabilities: readonly Capability[];
  /** One explicit row per MVP role, `observer` included and empty. */
  readonly roleCapabilities: Readonly<Record<Role, readonly Capability[]>>;
  /** Default Visibility on create, or `explicit` when a create must supply one. */
  readonly defaultVisibility: Visibility | 'explicit';
  readonly ownership?: OwnershipRule;
  /** Targeted modes a reveal may name. Default `['players']` when `reveal` is declared. */
  readonly revealTargets?: readonly TargetMode[];
  readonly sync: SyncDeclaration;
}

export interface VisibilityWrite {
  readonly campaignId: string;
  readonly resourceId: string;
  readonly expectedVersion: number;
  /** Already normalized by feature 04 (sorted unique targets, never an empty targeted set). */
  readonly visibility: Visibility;
  /**
   * The resolved Actor making the change (additive, feature 16 task 09): owners that maintain a
   * dependent invariant in the same transaction (relationship narrowing, D-07) attribute their own
   * audit events to it. Absent when called outside `VisibilityService`.
   */
  readonly actor?: ActorRef;
  /**
   * Enqueues the accepted change's feature 06 audit event. Call it once, inside the transaction
   * that applied the update and only after the update matched, passing that transaction. It never
   * aborts the transaction on an audit fault; if it throws anyway, let the error propagate so the
   * update rolls back with it.
   */
  recordAudit(executor: AuditSqlExecutor): Promise<void>;
}

/**
 * `invariant_violation` (B-1, feature 16 task 08, additive): the owner refuses a Visibility that
 * would break one of its own invariants (a relationship wider than its endpoints). The adapter
 * changes nothing and does not call `recordAudit`; `VisibilityService` answers
 * `incompatible_visibility`.
 */
export type VisibilityWriteResult =
  | { readonly ok: true; readonly facts: ResourceFacts }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'version_conflict' | 'invariant_violation';
    };

/**
 * Owner-supplied persistence for versioned Visibility changes (`_db.md`, Visibility Mutation
 * Transaction). It loads and writes one record and never exposes the owner's schema or a table
 * handle. `runVisibilityAdapterContract` is the conformance evidence.
 *
 * - `loadFacts` returns `undefined` for a missing record, a record in another campaign, or a
 *   tombstone.
 * - `writeVisibility` applies the update only when the live record in `campaignId` is still at
 *   `expectedVersion` (one conditional `UPDATE ... WHERE version = $expected`, or a row lock and
 *   compare), stores the Visibility as given, increments `version` by exactly 1, and calls
 *   `recordAudit` in the same transaction. Otherwise it changes nothing, does not call
 *   `recordAudit`, and reports `not_found` or `version_conflict`.
 */
export interface VisibilityAdapter {
  readonly resourceClass: string;
  loadFacts(campaignId: string, resourceId: string): Promise<ResourceFacts | undefined>;
  writeVisibility(write: VisibilityWrite): Promise<VisibilityWriteResult>;
}

export type RegistrationFailure =
  | 'invalid_resource_class'
  | 'duplicate_resource_class'
  | 'invalid_capabilities'
  | 'missing_capability_outcome'
  | 'undeclared_capability'
  | 'unknown_role'
  | 'observer_capability'
  | 'player_reveal'
  | 'missing_default_visibility'
  | 'invalid_default_visibility'
  | 'invalid_ownership_rule'
  | 'invalid_reveal_targets'
  | 'party_targeting_inactive'
  | 'missing_sync_predicate'
  | 'invalid_sync_predicate'
  | 'missing_ownership_column'
  | 'campaign_wide_requires_everyone'
  | 'missing_visibility_adapter'
  | 'incompatible_adapter';

export class ResourcePolicyRegistrationError extends Error {
  constructor(
    readonly code: RegistrationFailure,
    readonly resourceClass: string,
  ) {
    super(`invalid_resource_policy: ${code} (${resourceClass})`);
    this.name = 'ResourcePolicyRegistrationError';
  }
}

export interface ResourcePolicyRegistryOptions {
  /** Party targeting stays inactive (fail-closed) until a party resolver is composed (P1). */
  readonly partyTargeting?: 'inactive' | 'active';
  /** Authority composition: every reveal-capable class must register its adapter. */
  readonly requireVisibilityAdapters?: boolean;
}

interface Registration {
  readonly policy: ResourcePolicy;
  readonly adapter?: VisibilityAdapter;
}

/**
 * Code registry of Resource Class declarations, validated at composition. A rejected declaration
 * throws, so the application does not start serving a partially authorized class.
 */
export class ResourcePolicyRegistry {
  private readonly registrations = new Map<string, Registration>();
  readonly partyTargetingActive: boolean;
  private readonly requireAdapters: boolean;

  constructor(options: ResourcePolicyRegistryOptions = {}) {
    this.partyTargetingActive = options.partyTargeting === 'active';
    this.requireAdapters = options.requireVisibilityAdapters ?? false;
  }

  register(policy: ResourcePolicy, adapter?: VisibilityAdapter): void {
    const resourceClass = typeof policy.resourceClass === 'string' ? policy.resourceClass : '';
    const fail: Fail = (code) => {
      throw new ResourcePolicyRegistrationError(code, resourceClass);
    };
    if (resourceClass.trim() === '') fail('invalid_resource_class');
    if (this.registrations.has(resourceClass)) fail('duplicate_resource_class');

    const declared = new Set(policy.capabilities ?? []);
    if (
      declared.size === 0 ||
      declared.size !== policy.capabilities.length ||
      [...declared].some((capability) => typeof capability !== 'string' || capability === '')
    ) {
      fail('invalid_capabilities');
    }
    validateRoleCapabilities(policy, declared, fail);
    validateDefaultVisibility(policy, fail);
    validateOwnership(policy, declared, fail);
    const reveals = declared.has('reveal');
    validateRevealTargets(policy, reveals, this.partyTargetingActive, fail);
    validateSync(policy, reveals, fail);
    validateAdapter(resourceClass, reveals, adapter, this.requireAdapters, fail);

    this.registrations.set(resourceClass, adapter === undefined ? { policy } : { policy, adapter });
  }

  get(resourceClass: string): ResourcePolicy | undefined {
    return this.registrations.get(resourceClass)?.policy;
  }

  adapterFor(resourceClass: string): VisibilityAdapter | undefined {
    return this.registrations.get(resourceClass)?.adapter;
  }

  policies(): readonly ResourcePolicy[] {
    return [...this.registrations.values()].map((registration) => registration.policy);
  }
}

type Fail = (code: RegistrationFailure) => never;

function validateRoleCapabilities(
  policy: ResourcePolicy,
  declared: ReadonlySet<Capability>,
  fail: Fail,
): void {
  const rows = policy.roleCapabilities ?? {};
  for (const role of Object.keys(rows)) {
    if (!KNOWN_ROLES.includes(role as Role)) fail('unknown_role');
  }
  for (const role of KNOWN_ROLES) {
    const capabilities = rows[role];
    if (!Array.isArray(capabilities)) fail('missing_capability_outcome');
    if (capabilities.some((capability) => !declared.has(capability))) {
      fail('undeclared_capability');
    }
  }
  if (rows.observer.length !== 0) fail('observer_capability');
  if (rows.player.includes('reveal')) fail('player_reveal');
}

function validateDefaultVisibility(policy: ResourcePolicy, fail: Fail): void {
  const value = policy.defaultVisibility;
  if (value === undefined) fail('missing_default_visibility');
  if (value === 'explicit') return;
  // A static targeted default would name fixed users or parties; only audience-wide modes qualify.
  if (typeof value !== 'object' || (value.mode !== 'gm_only' && value.mode !== 'everyone')) {
    fail('invalid_default_visibility');
  }
}

function validateOwnership(
  policy: ResourcePolicy,
  declared: ReadonlySet<Capability>,
  fail: Fail,
): void {
  const rule = policy.ownership;
  if (rule === undefined) return;
  if (
    rule.field !== 'authorUserId' ||
    !Array.isArray(rule.capabilities) ||
    rule.capabilities.length === 0 ||
    rule.capabilities.some((capability) => !declared.has(capability)) ||
    !Array.isArray(rule.exemptRoles) ||
    rule.exemptRoles.some((role) => !KNOWN_ROLES.includes(role) || role === 'observer')
  ) {
    fail('invalid_ownership_rule');
  }
}

function validateRevealTargets(
  policy: ResourcePolicy,
  reveals: boolean,
  partyTargetingActive: boolean,
  fail: Fail,
): void {
  const targets = policy.revealTargets;
  if (targets === undefined) return;
  if (
    !reveals ||
    !Array.isArray(targets) ||
    targets.length === 0 ||
    new Set(targets).size !== targets.length ||
    targets.some((mode) => mode !== 'players' && mode !== 'party')
  ) {
    fail('invalid_reveal_targets');
  }
  if (targets.includes('party') && !partyTargetingActive) fail('party_targeting_inactive');
}

function validateSync(policy: ResourcePolicy, reveals: boolean, fail: Fail): void {
  const sync = policy.sync;
  if (sync === undefined || sync === null) fail('missing_sync_predicate');
  if (sync.kind === 'server_only') return;
  if (sync.kind !== 'replicated') fail('invalid_sync_predicate');
  const columns =
    sync.visibility === 'campaign_wide'
      ? [sync.source, sync.campaignColumn]
      : [
          sync.source,
          sync.campaignColumn,
          sync.visibility?.modeColumn,
          sync.visibility?.targetsColumn,
        ];
  if (
    columns.some((column) => !isName(column)) ||
    (sync.deletedAtColumn !== null && !isName(sync.deletedAtColumn))
  ) {
    fail('invalid_sync_predicate');
  }
  if (sync.visibility === 'campaign_wide') {
    // Rows without Visibility columns replicate to every member, so the class must mean `everyone`
    // and cannot persist a changed Visibility.
    const value = policy.defaultVisibility;
    if (value === 'explicit' || value.mode !== 'everyone' || reveals) {
      fail('campaign_wide_requires_everyone');
    }
  }
  const rule = policy.ownership;
  if (rule?.capabilities.includes('read') && !isName(sync.ownershipColumns?.[rule.field])) {
    fail('missing_ownership_column');
  }
}

function validateAdapter(
  resourceClass: string,
  reveals: boolean,
  adapter: VisibilityAdapter | undefined,
  required: boolean,
  fail: Fail,
): void {
  if (adapter === undefined) {
    if (reveals && required) fail('missing_visibility_adapter');
    return;
  }
  if (
    !reveals ||
    adapter.resourceClass !== resourceClass ||
    typeof adapter.loadFacts !== 'function' ||
    typeof adapter.writeVisibility !== 'function'
  ) {
    fail('incompatible_adapter');
  }
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
