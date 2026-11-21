import { afterAll, describe, expect, test } from 'bun:test';
import { ATTACHMENT_EXPORT_REPLICA_TABLES } from '@rpg/attachments/export';
import {
  AuthorizationService,
  findSyncDivergences,
  KNOWN_ROLES,
  ResourcePolicyRegistry,
  syncTruthTable,
} from '@rpg/authorization';
import { PRESERVED_CHUNK_REPLICA_TABLES } from '@rpg/campaign-portability';
import { CAMPAIGN_EXPORT_REPLICA_TABLES } from '@rpg/campaigns/export';
import type { Role, Visibility } from '@rpg/contracts';
import {
  compileProviderQueries,
  type MembershipRelation,
  normalizeSql,
  POSTGRES_DIALECT,
  POWERSYNC_DIALECT,
} from '@rpg/sync';
import postgres from 'postgres';
import { AUDIT_SYNC_STORES, registerResourcePolicies, SYNC_RULE_BINDINGS } from './sync-rules.ts';

/**
 * Feature 04 task 05 drift gate: the PowerSync stream query of every registered replicated class
 * in `infra/powersync/sync-config.yaml` must equal the query compiled from its Resource Policy,
 * and no hand-written query may stream any other content table. The first block needs no
 * database, so CI fails on drift. The second block runs the PostgreSQL rendering of the same
 * compiled rule against the real schema (skipped without a database).
 *
 * Named `.integration.test.ts` because it names feature 01/02 tables (the provider's membership
 * relation and the non-class platform tables) and seeds the real schema.
 */

const SYNC_CONFIG = new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url);

/** Current authoritative membership as PowerSync reads it (feature 01 `_db.md` cache fields). */
const MEMBERSHIP: MembershipRelation = {
  source: 'identity_campaign_memberships',
  userColumn: 'user_id',
  campaignColumn: 'campaign_id',
  roleColumn: 'role',
  removedAtColumn: 'removed_at',
};

/**
 * Streamed tables that are not registered Resource Classes yet: campaign settings (feature 02
 * `member_visible` rule), long-text holds (feature 03), and the requester's own memberships
 * (feature 03 task 07). Anything else streamed must come from a registered declaration.
 */
const EXPORT_REPLICA_TABLES = {
  ...CAMPAIGN_EXPORT_REPLICA_TABLES,
  ...ATTACHMENT_EXPORT_REPLICA_TABLES,
  ...PRESERVED_CHUNK_REPLICA_TABLES,
};
const PLATFORM_TABLES = [
  'campaign_settings',
  'sync_long_text_holds',
  MEMBERSHIP.source,
  // Feature 07 task 05: `campaign_export_metadata` and the exact pins.
  ...Object.keys(EXPORT_REPLICA_TABLES),
];

function registry(): ResourcePolicyRegistry {
  return registerResourcePolicies(new ResourcePolicyRegistry());
}

interface StreamQuery {
  readonly stream: string;
  readonly table: string;
  readonly query: string;
}

function streamQueries(yaml: string): StreamQuery[] {
  const parsed = Bun.YAML.parse(yaml) as {
    readonly streams?: Record<string, { readonly query?: string; readonly queries?: string[] }>;
  };
  return Object.entries(parsed.streams ?? {}).flatMap(([stream, value]) =>
    [...(value.query === undefined ? [] : [value.query]), ...(value.queries ?? [])].map(
      (query) => ({
        stream,
        table: (/\bFROM\s+([a-z_][a-z0-9_]*)/i.exec(query)?.[1] ?? '').toLowerCase(),
        query,
      }),
    ),
  );
}

/** Every difference between the configuration and the compiled rules; empty means no drift. */
function syncConfigDrift(yaml: string): string[] {
  const compiled = compileProviderQueries(registry(), SYNC_RULE_BINDINGS, MEMBERSHIP);
  const configured = streamQueries(yaml);
  const problems: string[] = [];
  for (const expected of compiled) {
    const matches = configured.filter((item) => item.table === expected.source);
    if (matches.length !== 1) {
      problems.push(`${expected.resourceClass}: ${matches.length} queries read ${expected.source}`);
      continue;
    }
    const [actual] = matches as [StreamQuery];
    if (actual.stream !== expected.stream) {
      problems.push(
        `${expected.resourceClass}: in stream ${actual.stream}, not ${expected.stream}`,
      );
    }
    if (normalizeSql(actual.query) !== normalizeSql(expected.query)) {
      problems.push(
        `${expected.resourceClass}: query differs from compiled output\n` +
          `expected: ${normalizeSql(expected.query)}\nactual:   ${normalizeSql(actual.query)}`,
      );
    }
  }
  // Audit store queries are compiled and drift-checked by `audit-sync.integration.test.ts`.
  const sources = new Set([
    ...compiled.map((item) => item.source),
    ...AUDIT_SYNC_STORES.map((store) => store.source),
  ]);
  for (const item of configured) {
    if (!sources.has(item.table) && !PLATFORM_TABLES.includes(item.table)) {
      problems.push(`${item.stream}: hand-written query streams unregistered table ${item.table}`);
    }
  }
  return problems;
}

/** Roles whose read of a campaign-scoped row with `visibility` the pure decision allows. */
function campaignReaders(visibility: Visibility): Role[] {
  const authorization = new AuthorizationService(registry());
  const campaignId = crypto.randomUUID();
  return KNOWN_ROLES.filter(
    (role) =>
      authorization.decide({ userId: crypto.randomUUID(), campaignId, role }, 'read', {
        campaignId,
        resourceClass: 'campaign',
        resourceId: campaignId,
        visibility,
        version: 1,
      }).allowed,
  );
}

/** Who receives the long-text holds of one class (feature 16 B-3). */
interface HoldAudience {
  readonly resourceClass: string;
  /** Roles that read every row of the class regardless of Visibility; empty = holder only. */
  readonly roles: readonly Role[];
}

/**
 * Feature 16 task 04 (B-3): a hold names its record, so the holds of a class replicate to a role
 * only if that role reads every row the class can hold, whatever its Visibility, and the class has
 * no Ownership Rule; otherwise only to the holder. Derived from the registered declarations and
 * `decide`. Only replicated classes that some role may `update` can be held (the hold routes
 * require `update`); a server-only class gets no hold branch. The Visibilities a class can hold:
 * `everyone` for a campaign-wide class, else `gm_only`, `everyone`, and `players` naming someone
 * else, plus `party` only when the class may reveal to parties.
 */
function holdAudiences(): HoldAudience[] {
  const policies = registry();
  const authorization = new AuthorizationService(policies);
  const campaignId = crypto.randomUUID();
  return policies
    .policies()
    .filter(
      (policy) =>
        policy.sync.kind === 'replicated' &&
        KNOWN_ROLES.some((role) => policy.roleCapabilities[role].includes('update')),
    )
    .map((policy) => {
      if (policy.ownership !== undefined) return { resourceClass: policy.resourceClass, roles: [] };
      const samples: Visibility[] =
        policy.sync.kind === 'replicated' && policy.sync.visibility === 'campaign_wide'
          ? [{ mode: 'everyone' }]
          : [
              { mode: 'gm_only' },
              { mode: 'everyone' },
              { mode: 'players', playerIds: [crypto.randomUUID()] },
              ...(policy.revealTargets?.includes('party') === true
                ? [{ mode: 'party' as const, partyIds: [crypto.randomUUID()] }]
                : []),
            ];
      const roles = KNOWN_ROLES.filter((role) =>
        samples.every(
          (visibility) =>
            authorization.decide({ userId: crypto.randomUUID(), campaignId, role }, 'read', {
              campaignId,
              resourceClass: policy.resourceClass,
              resourceId: crypto.randomUUID(),
              visibility,
              version: 1,
            }).allowed,
        ),
      );
      return { resourceClass: policy.resourceClass, roles };
    });
}

