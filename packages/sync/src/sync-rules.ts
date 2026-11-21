import {
  KNOWN_ROLES,
  type ReplicatedSync,
  type ResourcePolicyRegistry,
  rowPredicate,
  type SyncPredicate,
  SyncPredicateCompiler,
  type SyncRule,
  simplify,
} from '@rpg/authorization';
import { GM_ROLES } from '@rpg/contracts';

/**
 * Feature 03 sync-rule adapter (feature 04 `_db.md`, Synchronization): translates the
 * provider-neutral predicate AST compiled from registered Resource Policies into SQL row filters.
 * The PowerSync dialect produces the stream queries in `infra/powersync/sync-config.yaml`; the
 * PostgreSQL dialect runs the identical structure against PostgreSQL for the equivalence suite.
 *
 * Shape of every query: the class's approved projection from its source, inner-joined to the
 * requester's current membership in the row's campaign, filtered by the compiled predicate.
 * Tombstones are not filtered out: they follow the same predicate as live rows.
 *
 * PowerSync Service 1.25.0 constraints (verified against the running service and its sync-rules
 * engine, see `docs/OFFLINE_SYNC_RUNTIME.md`):
 * - the source table is not aliased: an alias renames the synced table;
 * - tuple lists `IN ('a', 'b')` are rejected; a value set renders as `IN '["a","b"]'` (a JSON array
 *   literal). `OR` chains also work but count against the 100-term limit on the disjunctive
 *   normal form that every OR expands to;
 * - `auth.user_id() IN <json column>` and `OR` branches that mix membership and row conditions
 *   are accepted and evaluate as `decide` does.
 */

/** Current authoritative membership as the provider reads it (feature 01 owns the relation). */
export interface MembershipRelation {
  readonly source: string;
  readonly userColumn: string;
  readonly campaignColumn: string;
  readonly roleColumn: string;
  readonly removedAtColumn: string;
}

/**
 * Provider placement and approved replicated columns for one registered class. Columns are
 * qualified by the unaliased source table; `m` is reserved for the membership relation.
 */
export interface SyncRuleBinding {
  readonly resourceClass: string;
  readonly stream: string;
  readonly columns: readonly string[];
}

export interface SqlDialect {
  readonly name: 'powersync' | 'postgres';
  /** Expression for the authenticated requester's user ID. */
  readonly requester: string;
  /** Row's JSON targets array contains the requester's user ID. */
  targetsIncludeRequester(column: string): string;
  /** `column` equals one of `values` (trusted literals: roles, modes, class names). */
  anyOf(column: string, values: readonly string[]): string;
  /** Text at `path` inside the JSON `column`. */
  jsonText(column: string, path: readonly string[]): string;
  /** The JSON array at `path` inside `column` contains the requester's user ID. */
  jsonArrayIncludesRequester(column: string, path: readonly string[]): string;
  /** UTC `YYYY-MM` of the timestamp `column`. */
  monthOf(column: string): string;
  /** An explicit stream subscription parameter (audit window). */
  subscriptionParameter(name: (typeof AUDIT_SYNC_WINDOW)[keyof typeof AUDIT_SYNC_WINDOW]): string;
}

const JSON_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function jsonPath(path: readonly string[], render: (keys: readonly string[]) => string): string {
  if (path.length === 0 || path.some((key) => !JSON_KEY.test(key))) {
    throw new Error('unsupported json path');
  }
  return render(path);
}

const LITERAL = /^[a-z_][a-z0-9_.]*$/;

function literalSet(
  column: string,
  values: readonly string[],
  many: (values: readonly string[]) => string,
): string {
  if (values.length === 0 || values.some((value) => !LITERAL.test(value))) {
    throw new Error(`unsupported literal set for ${column}`);
  }
  return values.length === 1 ? `${column} = '${values[0]}'` : `${column} IN ${many(values)}`;
}

