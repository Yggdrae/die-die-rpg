import { describe, expect, test } from 'bun:test';
import {
  AUTHOR_PRIVATE_NOTE_FIXTURE,
  type ResourcePolicy,
  ResourcePolicyRegistry,
  SyncPredicateCompiler,
} from '@rpg/authorization';
import {
  type AuditSyncStore,
  compileAuditProviderQueries,
  compileProviderQueries,
  type MembershipRelation,
  normalizeSql,
  POSTGRES_DIALECT,
  renderAuditSyncQuery,
  renderSyncRuleQuery,
  type SyncRuleBinding,
  SyncRuleTranslationError,
} from './sync-rules.ts';

/** Feature 04 task 05: PowerSync/PostgreSQL translation of the compiled predicate AST. */

const MEMBERS: MembershipRelation = {
  source: 'fixture_members',
  userColumn: 'user_id',
  campaignColumn: 'campaign_id',
  roleColumn: 'role',
  removedAtColumn: 'removed_at',
};

const visibility = { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' } as const;

const HANDOUT: ResourcePolicy = {
  resourceClass: 'fixture.handout',
  capabilities: ['read', 'reveal'],
  roleCapabilities: {
    owner: ['read', 'reveal'],
    gm: ['read', 'reveal'],
    assistant_gm: ['read', 'reveal'],
    player: ['read'],
    observer: [],
  },
  defaultVisibility: { mode: 'gm_only' },
  sync: {
    kind: 'replicated',
    source: 'fixture_handouts',
    campaignColumn: 'campaign_id',
    visibility,
    deletedAtColumn: 'deleted_at',
  },
};

const WIDE: ResourcePolicy = {
  resourceClass: 'fixture.wide',
  capabilities: ['read'],
  roleCapabilities: {
    owner: ['read'],
    gm: ['read'],
    assistant_gm: ['read'],
    player: ['read'],
    observer: [],
  },
  defaultVisibility: { mode: 'everyone' },
  sync: {
    kind: 'replicated',
    source: 'fixture_wide',
    campaignColumn: 'id',
    visibility: 'campaign_wide',
    deletedAtColumn: 'deleted_at',
  },
};

const SERVER_ONLY: ResourcePolicy = {
  ...WIDE,
  resourceClass: 'fixture.server_only',
  sync: { kind: 'server_only' },
};

const COLUMNS = ['id', 'campaign_id', 'visibility_mode', 'visibility_targets', 'deleted_at'];
const BINDINGS: SyncRuleBinding[] = [
  {
    resourceClass: HANDOUT.resourceClass,
    stream: 'campaign_content',
    columns: COLUMNS,
  },
  {
    resourceClass: WIDE.resourceClass,
    stream: 'authorized',
    columns: ['id', 'name', 'deleted_at'],
  },
  {
    resourceClass: AUTHOR_PRIVATE_NOTE_FIXTURE.resourceClass,
    stream: 'campaign_content',
    columns: [...COLUMNS, 'author_user_id'],
  },
];

function registry(partyTargeting: 'inactive' | 'active' = 'inactive') {
  const value = new ResourcePolicyRegistry({ partyTargeting });
  for (const policy of [HANDOUT, WIDE, AUTHOR_PRIVATE_NOTE_FIXTURE, SERVER_ONLY]) {
    value.register(policy);
  }
  return value;
}

function rule(policy: ResourcePolicy, partyTargeting: 'inactive' | 'active' = 'inactive') {
  return new SyncPredicateCompiler(registry(partyTargeting)).compile(policy.resourceClass).rule;
}

function failure(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncRuleTranslationError) return error.code;
    throw error;
  }
  return undefined;
}