/**
 * Feature 03 task 07: the platform queries derived from the registered declarations. Settings
 * carry the campaign reading scope, and a setting that is not member-visible is `gm_only`. Holds
 * follow `holdAudiences` (feature 16 B-3).
 */
function expectedPlatformQueries(): { readonly table: string; readonly query: string }[] {
  const readers = campaignReaders({ mode: 'everyone' });
  const gmOnlyReaders = campaignReaders({ mode: 'gm_only' });
  // PowerSync 1.25.0 dialect (verified on the running service): unaliased source table, `||`
  // instead of `concat`, JSON array literals instead of tuple `IN (...)` lists.
  const scope = `WHERE m.user_id = auth.user_id() AND m.removed_at IS NULL
    AND ${POWERSYNC_DIALECT.anyOf('m.role', readers)}`;
  const s = (column: string) => `campaign_settings.${column}`;
  const h = (column: string) => `sync_long_text_holds.${column}`;
  const settingsColumns = [
    'campaign_id',
    'namespace',
    'value',
    'member_visible',
    'version',
    'updated_at',
    'updated_by',
    'deleted_at',
  ];
  const holdKey = ['campaign_id', 'resource_class', 'record_id', 'field_path'];
  const holdColumns = [
    ...holdKey,
    'holder_user_id',
    'acquired_at',
    'renewed_at',
    'expires_at',
    'version',
  ];
  // A branch omits the role clause when its roles already include the whole reading scope.
  const holdBranches = holdAudiences().map(({ resourceClass, roles }) => {
    const klass = POWERSYNC_DIALECT.anyOf(h('resource_class'), [resourceClass]);
    if (roles.length === 0) return `(${klass} AND ${h('holder_user_id')} = auth.user_id())`;
    if (readers.every((role) => roles.includes(role))) return klass;
    return `(${klass} AND ${POWERSYNC_DIALECT.anyOf('m.role', roles)})`;
  });
  const holdFilter =
    holdBranches.length === 1 ? (holdBranches[0] ?? '') : `(${holdBranches.join(' OR ')})`;
  return [
    {
      table: 'campaign_settings',
      query: `SELECT ${s('campaign_id')} || ':' || ${s('namespace')} AS id,
          ${settingsColumns.map(s).join(', ')}
        FROM campaign_settings
        INNER JOIN ${MEMBERSHIP.source} m ON m.campaign_id = ${s('campaign_id')}
        ${scope}
          AND (${s('member_visible')} OR ${POWERSYNC_DIALECT.anyOf('m.role', gmOnlyReaders)})`,
    },
    {
      table: 'sync_long_text_holds',
      query: `SELECT ${holdKey.map(h).join(" || ':' || ")} AS id,
          ${holdColumns.map(h).join(', ')}
        FROM sync_long_text_holds
        INNER JOIN ${MEMBERSHIP.source} m ON m.campaign_id = ${h('campaign_id')}
        ${scope}
          AND ${holdFilter}`,
    },
  ];
}

/** Every difference between the configured platform queries and the derived ones. */
function platformQueryDrift(yaml: string): string[] {
  const configured = streamQueries(yaml);
  const problems: string[] = [];
  for (const expected of expectedPlatformQueries()) {
    const matches = configured.filter((item) => item.table === expected.table);
    if (matches.length !== 1) {
      problems.push(`${expected.table}: ${matches.length} queries`);
      continue;
    }
    const [actual] = matches as [StreamQuery];
    if (actual.stream !== 'authorized_campaigns') {
      problems.push(`${expected.table}: in stream ${actual.stream}`);
    }
    if (normalizeSql(actual.query) !== normalizeSql(expected.query)) {
      problems.push(
        `${expected.table}: query differs from the declaration-derived filter\n` +
          `expected: ${normalizeSql(expected.query)}\nactual:   ${normalizeSql(actual.query)}`,
      );
    }
  }
  return problems;
}

describe('platform queries carry the declared visibility (feature 03 task 07)', () => {
  test('settings and holds use the campaign reading scope; no drift', async () => {
    expect(campaignReaders({ mode: 'everyone' })).toEqual([
      'owner',
      'gm',
      'assistant_gm',
      'player',
    ]);
    expect(platformQueryDrift(await Bun.file(SYNC_CONFIG).text())).toEqual([]);
  });

  test('a filter removed or widened is reported', async () => {
    const yaml = await Bun.file(SYNC_CONFIG).text();
    const readers = `m.role IN '["owner","gm","assistant_gm","player"]'`;
    const settingsScope = `AND ${readers}\n          AND (campaign_settings.member_visible`;
    const tampered = [
      // Settings admit any membership role (observers).
      yaml.replace(settingsScope, 'AND (campaign_settings.member_visible'),
      // GM-only settings reach players.
      yaml.replace(`OR m.role IN '["owner","gm","assistant_gm"]')`, `OR ${readers})`),
      // Holds on records of any class (a hidden record's id) reach every member.
      yaml.replace(
        /\n {10}AND \(sync_long_text_holds\.resource_class = 'campaign'[\s\S]*?'rules_section_mark'\n {14}AND sync_long_text_holds\.holder_user_id = auth\.user_id\(\)\)\)/,
        '',
      ),
      // Holds admit any membership role.
      yaml.replace(
        `AND ${readers}\n          AND (sync_long_text_holds.resource_class`,
        'AND (sync_long_text_holds.resource_class',
      ),
      // Feature 16 B-3, one tamper per branch: holds on hidden entities reach players.
      yaml.replace(
        `'campaign_entity'\n              AND m.role IN '["owner","gm","assistant_gm"]')`,
        `'campaign_entity'\n              AND ${readers})`,
      ),
      // Entity holds dropped to the holder only (GM roles lose the editing notice).
      yaml.replace(
        `'campaign_entity'\n              AND m.role IN '["owner","gm","assistant_gm"]')`,
        `'campaign_entity'\n              AND sync_long_text_holds.holder_user_id = auth.user_id())`,
      ),
      // Personal-note holds reach the GM roles.
      yaml.replace(
        `'personal_note'\n              AND sync_long_text_holds.holder_user_id = auth.user_id())`,
        `'personal_note'\n              AND m.role IN '["owner","gm","assistant_gm"]')`,
      ),
      // Personal-note holds reach every member.
      yaml.replace(
        `(sync_long_text_holds.resource_class = 'personal_note'\n              AND sync_long_text_holds.holder_user_id = auth.user_id())`,
        `sync_long_text_holds.resource_class = 'personal_note'`,
      ),
      // Feature 16 task 08: relationship holds (a hidden link's id) reach players.
      yaml.replace(
        `'entity_relationship'\n              AND m.role IN '["owner","gm","assistant_gm"]')`,
        `'entity_relationship'\n              AND ${readers})`,
      ),
      // Feature 15: character holds reach every member, not only their holder.
      yaml.replace(
        `'character'\n              AND sync_long_text_holds.holder_user_id = auth.user_id())`,
        `'character'\n              AND ${readers})`,
      ),
      // Feature 18: GM-note holds (a GM-only record id) reach players.
      yaml.replace(
        `'session_gm_note'\n              AND m.role IN '["owner","gm","assistant_gm"]')`,
        `'session_gm_note'\n              AND ${readers})`,
      ),
      // Feature 19: participant holds (a hidden participant's id) reach players.
      yaml.replace(
        `'encounter_participant'\n              AND m.role IN '["owner","gm","assistant_gm"]')`,
        `'encounter_participant'\n              AND ${readers})`,
      ),
      // Feature 14: mark holds reach every member, not only their holder.
      yaml.replace(
        `'rules_section_mark'\n              AND sync_long_text_holds.holder_user_id = auth.user_id()))`,
        `'rules_section_mark'\n              AND ${readers}))`,
      ),
      // The campaign branch widened to any class.
      yaml.replace(
        "AND (sync_long_text_holds.resource_class = 'campaign'\n",
        'AND (sync_long_text_holds.resource_class IS NOT NULL\n',
      ),
    ];
    for (const text of tampered) {
      expect(text).not.toBe(yaml);
      expect(platformQueryDrift(text).length).toBeGreaterThan(0);
    }
  });
});