export const POWERSYNC_DIALECT: SqlDialect = {
  name: 'powersync',
  requester: 'auth.user_id()',
  // PowerSync `IN`: a parameter on the left, a row JSON array column on the right.
  targetsIncludeRequester: (column) => `auth.user_id() IN ${column}`,
  // A JSON array literal: one DNF term, where an OR chain would add one per value.
  anyOf: (column, values) => literalSet(column, values, (items) => `'${JSON.stringify(items)}'`),
  jsonText: (column, path) =>
    jsonPath(path, (keys) => `json_extract(${column}, '$.${keys.join('.')}')`),
  jsonArrayIncludesRequester: (column, path) =>
    jsonPath(path, (keys) => `auth.user_id() IN json_extract(${column}, '$.${keys.join('.')}')`),
  // Timestamps replicate as UTC ISO text.
  monthOf: (column) => `substring(${column}, 1, 7)`,
  subscriptionParameter: (name) => `subscription.parameter('${name}')`,
};

/** `$1` is the requester's user ID. */
export const POSTGRES_DIALECT: SqlDialect = {
  name: 'postgres',
  requester: '$1::uuid',
  targetsIncludeRequester: (column) => `${column} @> jsonb_build_array($1::uuid)`,
  anyOf: (column, values) =>
    literalSet(column, values, (items) => `(${items.map((item) => `'${item}'`).join(', ')})`),
  jsonText: (column, path) => jsonPath(path, (keys) => `(${column} #>> '{${keys.join(',')}}')`),
  jsonArrayIncludesRequester: (column, path) =>
    jsonPath(
      path,
      (keys) =>
        `coalesce((${column} #> '{${keys.join(',')}}') @> jsonb_build_array($1::uuid), false)`,
    ),
  monthOf: (column) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM')`,
  /** `$2` is the subscribed campaign, `$3` the subscribed month. */
  subscriptionParameter: (name) => (name === 'campaign_id' ? '$2::uuid' : '$3::text'),
};

export type SyncRuleTranslationFailure =
  | 'invalid_identifier'
  | 'reserved_alias'
  | 'unsupported_predicate'
  | 'never_replicates'
  | 'missing_projection_column'
  | 'missing_ownership_column'
  | 'missing_binding'
  | 'duplicate_binding'
  | 'unexpected_binding';

export class SyncRuleTranslationError extends Error {
  constructor(
    readonly code: SyncRuleTranslationFailure,
    readonly resourceClass: string,
  ) {
    super(`sync_rule_translation_failed: ${code} (${resourceClass})`);
    this.name = 'SyncRuleTranslationError';
  }
}

export interface CompiledProviderQuery {
  readonly resourceClass: string;
  readonly stream: string;
  readonly source: string;
  readonly query: string;
}

const MEMBER = 'm';
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const VISIBILITY_MODES = ['gm_only', 'everyone', 'party', 'players'];

/**
 * Compiles every registered class and translates the replicated ones. Startup-style failure: a
 * replicated class without a binding, a binding for a class that never replicates, or any
 * untranslatable predicate throws instead of emitting a partial rule set.
 */
export function compileProviderQueries(
  registry: ResourcePolicyRegistry,
  bindings: readonly SyncRuleBinding[],
  membership: MembershipRelation,
  dialect: SqlDialect = POWERSYNC_DIALECT,
): CompiledProviderQuery[] {
  const byClass = new Map<string, SyncRuleBinding>();
  for (const binding of bindings) {
    if (byClass.has(binding.resourceClass)) {
      throw new SyncRuleTranslationError('duplicate_binding', binding.resourceClass);
    }
    byClass.set(binding.resourceClass, binding);
  }
  const queries: CompiledProviderQuery[] = [];
  for (const rule of new SyncPredicateCompiler(registry).rules('read')) {
    const binding = byClass.get(rule.resourceClass);
    byClass.delete(rule.resourceClass);
    if (rowPredicate(rule).kind === 'never') {
      if (binding !== undefined)
        throw new SyncRuleTranslationError('unexpected_binding', rule.resourceClass);
      continue;
    }
    if (binding === undefined)
      throw new SyncRuleTranslationError('missing_binding', rule.resourceClass);
    queries.push({
      resourceClass: rule.resourceClass,
      stream: binding.stream,
      source: rule.source?.source ?? '',
      query: renderSyncRuleQuery(rule, binding, membership, dialect),
    });
  }
  const [orphan] = byClass.keys();
  if (orphan !== undefined) throw new SyncRuleTranslationError('unexpected_binding', orphan);
  return queries;
}