describe('PowerSync translation', () => {
  test('a targeted class filters by current membership, role, and Visibility', () => {
    expect(renderSyncRuleQuery(rule(HANDOUT), BINDINGS[0] as SyncRuleBinding, MEMBERS)).toBe(
      [
        'SELECT fixture_handouts.id, fixture_handouts.campaign_id, fixture_handouts.visibility_mode,' +
          ' fixture_handouts.visibility_targets, fixture_handouts.deleted_at',
        'FROM fixture_handouts',
        'INNER JOIN fixture_members m ON m.campaign_id = fixture_handouts.campaign_id',
        'WHERE m.user_id = auth.user_id()',
        '  AND m.removed_at IS NULL',
        `  AND m.role IN '["owner","gm","assistant_gm","player"]'`,
        "  AND (fixture_handouts.visibility_mode = 'everyone'" +
          " OR (fixture_handouts.visibility_mode = 'players'" +
          ' AND auth.user_id() IN fixture_handouts.visibility_targets)' +
          ` OR (m.role IN '["owner","gm","assistant_gm"]'` +
          ` AND fixture_handouts.visibility_mode IN '["gm_only","players"]'))`,
      ].join('\n'),
    );
  });

  test('a campaign-wide class needs no Visibility columns', () => {
    expect(renderSyncRuleQuery(rule(WIDE), BINDINGS[1] as SyncRuleBinding, MEMBERS)).toBe(
      [
        'SELECT fixture_wide.id, fixture_wide.name, fixture_wide.deleted_at',
        'FROM fixture_wide',
        'INNER JOIN fixture_members m ON m.campaign_id = fixture_wide.id',
        'WHERE m.user_id = auth.user_id()',
        '  AND m.removed_at IS NULL',
        `  AND m.role IN '["owner","gm","assistant_gm","player"]'`,
      ].join('\n'),
    );
  });

  test('author-private rows compare the author column with the requester, no GM override', () => {
    const query = renderSyncRuleQuery(
      rule(AUTHOR_PRIVATE_NOTE_FIXTURE),
      BINDINGS[2] as SyncRuleBinding,
      MEMBERS,
    );
    expect(query).toContain('  AND fixture_author_private_notes.author_user_id = auth.user_id()\n');
    expect(query).not.toMatch(/OR fixture_author_private_notes\.author_user_id/);
  });

  test('tombstones are not filtered out: they follow the same predicate', () => {
    for (const query of compileProviderQueries(registry(), BINDINGS, MEMBERS)) {
      expect(query.query).not.toMatch(/deleted_at IS (NOT )?NULL/);
    }
  });

  test('the PostgreSQL dialect renders the same structure with a requester parameter', () => {
    const query = renderSyncRuleQuery(
      rule(HANDOUT),
      BINDINGS[0] as SyncRuleBinding,
      MEMBERS,
      POSTGRES_DIALECT,
    );
    expect(query).toContain('WHERE m.user_id = $1::uuid');
    expect(query).toContain('fixture_handouts.visibility_targets @> jsonb_build_array($1::uuid)');
    expect(query).not.toContain('auth.user_id()');
    expect(query).toContain("AND m.role IN ('owner', 'gm', 'assistant_gm', 'player')\n");
  });

  test('compiles registered classes in order and skips server-only classes', () => {
    const queries = compileProviderQueries(registry(), BINDINGS, MEMBERS);
    expect(queries.map((query) => [query.resourceClass, query.stream, query.source])).toEqual([
      ['fixture.handout', 'campaign_content', 'fixture_handouts'],
      ['fixture.wide', 'authorized', 'fixture_wide'],
      ['fixture.author_private_note', 'campaign_content', 'fixture_author_private_notes'],
    ]);
  });

  test('normalizeSql ignores layout only', () => {
    expect(normalizeSql('SELECT a,\n   b\nFROM t  WHERE ( x = 1 )')).toBe(
      'SELECT a, b FROM t WHERE (x = 1)',
    );
  });
});