describe('sync-config.yaml matches the compiled sync predicates', () => {
  test('Both rules come from one declaration: no drift for any registered class', async () => {
    expect(syncConfigDrift(await Bun.file(SYNC_CONFIG).text())).toEqual([]);
  });

  test('the compiled campaign rule scopes by current membership and reading role', () => {
    const [campaign] = compileProviderQueries(registry(), SYNC_RULE_BINDINGS, MEMBERSHIP);
    expect(normalizeSql(campaign?.query ?? '')).toBe(
      normalizeSql(`SELECT campaigns.id, campaigns.name, campaigns.description,
        campaigns.game_mode, campaigns.created_by, campaigns.version, campaigns.created_at,
        campaigns.updated_at, campaigns.deleted_at
        FROM campaigns
        INNER JOIN identity_campaign_memberships m ON m.campaign_id = campaigns.id
        WHERE m.user_id = auth.user_id()
          AND m.removed_at IS NULL
          AND m.role IN '["owner","gm","assistant_gm","player"]'`),
    );
  });

  test('any divergence fails: tampered configurations are reported', async () => {
    const yaml = await Bun.file(SYNC_CONFIG).text();
    const tampered = [
      // Admits observers / any role.
      yaml.replace(`AND m.role IN '["owner","gm","assistant_gm","player"]'`, ''),
      // Serves removed members.
      yaml.replace(
        'WHERE m.user_id = auth.user_id() AND m.removed_at IS NULL',
        'WHERE m.user_id = auth.user_id()',
      ),
      // Replicates an extra column.
      yaml.replace(
        '               campaigns.deleted_at\n',
        '               campaigns.deleted_at, campaigns.created_by AS owner\n',
      ),
      // Streams an unregistered content table by hand.
      `${yaml}\n  hidden_notes:\n    query: SELECT * FROM gm_notes\n`,
    ];
    for (const text of tampered) {
      expect(text).not.toBe(yaml);
      expect(syncConfigDrift(text).length).toBeGreaterThan(0);
    }
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate =
  databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2, onnotice: () => {} });
const sql = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await candidate`select 1 from campaigns limit 1`;
    return candidate;
  } catch {
    await candidate.end();
    return undefined;
  }
})();

afterAll(async () => sql?.end({ timeout: 1 }));

describe.skipIf(sql === undefined)('compiled campaign rule on the real schema (PostgreSQL)', () => {
  test('rows each requester receives equal the pure read decision, tombstones included', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const id = () => crypto.randomUUID();
    const users = {
      owner: id(),
      gm: id(),
      assistant_gm: id(),
      player: id(),
      removed_gm: id(),
      non_member: id(),
      other_campaign_owner: id(),
    };
    const campaign = id();
    const otherCampaign = id();
    const deletedCampaign = id();
    // Observer memberships are not representable: the feature 01 role CHECK excludes them.
    const memberships: { campaign: string; user: string; role: Role; removed: boolean }[] = [
      { campaign, user: users.owner, role: 'owner', removed: false },
      { campaign, user: users.gm, role: 'gm', removed: false },
      { campaign, user: users.assistant_gm, role: 'assistant_gm', removed: false },
      { campaign, user: users.player, role: 'player', removed: false },
      { campaign, user: users.removed_gm, role: 'gm', removed: true },
      { campaign: otherCampaign, user: users.other_campaign_owner, role: 'owner', removed: false },
      { campaign: deletedCampaign, user: users.player, role: 'player', removed: false },
      { campaign: deletedCampaign, user: users.owner, role: 'owner', removed: false },
    ];
    const userIds = Object.values(users);
    const campaignIds = [campaign, otherCampaign, deletedCampaign];
    try {
      // One transaction: the deferred one-active-owner constraint checks at commit.
      await sql.begin(async (tx) => {
        for (const userId of userIds) {
          const suffix = userId.replaceAll('-', '').slice(0, 12);
          await tx`insert into identity_users (id, username_display, username_normalized)
            values (${userId}, ${`Sync_${suffix}`}, ${`sync_${suffix}`})`;
        }
        for (const campaignId of campaignIds) {
          await tx`insert into campaigns (id, name, game_mode, created_by, deleted_at)
            values (${campaignId}, 'Sync rule probe', 'standard', ${users.owner},
              ${campaignId === deletedCampaign ? new Date('2026-10-01T00:00:00Z') : null})`;
        }
        for (const item of memberships) {
          await tx`insert into identity_campaign_memberships (campaign_id, user_id, role, removed_at)
            values (${item.campaign}, ${item.user}, ${item.role},
              ${item.removed ? new Date('2026-09-01T00:00:00Z') : null})`;
        }
      });

      const [rule] = compileProviderQueries(
        registry(),
        SYNC_RULE_BINDINGS,
        MEMBERSHIP,
        POSTGRES_DIALECT,
      );
      if (rule === undefined) throw new Error('campaign rule missing');
      const authorization = new AuthorizationService(registry());
      let compared = 0;
      for (const userId of userIds) {
        const rows = await sql.unsafe<{ id: string }[]>(rule.query, [userId]);
        const received = new Set(rows.map((row) => row.id));
        for (const campaignId of campaignIds) {
          const membership = memberships.find(
            (item) => item.user === userId && item.campaign === campaignId && !item.removed,
          );
          const api =
            membership !== undefined &&
            authorization.decide({ userId, campaignId, role: membership.role }, 'read', {
              campaignId,
              resourceClass: 'campaign',
              resourceId: campaignId,
              visibility: { mode: 'everyone' },
              version: 1,
            }).allowed;
          expect({ userId, campaignId, synced: received.has(campaignId) }).toEqual({
            userId,
            campaignId,
            synced: api,
          });
          compared += 1;
        }
      }
      expect(compared).toBe(userIds.length * campaignIds.length);
    } finally {
      try {
        await sql.begin(async (tx) => {
          await tx`delete from identity_campaign_memberships where campaign_id = any(${campaignIds}::uuid[])`;
          await tx`delete from campaigns where id = any(${campaignIds}::uuid[])`;
          await tx`delete from identity_users where id = any(${userIds}::uuid[])`;
        });
      } catch {
        // Nothing was committed when seeding failed.
      }
    }
  });
});

class Rollback extends Error {}

/**
 * A configured PowerSync query as PostgreSQL: the requester becomes `$1`, a JSON array literal
 * value set (`IN '["a","b"]'`) becomes a tuple list, and `auth.user_id() IN <json column>`
 * becomes JSON containment (the PostgreSQL dialect's rendering). Nothing else changes.
 */
function toPostgres(query: string): string {
  return query
    .replace(/\bhex\(([a-z_.]+)\)/g, "encode($1, 'hex')")
    .replace(
      /auth\.user_id\(\) IN ([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/g,
      (_match, column: string) => `${column} @> jsonb_build_array($1::uuid)`,
    )
    .replaceAll('auth.user_id()', '$1::uuid')
    .replace(
      /IN '(\[[^']*\])'/g,
      (_match, values: string) =>
        `IN (${(JSON.parse(values) as string[]).map((value) => `'${value}'`).join(', ')})`,
    );
}