/** Renders one compiled rule as a row-filter query in `dialect`. */
export function renderSyncRuleQuery(
  rule: SyncRule,
  binding: SyncRuleBinding,
  membership: MembershipRelation,
  dialect: SqlDialect = POWERSYNC_DIALECT,
): string {
  const fail = (code: SyncRuleTranslationFailure): never => {
    throw new SyncRuleTranslationError(code, rule.resourceClass);
  };
  const source = rule.source;
  const predicate = rowPredicate(rule);
  if (source === undefined || predicate.kind === 'never') return fail('never_replicates');
  const name = (value: string | undefined): string =>
    value !== undefined && IDENTIFIER.test(value) ? value : fail('invalid_identifier');
  const table = name(source.source);
  if (table === MEMBER) fail('reserved_alias');
  [
    source.campaignColumn,
    membership.source,
    membership.userColumn,
    membership.campaignColumn,
    membership.roleColumn,
    membership.removedAtColumn,
    ...binding.columns,
  ].forEach(name);

  const required = [
    'id',
    source.campaignColumn,
    ...(source.deletedAtColumn === null ? [] : [name(source.deletedAtColumn)]),
    ...(source.visibility === 'campaign_wide'
      ? []
      : [name(source.visibility.modeColumn), name(source.visibility.targetsColumn)]),
    ...Object.values(source.ownershipColumns ?? {}).map(name),
  ];
  if (required.some((column) => !binding.columns.includes(column))) {
    fail('missing_projection_column');
  }

  const row = (column: string) => `${table}.${column}`;
  const member = (column: string) => `${MEMBER}.${column}`;
  const render = rowRenderer({ source, table, membership, dialect, fail, name });

  const filters = [
    `${member(membership.userColumn)} = ${dialect.requester}`,
    `${member(membership.removedAtColumn)} IS NULL`,
    ...conjuncts(predicate, render),
  ];
  return [
    `SELECT ${binding.columns.map(row).join(', ')}`,
    `FROM ${table}`,
    `INNER JOIN ${membership.source} ${MEMBER} ON ${member(membership.campaignColumn)} = ${row(source.campaignColumn)}`,
    `WHERE ${filters.join('\n  AND ')}`,
  ].join('\n');
}

/** How each leaf of the AST reads its facts; `and`/`or` and constants are shared. */
interface LeafRenderers {
  readonly memberRoleIn: (roles: readonly string[]) => string;
  readonly visibilityModeIn: (modes: readonly string[]) => string;
  readonly targetsIncludeRequester: () => string;
  readonly ownerIsRequester: (field: OwnershipFieldName) => string;
  readonly fail: (code: SyncRuleTranslationFailure) => never;
}

type OwnershipFieldName = Extract<SyncPredicate, { kind: 'owner_is_requester' }>['field'];
type Render = (node: SyncPredicate, nested: boolean) => string;

function predicateRenderer(leaves: LeafRenderers): Render {
  const render: Render = (node, nested) => {
    switch (node.kind) {
      case 'and':
      case 'or': {
        const joined = node.of
          .map((item) => render(item, true))
          .join(` ${node.kind.toUpperCase()} `);
        return nested ? `(${joined})` : joined;
      }
      case 'member_role_in':
        if (node.roles.some((role) => !KNOWN_ROLES.includes(role))) {
          return leaves.fail('unsupported_predicate');
        }
        return leaves.memberRoleIn(node.roles);
      case 'visibility_mode_in':
        if (node.modes.some((mode) => !VISIBILITY_MODES.includes(mode))) {
          return leaves.fail('unsupported_predicate');
        }
        return leaves.visibilityModeIn(node.modes);
      case 'targets_include_requester':
        return leaves.targetsIncludeRequester();
      case 'owner_is_requester':
        return leaves.ownerIsRequester(node.field);
      // No party relation exists; party targeting stays fail-closed (P1).
      case 'party_includes_requester':
      case 'always':
      case 'never':
        return leaves.fail('unsupported_predicate');
    }
  };
  return render;
}