describe('translation fails closed', () => {
  test('party predicates are untranslatable until a party resolver exists', () => {
    expect(
      failure(() =>
        renderSyncRuleQuery(rule(HANDOUT, 'active'), BINDINGS[0] as SyncRuleBinding, MEMBERS),
      ),
    ).toBe('unsupported_predicate');
  });

  test('bindings must match the registered replicated classes exactly', () => {
    expect(failure(() => compileProviderQueries(registry(), BINDINGS.slice(1), MEMBERS))).toBe(
      'missing_binding',
    );
    expect(
      failure(() =>
        compileProviderQueries(
          registry(),
          [
            ...BINDINGS,
            { ...(BINDINGS[1] as SyncRuleBinding), resourceClass: 'fixture.server_only' },
          ],
          MEMBERS,
        ),
      ),
    ).toBe('unexpected_binding');
    expect(
      failure(() =>
        compileProviderQueries(
          registry(),
          [...BINDINGS, { ...(BINDINGS[1] as SyncRuleBinding), resourceClass: 'fixture.unknown' }],
          MEMBERS,
        ),
      ),
    ).toBe('unexpected_binding');
    expect(
      failure(() =>
        compileProviderQueries(registry(), [...BINDINGS, BINDINGS[0] as SyncRuleBinding], MEMBERS),
      ),
    ).toBe('duplicate_binding');
  });

  test('a projection must carry the columns the offline decision needs', () => {
    const binding = BINDINGS[2] as SyncRuleBinding;
    for (const column of [
      'id',
      'campaign_id',
      'visibility_mode',
      'visibility_targets',
      'deleted_at',
      'author_user_id',
    ]) {
      expect(
        failure(() =>
          renderSyncRuleQuery(
            rule(AUTHOR_PRIVATE_NOTE_FIXTURE),
            { ...binding, columns: binding.columns.filter((item) => item !== column) },
            MEMBERS,
          ),
        ),
      ).toBe('missing_projection_column');
    }
  });

  test('identifiers are validated and the membership alias is reserved', () => {
    const binding = BINDINGS[0] as SyncRuleBinding;
    expect(
      failure(() =>
        renderSyncRuleQuery(
          rule(HANDOUT),
          { ...binding, columns: [...COLUMNS, 'x; drop table y'] },
          MEMBERS,
        ),
      ),
    ).toBe('invalid_identifier');
    expect(
      failure(() => renderSyncRuleQuery(rule(HANDOUT), binding, { ...MEMBERS, source: 'Members' })),
    ).toBe('invalid_identifier');
    const handout = rule(HANDOUT);
    const source = handout.source;
    if (source === undefined) throw new Error('handout replicates');
    // The source table is unaliased (PowerSync 1.25.0), so a source named `m` would collide.
    expect(
      failure(() =>
        renderSyncRuleQuery({ ...handout, source: { ...source, source: 'm' } }, binding, MEMBERS),
      ),
    ).toBe('reserved_alias');
    expect(failure(() => renderSyncRuleQuery(rule(SERVER_ONLY), binding, MEMBERS))).toBe(
      'never_replicates',
    );
  });
});