/** Feature 16 task 04: the content tables streamed by `authorized_content`. */
const CONTENT_CLASSES = [
  { resourceClass: 'campaign_entity', table: 'content_entities' },
  { resourceClass: 'personal_note', table: 'content_personal_notes' },
  // Task 08: relationships, filtered by their own Visibility (bounded on write, D-07).
  { resourceClass: 'entity_relationship', table: 'content_entity_relationships' },
] as const;

describe('content streams (feature 16 task 04)', () => {
  test('API and compiled sync agree for both classes in-process, tombstones included', () => {
    for (const { resourceClass } of CONTENT_CLASSES) {
      const table = syncTruthTable(registry(), resourceClass);
      expect(table.cases.length).toBeGreaterThan(1000);
      expect(table.cases.some((item) => item.row.deleted && item.synced)).toBe(true);
      expect({ resourceClass, divergences: findSyncDivergences(table) }).toEqual({
        resourceClass,
        divergences: [],
      });
    }
  });

  test('both queries live in authorized_content and join only the requester membership row', async () => {
    const configured = streamQueries(await Bun.file(SYNC_CONFIG).text());
    for (const { table } of CONTENT_CLASSES) {
      const [query] = configured.filter((item) => item.table === table);
      expect(query?.stream).toBe('authorized_content');
      const joins = [...(query?.query ?? '').matchAll(/\bJOIN\s+([a-z_][a-z0-9_]*)\s*(\w*)/gi)];
      expect(joins.map((match) => [match[1], match[2]])).toEqual([[MEMBERSHIP.source, 'm']]);
      expect(query?.query).toMatch(new RegExp(`m\\.campaign_id = ${table}\\.campaign_id`));
      // No other content table is named anywhere in the query.
      for (const other of CONTENT_CLASSES.filter((item) => item.table !== table)) {
        expect(query?.query).not.toContain(other.table);
      }
    }
  });

  test('a tampered content query is reported', async () => {
    const yaml = await Bun.file(SYNC_CONFIG).text();
    const tampered = [
      // GM-only entities reach players.
      yaml.replace(
        `OR (m.role IN '["owner","gm","assistant_gm"]'\n              AND content_entities.visibility_mode`,
        `OR (m.role IN '["owner","gm","assistant_gm","player"]'\n              AND content_entities.visibility_mode`,
      ),
      // Targeted entities reach every player.
      yaml.replace(
        `(content_entities.visibility_mode = 'players'\n              AND auth.user_id() IN content_entities.visibility_targets)`,
        `content_entities.visibility_mode = 'players'`,
      ),
      // A personal note reaches GM roles.
      yaml.replace(
        `AND m.role = 'player'\n          AND content_personal_notes.author_user_id`,
        `AND m.role IN '["owner","gm","assistant_gm","player"]'\n          AND content_personal_notes.author_user_id`,
      ),
      // A personal note reaches every player.
      yaml.replace('\n          AND content_personal_notes.author_user_id = auth.user_id()', ''),
      // An extra replicated column.
      yaml.replace(
        'content_entities.created_by, content_entities.updated_by, content_entities.deleted_at',
        'content_entities.created_by, content_entities.updated_by, content_entities.deleted_at, content_entities.id AS secret',
      ),
      // Moved to another stream.
      yaml.replace('  authorized_content:\n', '  authorized_campaign_content:\n'),
      // GM-only relationships reach players.
      yaml.replace(
        `OR (m.role IN '["owner","gm","assistant_gm"]'\n              AND content_entity_relationships.visibility_mode`,
        `OR (m.role IN '["owner","gm","assistant_gm","player"]'\n              AND content_entity_relationships.visibility_mode`,
      ),
      // Targeted relationships reach every player.
      yaml.replace(
        `(content_entity_relationships.visibility_mode = 'players'\n              AND auth.user_id() IN content_entity_relationships.visibility_targets)`,
        `content_entity_relationships.visibility_mode = 'players'`,
      ),
    ];
    for (const text of tampered) {
      expect(text).not.toBe(yaml);
      expect(syncConfigDrift(text).length).toBeGreaterThan(0);
    }
  });

  test('hold audiences derived from the declarations (B-3)', () => {
    expect(holdAudiences()).toEqual([
      { resourceClass: 'campaign', roles: ['owner', 'gm', 'assistant_gm', 'player'] },
      { resourceClass: 'campaign_entity', roles: ['owner', 'gm', 'assistant_gm'] },
      { resourceClass: 'personal_note', roles: [] },
      { resourceClass: 'entity_relationship', roles: ['owner', 'gm', 'assistant_gm'] },
      // Feature 15: an Ownership Rule on update, so a hold reaches its holder only.
      { resourceClass: 'character', roles: [] },
      // Feature 18: sessions and GM notes are updated by GM roles only (no hold is used in P0).
      { resourceClass: 'campaign_session', roles: ['owner', 'gm', 'assistant_gm'] },
      { resourceClass: 'session_gm_note', roles: ['owner', 'gm', 'assistant_gm'] },
      // Feature 19: encounters, GM notes, and participants are updated by GM roles only.
      { resourceClass: 'encounter', roles: ['owner', 'gm', 'assistant_gm'] },
      { resourceClass: 'encounter_gm_note', roles: ['owner', 'gm', 'assistant_gm'] },
      { resourceClass: 'encounter_participant', roles: ['owner', 'gm', 'assistant_gm'] },
      // Feature 14: an Ownership Rule on update, so a hold reaches its holder only.
      { resourceClass: 'rules_section_mark', roles: [] },
    ]);
  });
});

describe('effect application stream (feature 11)', () => {
  test('API and compiled sync agree in-process for every role and Visibility', () => {
    const table = syncTruthTable(registry(), 'effect_application');
    expect(table.cases.length).toBeGreaterThan(100);
    expect(findSyncDivergences(table)).toEqual([]);
  });

  test('a tampered effect query is reported', async () => {
    const yaml = await Bun.file(SYNC_CONFIG).text();
    const tampered = [
      yaml.replace(
        `OR (m.role IN '["owner","gm","assistant_gm"]'\n              AND effect_applications.visibility_mode`,
        `OR (m.role IN '["owner","gm","assistant_gm","player"]'\n              AND effect_applications.visibility_mode`,
      ),
      yaml.replace(
        `(effect_applications.visibility_mode = 'players'\n              AND auth.user_id() IN effect_applications.visibility_targets)`,
        `effect_applications.visibility_mode = 'players'`,
      ),
      yaml.replace('  authorized_effects:\n', '  authorized_plays:\n'),
    ];
    for (const text of tampered) {
      expect(text).not.toBe(yaml);
      expect(syncConfigDrift(text).length).toBeGreaterThan(0);
    }
  });
});