/** Leaves read the class's own row (`table`) and the joined membership `m`. */
function rowRenderer(input: {
  readonly source: ReplicatedSync;
  readonly table: string;
  readonly membership: MembershipRelation;
  readonly dialect: SqlDialect;
  readonly fail: (code: SyncRuleTranslationFailure) => never;
  readonly name: (value: string | undefined) => string;
}): Render {
  const { source, table, membership, dialect, fail, name } = input;
  const row = (column: string) => `${table}.${column}`;
  return predicateRenderer({
    fail,
    memberRoleIn: (roles) => dialect.anyOf(`${MEMBER}.${membership.roleColumn}`, roles),
    visibilityModeIn: (modes) =>
      source.visibility === 'campaign_wide'
        ? fail('unsupported_predicate')
        : dialect.anyOf(row(source.visibility.modeColumn), modes),
    targetsIncludeRequester: () =>
      source.visibility === 'campaign_wide'
        ? fail('unsupported_predicate')
        : dialect.targetsIncludeRequester(row(source.visibility.targetsColumn)),
    ownerIsRequester: (field) => {
      const column = source.ownershipColumns?.[field];
      if (column === undefined) return fail('missing_ownership_column');
      return `${row(name(column))} = ${dialect.requester}`;
    },
  });
}

/** Top-level conjuncts of `predicate` (`always` contributes none). */
function conjuncts(predicate: SyncPredicate, render: Render): string[] {
  if (predicate.kind === 'always') return [];
  if (predicate.kind === 'and') return predicate.of.map((item) => render(item, true));
  return [render(predicate, true)];
}

/* ------------------------------------------------------------------------------------------
 * Feature 06 task 04: audit store replication.
 *
 * An audit row replicates to a requester only when the same three decisions the task 03 query
 * API makes (`AuditTargetAccess`) all allow, evaluated by the provider:
 *
 * 1. the target's current facts: the audit row joins the target class's own source row (live;
 *    the record is the event's campaign) and applies that class's compiled rule to it, reading role
 *    included;
 * 2. the snapshot stored with the event, applied as the target's Visibility (narrows only);
 * 3. for the GM-private store, the current facts narrowed to `gm_only` (GM reading roles).
 *
 * A target class replicates audit only when the provider can prove all three. A `server_only`
 * class, a class nobody may read, a class whose read has an Ownership Rule (the snapshot may name
 * another author), party targeting, and a class whose records are not the campaign itself (the
 * provider cannot prove the record's campaign, see `auditExclusion`) are excluded and stay online-only (task 03 API). An
 * undeclared class has no query at all. Rows are windowed by explicit subscription parameters
 * (campaign and accepted UTC month) so a device can evict old months (10 MB local allocation).
 * `campaign_sequence`, the stored snapshot, and the origin mutation never replicate: sequence
 * gaps would count hidden events.
 * ---------------------------------------------------------------------------------------- */

export type AuditSyncStoreName = 'campaign' | 'private';

/** Subscription parameters of every audit stream (one subscription per campaign and month). */
export const AUDIT_SYNC_WINDOW = { campaign: 'campaign_id', month: 'month' } as const;

/** One physical audit store and its provider placement. */
export interface AuditSyncStore {
  readonly store: AuditSyncStoreName;
  readonly source: string;
  readonly stream: string;
  /** Approved replicated columns (must include `id` and the campaign column). */
  readonly projection: readonly string[];
  readonly columns: {
    readonly campaign: string;
    readonly targetType: string;
    readonly targetId: string;
    /** Stored target Visibility snapshot (`{ visibility, authorUserId?, partyIds? }`, JSON). */
    readonly snapshot: string;
    /** Authority acceptance time (UTC month window). */
    readonly acceptedAt: string;
  };
}

export type AuditSyncExclusion =
  | 'never_replicates'
  | 'ownership_on_read'
  | 'party_targeting'
  | 'campaign_scope_unprovable';