/** Feature 06 task 04: audit store queries compiled from the same declarations. */
describe('audit store translation', () => {
  const columns = {
    campaign: 'campaign_id',
    targetType: 'target_type',
    targetId: 'target_id',
    snapshot: 'target_visibility',
    acceptedAt: 'accepted_at',
  } as const;
  const STORES: AuditSyncStore[] = [
    {
      store: 'campaign',
      source: 'fixture_audit',
      stream: 'audit',
      projection: ['id', 'campaign_id', 'action'],
      columns,
    },
    {
      store: 'private',
      source: 'fixture_private_audit',
      stream: 'private_audit',
      projection: ['id', 'campaign_id', 'action'],
      columns,
    },
  ];

  test('only provable classes replicate; the rest stay online-only with a reason', () => {
    const compiled = compileAuditProviderQueries(registry(), STORES, MEMBERS);
    expect(compiled.queries.map((item) => [item.store, item.targetClass])).toEqual([
      ['campaign', WIDE.resourceClass],
      ['private', WIDE.resourceClass],
    ]);
    expect(compiled.excluded).toEqual([
      // Per-record campaign column: the provider cannot prove the record's campaign.
      { targetClass: HANDOUT.resourceClass, reason: 'campaign_scope_unprovable' },
      { targetClass: AUTHOR_PRIVATE_NOTE_FIXTURE.resourceClass, reason: 'ownership_on_read' },
      { targetClass: SERVER_ONLY.resourceClass, reason: 'never_replicates' },
    ]);
  });

  test('current target, snapshot, window, and private GM narrowing in one query', () => {
    const [campaign, gmPrivate] = compileAuditProviderQueries(registry(), STORES, MEMBERS).queries;
    expect(campaign?.query).toBe(
      [
        'SELECT fixture_audit.id, fixture_audit.campaign_id, fixture_audit.action',
        'FROM fixture_audit',
        'INNER JOIN fixture_members m ON m.campaign_id = fixture_audit.campaign_id',
        'INNER JOIN fixture_wide ON fixture_wide.id = fixture_audit.campaign_id',
        'WHERE m.user_id = auth.user_id()',
        '  AND m.removed_at IS NULL',
        "  AND fixture_audit.campaign_id = subscription.parameter('campaign_id')",
        "  AND fixture_wide.id = subscription.parameter('campaign_id')",
        "  AND substring(fixture_audit.accepted_at, 1, 7) = subscription.parameter('month')",
        "  AND fixture_audit.target_type = 'fixture.wide'",
        '  AND fixture_audit.target_id = fixture_audit.campaign_id',
        '  AND fixture_wide.deleted_at IS NULL',
        `  AND m.role IN '["owner","gm","assistant_gm","player"]'`,
        "  AND (json_extract(fixture_audit.target_visibility, '$.visibility.mode') = 'everyone'" +
          " OR (json_extract(fixture_audit.target_visibility, '$.visibility.mode') = 'players'" +
          " AND auth.user_id() IN json_extract(fixture_audit.target_visibility, '$.visibility.playerIds'))" +
          ` OR (m.role IN '["owner","gm","assistant_gm"]'` +
          ` AND json_extract(fixture_audit.target_visibility, '$.visibility.mode') IN '["gm_only","players"]'))`,
      ].join('\n'),
    );
    expect(gmPrivate?.query.split('\n').at(-1)).toBe(
      `  AND m.role IN '["owner","gm","assistant_gm"]'`,
    );
    expect(gmPrivate?.query).toContain('FROM fixture_private_audit');
    expect(gmPrivate?.query).not.toContain('fixture_audit.');
  });

  test('PostgreSQL dialect binds requester, campaign, and month', () => {
    const query = renderAuditSyncQuery(
      rule(WIDE),
      STORES[0] as AuditSyncStore,
      MEMBERS,
      POSTGRES_DIALECT,
    );
    expect(query).toContain('m.user_id = $1::uuid');
    expect(query).toContain('fixture_audit.campaign_id = $2::uuid');
    expect(query).toContain(
      "to_char(fixture_audit.accepted_at AT TIME ZONE 'UTC', 'YYYY-MM') = $3::text",
    );
    expect(query).toContain(
      "(fixture_audit.target_visibility #>> '{visibility,mode}') = 'everyone'",
    );
  });

  test('a store may not replicate the snapshot, must keep id and campaign, and binds once', () => {
    const store = STORES[0] as AuditSyncStore;
    for (const projection of [
      ['id', 'campaign_id', 'target_visibility'],
      ['campaign_id', 'action'],
      ['id', 'action'],
    ]) {
      expect(
        failure(() => renderAuditSyncQuery(rule(WIDE), { ...store, projection }, MEMBERS)),
      ).toBe('missing_projection_column');
    }
    expect(
      failure(() =>
        renderAuditSyncQuery(
          rule(WIDE),
          { ...store, projection: ['id', 'campaign_id', 'x y'] },
          MEMBERS,
        ),
      ),
    ).toBe('invalid_identifier');
    expect(failure(() => compileAuditProviderQueries(registry(), [store, store], MEMBERS))).toBe(
      'duplicate_binding',
    );
    expect(failure(() => renderAuditSyncQuery(rule(SERVER_ONLY), store, MEMBERS))).toBe(
      'never_replicates',
    );
    expect(failure(() => renderAuditSyncQuery(rule(HANDOUT), store, MEMBERS))).toBe(
      'unsupported_predicate',
    );
  });

  test('party targeting keeps audit online-only', () => {
    const compiled = compileAuditProviderQueries(registry('active'), STORES, MEMBERS);
    expect(compiled.queries).toEqual([]);
    expect(compiled.excluded.find((item) => item.targetClass === WIDE.resourceClass)?.reason).toBe(
      'party_targeting',
    );
  });
});