describe('roll stream (feature 09)', () => {
  test('API and compiled sync agree in-process for every role and Visibility', () => {
    const table = syncTruthTable(registry(), 'dice_roll');
    expect(table.cases.length).toBeGreaterThan(100);
    expect(findSyncDivergences(table)).toEqual([]);
  });

  test('the query lives in its own stream and joins only the requester membership row', async () => {
    const configured = streamQueries(await Bun.file(SYNC_CONFIG).text());
    const [query] = configured.filter((item) => item.table === 'dice_rolls');
    expect(query?.stream).toBe('authorized_rolls');
    const joins = [...(query?.query ?? '').matchAll(/\bJOIN\s+([a-z_][a-z0-9_]*)\s*(\w*)/gi)];
    expect(joins.map((match) => [match[1], match[2]])).toEqual([[MEMBERSHIP.source, 'm']]);
  });

  test('a tampered roll query is reported', async () => {
    const yaml = await Bun.file(SYNC_CONFIG).text();
    const tampered = [
      // Hidden rolls reach players.
      yaml.replace(
        `OR (m.role IN '["owner","gm","assistant_gm"]'\n              AND dice_rolls.visibility_mode`,
        `OR (m.role IN '["owner","gm","assistant_gm","player"]'\n              AND dice_rolls.visibility_mode`,
      ),
      // A whisper reaches every player.
      yaml.replace(
        `(dice_rolls.visibility_mode = 'players'\n              AND auth.user_id() IN dice_rolls.visibility_targets)`,
        `dice_rolls.visibility_mode = 'players'`,
      ),
      // No Visibility filter at all.
      yaml.replace(
        `AND (dice_rolls.visibility_mode = 'everyone'`,
        `AND (dice_rolls.visibility_mode IS NOT NULL OR dice_rolls.visibility_mode = 'everyone'`,
      ),
      // An extra replicated column.
      yaml.replace('dice_rolls.created_at\n', 'dice_rolls.created_at, dice_rolls.id AS secret\n'),
      // Moved to another stream.
      yaml.replace('  authorized_rolls:\n', '  authorized_dice:\n'),
    ];
    for (const text of tampered) {
      expect(text).not.toBe(yaml);
      expect(syncConfigDrift(text).length).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(sql === undefined)('roll rules as PostgreSQL SQL (feature 09)', () => {
  test('the PostgreSQL rendering agrees with decide on a shadow table', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const query =
      compileProviderQueries(registry(), SYNC_RULE_BINDINGS, MEMBERSHIP, POSTGRES_DIALECT).find(
        (item) => item.resourceClass === 'dice_roll',
      )?.query ?? '';
    let compared = 0;
    try {
      await sql.begin(async (tx) => {
        for (const table of [MEMBERSHIP.source, 'dice_rolls']) {
          // Real columns and NOT NULLs, no CHECKs: observers and every truth-table row fit.
          await tx.unsafe(
            `create temp table ${table} (like public.${table} including defaults) on commit drop`,
          );
        }
        const truth = syncTruthTable(registry(), 'dice_roll', {
          newId: () => crypto.randomUUID(),
        });
        for (const requester of truth.requesters) {
          for (const membership of requester.memberships) {
            await tx.unsafe(
              `insert into ${MEMBERSHIP.source} (campaign_id, user_id, role, removed_at)
                values ($1, $2, $3, $4)`,
              [
                membership.campaignId,
                requester.userId,
                membership.role,
                membership.removed ? new Date('2026-09-01T00:00:00Z') : null,
              ],
            );
          }
        }
        const someone = crypto.randomUUID();
        for (const row of truth.rows) {
          const visibility = row.facts.visibility;
          const targets =
            visibility.mode === 'players'
              ? visibility.playerIds
              : visibility.mode === 'party'
                ? visibility.partyIds
                : [];
          await tx.unsafe(
            `insert into dice_rolls (id, campaign_id, actor_user_id, expression, result,
                natural_result, modified_result, roll_visibility, visibility_mode,
                visibility_targets, rolled_at)
              values ($1, $2, $3, '1d6', '{}'::jsonb, 1, 1, 'public', $4, $5::jsonb, now())`,
            [row.id, row.facts.campaignId, someone, visibility.mode, tx.json(targets)],
          );
        }
        const received = new Map<string, Set<string>>();
        for (const requester of truth.requesters) {
          const rows = await tx.unsafe<{ id: string }[]>(query, [requester.userId]);
          received.set(requester.userId, new Set(rows.map((row) => row.id)));
        }
        expect(
          findSyncDivergences(
            truth,
            (requester, row) => received.get(requester.userId)?.has(row.id) === true,
          ),
        ).toEqual([]);
        compared += truth.cases.length;
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    expect(compared).toBeGreaterThan(100);
  });
});

describe.skipIf(sql === undefined)('content rules as PostgreSQL SQL (feature 16 task 04)', () => {
  test('the PostgreSQL rendering agrees with decide on shadow tables, tombstones included', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const queries = compileProviderQueries(
      registry(),
      SYNC_RULE_BINDINGS,
      MEMBERSHIP,
      POSTGRES_DIALECT,
    );
    let compared = 0;
    try {
      await sql.begin(async (tx) => {
        for (const table of [MEMBERSHIP.source, ...CONTENT_CLASSES.map((item) => item.table)]) {
          // Real columns and NOT NULLs, no CHECKs: observers and every truth-table row fit.
          await tx.unsafe(
            `create temp table ${table} (like public.${table} including defaults) on commit drop`,
          );
        }
        for (const { resourceClass, table } of CONTENT_CLASSES) {
          const truth = syncTruthTable(registry(), resourceClass, {
            newId: () => crypto.randomUUID(),
          });
          await tx.unsafe(`delete from ${MEMBERSHIP.source}`);
          for (const requester of truth.requesters) {
            for (const membership of requester.memberships) {
              await tx.unsafe(
                `insert into ${MEMBERSHIP.source} (campaign_id, user_id, role, removed_at)
                  values ($1, $2, $3, $4)`,
                [
                  membership.campaignId,
                  requester.userId,
                  membership.role,
                  membership.removed ? new Date('2026-09-01T00:00:00Z') : null,
                ],
              );
            }
          }
          const someone = crypto.randomUUID();
          for (const row of truth.rows) {
            const visibility = row.facts.visibility;
            const targets =
              visibility.mode === 'players'
                ? visibility.playerIds
                : visibility.mode === 'party'
                  ? visibility.partyIds
                  : [];
            const author = row.facts.authorUserId ?? someone;
            const common = [
              row.id,
              row.facts.campaignId,
              visibility.mode,
              tx.json(targets),
              row.deleted ? new Date('2026-10-01T00:00:00Z') : null,
              author,
            ];
            if (table === 'content_entity_relationships') {
              // Shadow tables carry no foreign keys or CHECKs: endpoints are arbitrary ids.
              await tx.unsafe(
                `insert into content_entity_relationships (id, campaign_id, source_entity_id,
                  target_entity_id, kind, visibility_mode, visibility_targets, deleted_at,
                  created_by, updated_by)
                 values ($1, $2, gen_random_uuid(), gen_random_uuid(), 'knows', $3, $4::jsonb, $5,
                  $6, $6)`,
                common,
              );
            } else if (table === 'content_entities') {
              await tx.unsafe(
                `insert into content_entities (id, campaign_id, type, name, visibility_mode,
                  visibility_targets, deleted_at, created_by, updated_by)
                 values ($1, $2, 'probe', 'Probe', $3, $4::jsonb, $5, $6, $6)`,
                common,
              );
            } else {
              await tx.unsafe(
                `insert into content_personal_notes (id, campaign_id, author_user_id, name,
                  visibility_mode, visibility_targets, deleted_at, created_by, updated_by)
                 values ($1, $2, $6, 'Probe', $3, $4::jsonb, $5, $6, $6)`,
                common,
              );
            }
          }
          const query = queries.find((item) => item.resourceClass === resourceClass)?.query ?? '';
          const received = new Map<string, Set<string>>();
          for (const requester of truth.requesters) {
            const rows = await tx.unsafe<{ id: string }[]>(query, [requester.userId]);
            received.set(requester.userId, new Set(rows.map((row) => row.id)));
          }
          expect({
            resourceClass,
            divergences: findSyncDivergences(
              truth,
              (requester, row) => received.get(requester.userId)?.has(row.id) === true,
            ),
          }).toEqual({ resourceClass, divergences: [] });
          compared += truth.cases.length;
        }
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    expect(compared).toBeGreaterThan(2000);
  });
});

describe.skipIf(sql === undefined)('sync-config.yaml on simulated replicas (PostgreSQL)', () => {
  test('API and sync visibility matrices agree for every configured query, observers included', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    // The configured PowerSync queries run verbatim (requester bound as $1) against session-local
    // shadow copies of the real tables (`LIKE ... INCLUDING DEFAULTS`: real columns, no role
    // CHECK, so an observer membership is representable). Rolled back; nothing is committed.
    // Audit streams have their own simulated-replica check (`audit-sync.integration.test.ts`).
    const auditSources = AUDIT_SYNC_STORES.map((store) => store.source);
    const configured = streamQueries(await Bun.file(SYNC_CONFIG).text()).filter(
      (item) => !auditSources.includes(item.table),
    );
    expect(configured.map((item) => item.table).sort()).toEqual(
      [
        'campaign_settings',
        'campaigns',
        MEMBERSHIP.source,
        'sync_long_text_holds',
        'content_entities',
        'content_personal_notes',
        'content_entity_relationships',
        'dice_rolls',
        'effect_applications',
        'characters',
        'character_secrets',
        'campaign_sessions',
        'session_gm_notes',
        'session_log_entries',
        'encounters',
        'encounter_gm_notes',
        'encounter_participants',
        'encounter_participant_states',
        'rules_section_marks',
        ...Object.keys(EXPORT_REPLICA_TABLES),
      ].sort(),
    );
    const id = () => crypto.randomUUID();
    const users = {
      owner: id(),
      gm: id(),
      assistant_gm: id(),
      player: id(),
      player_b: id(),
      observer: id(),
      removed_gm: id(),
      non_member: id(),
      other_campaign_owner: id(),
    };
    const campaign = id();
    const otherCampaign = id();
    const deletedCampaign = id();
    const memberships: { campaign: string; user: string; role: Role; removed: boolean }[] = [
      { campaign, user: users.owner, role: 'owner', removed: false },
      { campaign, user: users.gm, role: 'gm', removed: false },
      { campaign, user: users.assistant_gm, role: 'assistant_gm', removed: false },
      { campaign, user: users.player, role: 'player', removed: false },
      { campaign, user: users.player_b, role: 'player', removed: false },
      { campaign, user: users.observer, role: 'observer', removed: false },
      { campaign, user: users.removed_gm, role: 'gm', removed: true },
      { campaign: otherCampaign, user: users.other_campaign_owner, role: 'owner', removed: false },
      { campaign: deletedCampaign, user: users.player, role: 'player', removed: false },
    ];
    const campaignRows = [
      { id: campaign, deleted: false },
      { id: otherCampaign, deleted: false },
      { id: deletedCampaign, deleted: true },
    ];
    const settings = [
      { campaign, namespace: 'probe.shared', memberVisible: true, deleted: false },
      { campaign, namespace: 'probe.gm', memberVisible: false, deleted: false },
      { campaign, namespace: 'probe.gm_deleted', memberVisible: false, deleted: true },
      { campaign, namespace: 'probe.shared_deleted', memberVisible: true, deleted: true },
      { campaign: otherCampaign, namespace: 'probe.shared', memberVisible: true, deleted: false },
    ];
    // Feature 16: entities of every Visibility, live and tombstoned, and personal notes.
    const entities = [
      { id: id(), campaign, visibility: { mode: 'gm_only' } as Visibility, deleted: false },
      { id: id(), campaign, visibility: { mode: 'everyone' } as Visibility, deleted: false },
      {
        id: id(),
        campaign,
        visibility: { mode: 'players', playerIds: [users.player] } as Visibility,
        deleted: false,
      },
      {
        id: id(),
        campaign,
        visibility: {
          mode: 'players',
          playerIds: [users.player, users.player_b].sort(),
        } as Visibility,
        deleted: false,
      },
      // A gm_only entity deleted before any player could see it: an unseen tombstone.
      { id: id(), campaign, visibility: { mode: 'gm_only' } as Visibility, deleted: true },
      { id: id(), campaign, visibility: { mode: 'everyone' } as Visibility, deleted: true },
      {
        id: id(),
        campaign: otherCampaign,
        visibility: { mode: 'everyone' } as Visibility,
        deleted: false,
      },
    ];
    const notes = [
      { id: id(), campaign, author: users.player, deleted: false },
      { id: id(), campaign, author: users.player, deleted: true },
      { id: id(), campaign, author: users.player_b, deleted: false },
    ];
    const hiddenEntity = entities[0]?.id ?? '';
    // Task 08: relationships as the write path stores them (never wider than either endpoint).
    const entityId = (index: number) => entities[index]?.id ?? '';
    const relationships = [
      // To a gm_only endpoint: gm_only (neither the link nor the hidden id reaches a player).
      {
        id: id(),
        campaign,
        source: entityId(1),
        target: hiddenEntity,
        visibility: { mode: 'gm_only' } as Visibility,
        deleted: false,
      },
      // Both endpoints everyone, revealed to everyone; one endpoint tombstoned (broken link).
      {
        id: id(),
        campaign,
        source: entityId(1),
        target: entityId(5),
        visibility: { mode: 'everyone' } as Visibility,
        deleted: false,
      },
      // Bounded by a players:[player] endpoint.
      {
        id: id(),
        campaign,
        source: entityId(2),
        target: entityId(1),
        visibility: { mode: 'players', playerIds: [users.player] } as Visibility,
        deleted: false,
      },
      // A gm_only link deleted before any player could see it: an unseen tombstone.
      {
        id: id(),
        campaign,
        source: entityId(1),
        target: entityId(3),
        visibility: { mode: 'gm_only' } as Visibility,
        deleted: true,
      },
    ];
    const hiddenRelationship = relationships[0]?.id ?? '';
    const playerNote = notes[0]?.id ?? '';
    const holds = [
      { campaign, resourceClass: 'campaign', recordId: campaign, holder: users.gm },
      // A hold names its record. On a gm_only entity it reaches the GM roles only.
      { campaign, resourceClass: 'campaign_entity', recordId: hiddenEntity, holder: users.gm },
      // On a personal note it reaches its holder (the author) only.
      { campaign, resourceClass: 'personal_note', recordId: playerNote, holder: users.player },
      {
        campaign,
        resourceClass: 'entity_relationship',
        recordId: hiddenRelationship,
        holder: users.gm,
      },
      // A class with no hold branch reaches nobody.
      { campaign, resourceClass: 'fixture.gm_secret', recordId: id(), holder: users.gm },
      {
        campaign: otherCampaign,
        resourceClass: 'campaign',
        recordId: otherCampaign,
        holder: users.other_campaign_owner,
      },
    ];
    const authorization = new AuthorizationService(registry());
    const roleOf = (userId: string, campaignId: string) =>
      memberships.find(
        (item) => item.user === userId && item.campaign === campaignId && !item.removed,
      )?.role;
    const reads = (
      userId: string,
      campaignId: string,
      resourceClass: string,
      visibility: Visibility,
      authorUserId?: string,
    ) => {
      const role = roleOf(userId, campaignId);
      return (
        role !== undefined &&
        authorization.decide({ userId, campaignId, role }, 'read', {
          campaignId,
          resourceClass,
          resourceId: campaignId,
          visibility,
          version: 1,
          ...(authorUserId === undefined ? {} : { authorUserId }),
        }).allowed
      );
    };
    const everyone: Visibility = { mode: 'everyone' };
    const gmRoles: readonly Role[] = ['owner', 'gm', 'assistant_gm'];
    const expected = (userId: string): Record<string, string[]> => ({
      campaigns: campaignRows
        .filter((row) => reads(userId, row.id, 'campaign', everyone))
        .map((row) => row.id),
      campaign_settings: settings
        .filter((row) =>
          reads(
            userId,
            row.campaign,
            'campaign',
            row.memberVisible ? everyone : { mode: 'gm_only' },
          ),
        )
        .map((row) => `${row.campaign}:${row.namespace}`),
      sync_long_text_holds: holds
        .filter((row) => {
          if (!reads(userId, row.campaign, 'campaign', everyone)) return false;
          if (row.resourceClass === 'campaign') return true;
          const role = roleOf(userId, row.campaign);
          if (row.resourceClass === 'campaign_entity')
            return role !== undefined && gmRoles.includes(role);
          if (row.resourceClass === 'personal_note') return row.holder === userId;
          if (row.resourceClass === 'entity_relationship')
            return role !== undefined && gmRoles.includes(role);
          return false;
        })
        .map((row) => `${row.campaign}:${row.resourceClass}:${row.recordId}:body`),
      [MEMBERSHIP.source]: memberships
        .filter((row) => row.user === userId)
        .map((row) => row.campaign),
      content_entities: entities
        .filter((row) => reads(userId, row.campaign, 'campaign_entity', row.visibility))
        .map((row) => row.id),
      content_personal_notes: notes
        .filter((row) =>
          reads(
            userId,
            row.campaign,
            'personal_note',
            { mode: 'players', playerIds: [row.author] },
            row.author,
          ),
        )
        .map((row) => row.id),
      content_entity_relationships: relationships
        .filter((row) => reads(userId, row.campaign, 'entity_relationship', row.visibility))
        .map((row) => row.id),
      effect_applications: [
        { id: effectHidden, visibility: { mode: 'gm_only' } as Visibility },
        { id: effectShared, visibility: everyone },
      ]
        .filter((row) => reads(userId, campaign, 'effect_application', row.visibility))
        .map((row) => row.id),
      dice_rolls: rolls
        .filter((row) => reads(userId, row.campaign, 'dice_roll', row.visibility))
        .map((row) => row.id),
      campaign_system_pins: reads(userId, campaign, 'campaign', everyone) ? [campaign] : [],
      campaign_module_pins: reads(userId, campaign, 'campaign', everyone)
        ? [`${campaign}:extra`]
        : [],
      attachments: mayExport(userId) ? [readyAttachment] : [],
      import_preserved_chunks: mayExport(userId) ? [`${campaign}:future-notes:4`] : [],
    });
    const effectHidden = id();
    const effectShared = id();
    const rolls: readonly {
      id: string;
      campaign: string;
      label: string;
      visibility: Visibility;
    }[] = [
      { id: id(), campaign, label: 'public', visibility: everyone },
      { id: id(), campaign, label: 'gm_only', visibility: { mode: 'gm_only' } },
      { id: id(), campaign, label: 'blind', visibility: { mode: 'gm_only' } },
      {
        id: id(),
        campaign,
        label: 'player_only',
        visibility: { mode: 'players', playerIds: [users.player] },
      },
      {
        id: id(),
        campaign,
        label: 'whisper',
        visibility: { mode: 'players', playerIds: [users.player_b] },
      },
      { id: id(), campaign: otherCampaign, label: 'public', visibility: everyone },
    ];
    const readyAttachment = id();
    const mayExport = (userId: string) => {
      const role = roleOf(userId, campaign);
      return (
        role !== undefined &&
        authorization.decide({ userId, campaignId: campaign, role }, 'export', {
          campaignId: campaign,
          resourceClass: 'campaign',
          resourceId: campaign,
          visibility: everyone,
          version: 1,
        }).allowed
      );
    };

    let compared = 0;
    const payloads = new Map<string, string>();
    try {
      await sql.begin(async (tx) => {
        const shadowed = [
          'campaigns',
          'campaign_settings',
          'sync_long_text_holds',
          MEMBERSHIP.source,
          'content_entities',
          'content_personal_notes',
          'content_entity_relationships',
          'dice_rolls',
          'effect_applications',
          ...Object.keys(EXPORT_REPLICA_TABLES),
        ];
        for (const table of shadowed) {
          await tx.unsafe(
            `create temp table ${table} (like public.${table} including defaults) on commit drop`,
          );
        }
        for (const row of campaignRows) {
          await tx`insert into campaigns (id, name, game_mode, created_by, deleted_at)
            values (${row.id}, 'Replica probe', 'standard', ${users.owner},
              ${row.deleted ? new Date('2026-10-01T00:00:00Z') : null})`;
        }
        for (const item of memberships) {
          await tx.unsafe(
            `insert into ${MEMBERSHIP.source} (campaign_id, user_id, role, removed_at)
              values ($1, $2, $3, $4)`,
            [
              item.campaign,
              item.user,
              item.role,
              item.removed ? new Date('2026-09-01T00:00:00Z') : null,
            ],
          );
        }
        for (const row of settings) {
          await tx`insert into campaign_settings
              (campaign_id, namespace, value, member_visible, updated_by, deleted_at)
            values (${row.campaign}, ${row.namespace}, ${tx.json({ probe: true })},
              ${row.memberVisible}, ${users.owner},
              ${row.deleted ? new Date('2026-10-02T00:00:00Z') : null})`;
        }
        const at = new Date('2026-10-26T00:00:00Z');
        for (const row of holds) {
          await tx`insert into sync_long_text_holds (campaign_id, resource_class, record_id,
              field_path, holder_user_id, holder_session_id, acquired_at, renewed_at, expires_at,
              version)
            values (${row.campaign}, ${row.resourceClass}, ${row.recordId}, 'body', ${row.holder},
              ${id()}, ${at}, ${at}, ${at}, 1)`;
        }
        const insertEntity = (row: {
          id: string;
          campaign: string;
          visibility: Visibility;
          deleted: boolean;
        }) =>
          tx`insert into content_entities (id, campaign_id, type, name, visibility_mode,
              visibility_targets, created_by, updated_by, deleted_at)
            values (${row.id}, ${row.campaign}, 'npc', 'Replica probe', ${row.visibility.mode},
              ${tx.json(row.visibility.mode === 'players' ? row.visibility.playerIds : [])},
              ${users.gm}, ${users.gm}, ${row.deleted ? new Date('2026-10-03T00:00:00Z') : null})`;
        const insertNote = (row: {
          id: string;
          campaign: string;
          author: string;
          deleted: boolean;
        }) =>
          tx`insert into content_personal_notes (id, campaign_id, author_user_id, name,
              visibility_mode, visibility_targets, created_by, updated_by, deleted_at)
            values (${row.id}, ${row.campaign}, ${row.author}, 'Private probe', 'players',
              ${tx.json([row.author])}, ${row.author}, ${row.author},
              ${row.deleted ? new Date('2026-10-03T00:00:00Z') : null})`;
        for (const row of entities) await insertEntity(row);
        for (const row of notes) await insertNote(row);
        for (const row of relationships) {
          await tx`insert into content_entity_relationships (id, campaign_id, source_entity_id,
              target_entity_id, kind, visibility_mode, visibility_targets, created_by, updated_by,
              deleted_at)
            values (${row.id}, ${row.campaign}, ${row.source}, ${row.target}, 'knows',
              ${row.visibility.mode},
              ${tx.json(row.visibility.mode === 'players' ? row.visibility.playerIds : [])},
              ${users.gm}, ${users.gm}, ${row.deleted ? new Date('2026-10-03T00:00:00Z') : null})`;
        }

        const insertRoll = (row: (typeof rolls)[number]) =>
          tx`insert into dice_rolls (id, campaign_id, actor_user_id, expression, result,
              natural_result, modified_result, roll_visibility, visibility_mode,
              visibility_targets, rolled_at)
            values (${row.id}, ${row.campaign}, ${users.gm}, '1d6', ${tx.json({ terms: [] })}, 1, 1,
              ${row.label}, ${row.visibility.mode},
              ${tx.json(row.visibility.mode === 'players' ? row.visibility.playerIds : [])}, ${at})`;
        for (const row of rolls) await insertRoll(row);
        for (const [rowId, mode] of [
          [effectHidden, 'gm_only'],
          [effectShared, 'everyone'],
        ] as const) {
          await tx`insert into effect_applications (id, campaign_id, actor_user_id, target_class,
              target_id, operations, visibility_mode, applied_at)
            values (${rowId}, ${campaign}, ${users.gm}, 'probe', ${id()}, ${tx.json([])}, ${mode},
              ${at})`;
        }

        // Feature 07 task 05: the exact pins, and the export metadata in all the states it has.
        await tx`insert into campaign_system_pins (campaign_id, system_id, system_version)
          values (${campaign}, 'fixture-system', '0.1.0')`;
        await tx`insert into campaign_module_pins (campaign_id, module_id, module_version)
          values (${campaign}, 'extra', '1.0.0')`;
        await tx`insert into import_preserved_chunks
            (campaign_id, module_id, chunk_version, payload, payload_checksum)
          values (${campaign}, 'future-notes', '4', ${tx.json({ hidden: 'payload' })},
            ${Buffer.alloc(32)})`;
        for (const [attachment, status, deleted] of [
          [readyAttachment, 'ready', false],
          [id(), 'pending', false],
          [id(), 'ready', true],
        ] as const) {
          await tx`insert into attachments (id, campaign_id, owner_resource_class, owner_resource_id,
              filename, mime_type, declared_size, verified_size, declared_checksum,
              verified_checksum, object_key, status, visibility_mode, created_by, updated_by,
              finalized_at, deleted_at)
            values (${attachment}, ${campaign}, 'campaign_entity', ${id()}, 'map.png', 'image/png',
              3, 3, ${Buffer.alloc(32, 171)}, ${Buffer.alloc(32, 205)}, ${attachment}, ${status},
              'gm_only', ${users.gm}, ${users.gm}, ${at}, ${deleted ? at : null})`;
        }

        const payloadOf = async (userId: string) => {
          const parts: string[] = [];
          for (const item of configured) {
            const rows = await tx.unsafe<Record<string, unknown>[]>(toPostgres(item.query), [
              userId,
            ]);
            parts.push(
              JSON.stringify(
                rows
                  .map((row) => JSON.stringify(row))
                  .sort()
                  .map((row) => `${item.table}:${row}`),
              ),
            );
          }
          return parts.join('\n');
        };
        for (const userId of Object.values(users)) {
          const wanted = expected(userId);
          for (const item of configured) {
            const rows = await tx.unsafe<{ id: string }[]>(toPostgres(item.query), [userId]);
            expect({ userId, table: item.table, ids: rows.map((row) => row.id).sort() }).toEqual({
              userId,
              table: item.table,
              ids: [...(wanted[item.table] ?? [])].sort(),
            });
            compared += 1;
          }
          payloads.set(userId, await payloadOf(userId));
        }

        // 25 hidden inserts and deletes (GM-only entities, player B's notes, holds on both) leave
        // player A's payload byte-identical; the owner sees the entities.
        const hidden: string[] = [];
        for (let index = 0; index < 25; index += 1) {
          const entity = { id: id(), campaign, visibility: { mode: 'gm_only' } as Visibility };
          await insertEntity({ ...entity, deleted: false });
          await insertNote({
            id: id(),
            campaign,
            author: users.player_b,
            deleted: index % 2 === 0,
          });
          await tx`insert into sync_long_text_holds (campaign_id, resource_class, record_id,
              field_path, holder_user_id, holder_session_id, acquired_at, renewed_at, expires_at,
              version)
            values (${campaign}, 'campaign_entity', ${entity.id}, 'description', ${users.gm},
              ${id()}, ${at}, ${at}, ${at}, 1)`;
          hidden.push(entity.id);
          await insertRoll({
            id: id(),
            campaign,
            label: index % 2 === 0 ? 'gm_only' : 'blind',
            visibility: { mode: 'gm_only' },
          });
        }
        await tx`update content_entities set deleted_at = now(), version = version + 1
          where id = any(${hidden.slice(0, 12)}::uuid[])`;
        expect(await payloadOf(users.player)).toBe(payloads.get(users.player) ?? '');
        const ownerEntities = await tx.unsafe<{ id: string }[]>(
          toPostgres(configured.find((item) => item.table === 'content_entities')?.query ?? ''),
          [users.owner],
        );
        expect(hidden.every((value) => ownerEntities.some((row) => row.id === value))).toBe(true);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    expect(compared).toBe(Object.keys(users).length * configured.length);
    // A player receives the member-visible live and deleted settings, never a GM-only one.
    const player = expected(users.player);
    expect((player.campaign_settings ?? []).some((key) => key.includes('probe.gm'))).toBe(false);
    expect(player.campaign_settings).toContain(`${campaign}:probe.shared_deleted`);
    // Player A: no gm_only entity (live or unseen tombstone), only their own notes, no entity
    // hold, their own note hold; player B's note never.
    const payload = payloads.get(users.player) ?? '';
    expect(payload).not.toContain(hiddenEntity);
    expect(payload).not.toContain(entities[4]?.id ?? 'x');
    expect(payload).not.toContain(notes[2]?.id ?? 'x');
    // Task 08: no hidden link and no unseen link tombstone; the bounded and broken links arrive.
    expect(payload).not.toContain(hiddenRelationship);
    expect(payload).not.toContain(relationships[3]?.id ?? 'x');
    expect(player.content_entity_relationships?.sort()).toEqual(
      [relationships[1]?.id ?? '', relationships[2]?.id ?? ''].sort(),
    );
    expect(expected(users.player_b).content_entity_relationships).toEqual([
      relationships[1]?.id ?? '',
    ]);
    expect(player.content_entities).toContain(entities[5]?.id);
    expect(player.content_personal_notes?.sort()).toEqual(
      [notes[0]?.id ?? '', notes[1]?.id ?? ''].sort(),
    );
    expect(player.sync_long_text_holds).toEqual([
      `${campaign}:campaign:${campaign}:body`,
      `${campaign}:personal_note:${playerNote}:body`,
    ]);
    // Feature 09: zero hidden rolls on a player replica; their own and public ones arrive.
    expect(payload).not.toContain(rolls[1]?.id ?? 'x');
    expect(payload).not.toContain(rolls[2]?.id ?? 'x');
    expect(payload).not.toContain(rolls[4]?.id ?? 'x');
    // Feature 11: a record on a hidden target never reaches a player.
    expect(payload).not.toContain(effectHidden);
    expect(player.effect_applications).toEqual([effectShared]);
    expect(player.dice_rolls?.sort()).toEqual([rolls[0]?.id ?? '', rolls[3]?.id ?? ''].sort());
    expect(expected(users.player_b).dice_rolls?.sort()).toEqual(
      [rolls[0]?.id ?? '', rolls[4]?.id ?? ''].sort(),
    );
    for (const gm of [users.owner, users.gm, users.assistant_gm]) {
      expect(expected(gm).dice_rolls?.sort()).toEqual(
        rolls
          .filter((row) => row.campaign === campaign)
          .map((row) => row.id)
          .sort(),
      );
    }
    // GM roles: every entity, no personal note, the entity hold but not the note hold.
    for (const gm of [users.owner, users.gm, users.assistant_gm]) {
      const rows = expected(gm);
      expect(rows.content_personal_notes).toEqual([]);
      expect(rows.sync_long_text_holds).toContain(
        `${campaign}:campaign_entity:${hiddenEntity}:body`,
      );
      expect(rows.sync_long_text_holds).not.toContain(
        `${campaign}:personal_note:${playerNote}:body`,
      );
      expect(payloads.get(gm)).not.toContain(playerNote);
    }
    // Observers and outsiders receive nothing but their own membership rows.
    for (const outsider of [users.observer, users.removed_gm, users.non_member]) {
      const rows = expected(outsider);
      expect([
        rows.campaigns,
        rows.campaign_settings,
        rows.sync_long_text_holds,
        rows.content_entities,
        rows.content_personal_notes,
        rows.content_entity_relationships,
        rows.dice_rolls,
        rows.effect_applications,
      ]).toEqual([[], [], [], [], [], [], [], []]);
    }
  });
});