export interface CompiledAuditQuery {
  readonly store: AuditSyncStoreName;
  readonly stream: string;
  readonly source: string;
  readonly targetClass: string;
  readonly query: string;
}

export interface AuditSyncCompilation {
  readonly queries: readonly CompiledAuditQuery[];
  /** Registered classes whose audit stays online-only, with the reason. */
  readonly excluded: readonly {
    readonly targetClass: string;
    readonly reason: AuditSyncExclusion;
  }[];
}

const SNAPSHOT_MODE = ['visibility', 'mode'] as const;
const SNAPSHOT_PLAYERS = ['visibility', 'playerIds'] as const;
const PRIVATE_STORE_ROLES = GM_ROLES;

/**
 * Compiles the audit stream queries of every store for every registered class that can be
 * proven. Throws (startup-style) on an invalid store binding; an unprovable class is excluded,
 * never widened.
 */
export function compileAuditProviderQueries(
  registry: ResourcePolicyRegistry,
  stores: readonly AuditSyncStore[],
  membership: MembershipRelation,
  dialect: SqlDialect = POWERSYNC_DIALECT,
): AuditSyncCompilation {
  const seen = new Set<AuditSyncStoreName>();
  for (const store of stores) {
    if (seen.has(store.store)) throw new SyncRuleTranslationError('duplicate_binding', store.store);
    seen.add(store.store);
  }
  const compiler = new SyncPredicateCompiler(registry);
  const queries: CompiledAuditQuery[] = [];
  const excluded: { targetClass: string; reason: AuditSyncExclusion }[] = [];
  for (const policy of registry.policies()) {
    if (!policy.capabilities.includes('read')) continue;
    const compiled = compiler.compile(policy.resourceClass, 'read');
    const reason = auditExclusion(compiled.rule, compiled.declaration);
    if (reason !== undefined) {
      excluded.push({ targetClass: policy.resourceClass, reason });
      continue;
    }
    for (const store of stores) {
      queries.push({
        store: store.store,
        stream: store.stream,
        source: store.source,
        targetClass: policy.resourceClass,
        query: renderAuditSyncQuery(compiled.rule, store, membership, dialect),
      });
    }
  }
  return { queries, excluded };
}

function auditExclusion(
  rule: SyncRule,
  declaration: { readonly ownership?: unknown; readonly partyTargetingActive: boolean },
): AuditSyncExclusion | undefined {
  if (rule.source === undefined || rowPredicate(rule).kind === 'never') return 'never_replicates';
  if (declaration.ownership !== undefined) return 'ownership_on_read';
  if (declaration.partyTargetingActive) return 'party_targeting';
  // PowerSync 1.25.0 silently ignores an equality between a joined row and the audit row (verified
  // with its engine), so the target's own campaign is provable only when the record is the
  // campaign itself (`campaignColumn = id`): then it is the row-only filter `target_id =
  // campaign_id`. Other classes stay online-only until the provider can join on two keys.
  if (rule.source.campaignColumn !== 'id') return 'campaign_scope_unprovable';
  return undefined;
}

/** Renders one store's query for one target class (`rule` is the class's compiled read rule). */
export function renderAuditSyncQuery(
  rule: SyncRule,
  store: AuditSyncStore,
  membership: MembershipRelation,
  dialect: SqlDialect = POWERSYNC_DIALECT,
): string {
  const fail = (code: SyncRuleTranslationFailure): never => {
    throw new SyncRuleTranslationError(code, rule.resourceClass);
  };
  const source = rule.source;
  const current = rowPredicate(rule);
  if (source === undefined || current.kind === 'never') return fail('never_replicates');
  if (source.campaignColumn !== 'id') return fail('unsupported_predicate');
  const name = (value: string | undefined): string =>
    value !== undefined && IDENTIFIER.test(value) ? value : fail('invalid_identifier');
  const audit = name(store.source);
  const target = name(source.source);
  if (audit === MEMBER || target === MEMBER) fail('reserved_alias');
  if (audit === target) fail('invalid_identifier');
  const columns = store.columns;
  [
    columns.campaign,
    columns.targetType,
    columns.targetId,
    columns.snapshot,
    columns.acceptedAt,
    source.campaignColumn,
    membership.source,
    membership.userColumn,
    membership.campaignColumn,
    membership.roleColumn,
    membership.removedAtColumn,
    ...store.projection,
  ].forEach(name);
  if (!store.projection.includes('id') || !store.projection.includes(columns.campaign)) {
    fail('missing_projection_column');
  }
  // Never replicated: sequence gaps count hidden events; the snapshot names other targets.
  if (store.projection.includes(columns.snapshot)) fail('missing_projection_column');

  const a = (column: string) => `${audit}.${column}`;
  const member = (column: string) => `${MEMBER}.${column}`;
  const roleIn = (roles: readonly string[]) => dialect.anyOf(member(membership.roleColumn), roles);
  const currentRender = rowRenderer({ source, table: target, membership, dialect, fail, name });
  // The snapshot is applied as the target's Visibility; the reading-role scope is already part of
  // the current clause, so top-level role conjuncts are not repeated.
  const snapshotRender = predicateRenderer({
    fail,
    memberRoleIn: roleIn,
    visibilityModeIn: (modes) =>
      dialect.anyOf(dialect.jsonText(a(columns.snapshot), SNAPSHOT_MODE), modes),
    targetsIncludeRequester: () =>
      dialect.jsonArrayIncludesRequester(a(columns.snapshot), SNAPSHOT_PLAYERS),
    ownerIsRequester: () => fail('unsupported_predicate'),
  });
  const snapshot = simplify(rule.predicate);
  const snapshotClauses = (snapshot.kind === 'and' ? snapshot.of : [snapshot]).filter(
    (node) => node.kind !== 'member_role_in',
  );
  const privateRoles = PRIVATE_STORE_ROLES.filter((role) =>
    (current.kind === 'and' ? current.of : [current]).some(
      (node) => node.kind === 'member_role_in' && node.roles.includes(role),
    ),
  );
  if (store.store === 'private' && privateRoles.length === 0) fail('never_replicates');

  const filters = [
    `${member(membership.userColumn)} = ${dialect.requester}`,
    `${member(membership.removedAtColumn)} IS NULL`,
    `${a(columns.campaign)} = ${dialect.subscriptionParameter(AUDIT_SYNC_WINDOW.campaign)}`,
    // Keys the target lookup by the subscribed campaign. PowerSync resolves each joined relation
    // as its own parameter lookup: unkeyed, every live record becomes a parameter (1000-result
    // limit, observed on the live service) and is not correlated with the audit row.
    `${target}.${source.campaignColumn} = ${dialect.subscriptionParameter(AUDIT_SYNC_WINDOW.campaign)}`,
    `${dialect.monthOf(a(columns.acceptedAt))} = ${dialect.subscriptionParameter(AUDIT_SYNC_WINDOW.month)}`,
    `${a(columns.targetType)} = ${literal(rule.resourceClass, fail)}`,
    `${a(columns.targetId)} = ${a(columns.campaign)}`,
    ...(source.deletedAtColumn === null
      ? []
      : [`${target}.${name(source.deletedAtColumn)} IS NULL`]),
    ...conjuncts(current, currentRender),
    ...snapshotClauses.map((node) => snapshotRender(node, true)),
    ...(store.store === 'private' ? [roleIn(privateRoles)] : []),
  ];
  return [
    `SELECT ${store.projection.map(a).join(', ')}`,
    `FROM ${audit}`,
    `INNER JOIN ${membership.source} ${MEMBER} ON ${member(membership.campaignColumn)} = ${a(columns.campaign)}`,
    `INNER JOIN ${target} ON ${target}.${source.campaignColumn} = ${a(columns.campaign)}`,
    `WHERE ${filters.join('\n  AND ')}`,
  ].join('\n');
}

function literal(value: string, fail: (code: SyncRuleTranslationFailure) => never): string {
  return LITERAL.test(value) ? `'${value}'` : fail('invalid_identifier');
}

/** Whitespace-insensitive form for comparing a rendered query with configuration text. */
export function normalizeSql(query: string): string {
  return query.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}
