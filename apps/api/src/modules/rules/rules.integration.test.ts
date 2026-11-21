import { afterAll, describe, expect, test } from 'bun:test';
import type { Role } from '@rpg/contracts';
import { InMemoryRepository } from '@rpg/contracts/testing';
import { FIXTURE_SYSTEM_DEFINITION, FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import {
  markVisibility,
  RULES_MARK_REPLICA_TABLE,
  RULES_SYNC_FEATURE_ID,
  RulesMarkLocalRepository,
  type RulesMarkRecord,
  rulesMarkId,
} from '@rpg/rules';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';

/**
 * Feature 14 on PostgreSQL through the real composition root (`_techspec.md` "Authority"): marks are their owner's
 * only (D-10), at their derived ID for a declared section (D-08), merged and never a conflict (D-09), not audited, and
 * the configured `authorized_rules_marks` query returns a requester's own rows only.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql =
  databaseUrl === undefined
    ? undefined
    : postgres(databaseUrl, { max: 2, onnotice: () => undefined });
const db = sql as NonNullable<typeof sql>;
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from rules_section_marks limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const campaigns: string[] = [];
const [SECTION, OTHER_SECTION] = FIXTURE_SYSTEM_PACKAGE.rules.sections.map((section) => section.id);

afterAll(async () => {
  if (available && campaigns.length > 0) {
    for (const table of ['rules_section_marks', 'sync_mutation_receipts']) {
      await db.unsafe(`delete from ${table} where campaign_id = any($1::uuid[])`, [campaigns]);
    }
  }
  await sql?.end({ timeout: 1 });
});

const SYNC_CONFIG = new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url);

/** The configured `authorized_rules_marks` query, as PostgreSQL (requester `$1`). */
async function streamQuery(): Promise<string> {
  const parsed = Bun.YAML.parse(await Bun.file(SYNC_CONFIG).text()) as {
    readonly streams: Record<string, { readonly queries?: string[] }>;
  };
  const [query] = parsed.streams.authorized_rules_marks?.queries ?? [];
  if (query === undefined) throw new Error('rules stream query not found');
  return query
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

type Who = { readonly id: string; readonly headers: Record<string, string> };
type Outcome = Record<string, unknown> & { readonly status: string; readonly code?: string };
let sequence = 0;

async function runtime() {
  if (databaseUrl === undefined) throw new Error('database unavailable');
  const app = buildRuntimeApp({
    databaseUrl,
    allowedOrigin: origin,
    production: false,
    powerSyncEndpoint: 'http://localhost:8080',
    powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
    systems: [FIXTURE_SYSTEM_DEFINITION],
    logger: false,
  });
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 8);
  let counter = 0;
  const signUp = async (): Promise<Who> => {
    counter += 1;
    const account = await app.inject({
      method: 'POST',
      url: '/auth/accounts',
      payload: { username: `ru_${suffix}_${counter}`, password: 'correct horse battery staple' },
    });
    expect(account.statusCode).toBe(200);
    const raw = account.headers['set-cookie'];
    return {
      id: (JSON.parse(account.body) as { user: { id: string } }).user.id,
      headers: { cookie: ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '', origin },
    };
  };
  const createCampaign = async (owner: Who) => {
    const campaignId = crypto.randomUUID();
    campaigns.push(campaignId);
    const created = await app.inject({
      method: 'POST',
      url: '/campaigns',
      headers: owner.headers,
      payload: {
        id: campaignId,
        system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
        gameMode: 'standard',
        options: {},
        moduleIds: [],
        name: 'Rules',
        description: '',
      },
    });
    expect(created.statusCode).toBe(201);
    return campaignId;
  };
  const invite = async (owner: Who, campaignId: string, member: Who, role: Role) => {
    const invited = await app.inject({
      method: 'POST',
      url: `/campaigns/${campaignId}/invitations`,
      headers: owner.headers,
      payload: { targetRole: role },
    });
    expect(invited.statusCode).toBe(201);
    const accepted = await app.inject({
      method: 'POST',
      url: `/invitations/${(invited.json() as { token: string }).token}/accept`,
      headers: member.headers,
    });
    expect(accepted.statusCode).toBe(200);
  };
  const upload = async (
    who: Who,
    campaignId: string,
    input: {
      readonly recordId: string;
      readonly operation: 'insert' | 'update' | 'tombstone';
      readonly expectedVersion: number | null;
      readonly payload: unknown;
      readonly mutationId?: string;
      readonly audited?: boolean;
    },
  ): Promise<Outcome> => {
    sequence += 1;
    const at = new Date().toISOString();
    const response = await app.inject({
      method: 'POST',
      url: '/sync/mutations',
      headers: who.headers,
      payload: {
        campaignId,
        replicaId: crypto.randomUUID(),
        mutations: [
          {
            mutationId: input.mutationId ?? crypto.randomUUID(),
            campaignId,
            featureId: RULES_SYNC_FEATURE_ID,
            tableName: RULES_MARK_REPLICA_TABLE,
            recordId: input.recordId,
            operation: input.operation,
            expectedVersion: input.expectedVersion,
            payload: input.payload,
            ...(input.audited === true
              ? {
                  audit: {
                    campaignId,
                    action: 'rules.created',
                    targetType: RULES_MARK_REPLICA_TABLE,
                    targetId: input.recordId,
                    at,
                    private: false,
                  },
                }
              : {}),
            causalSequence: sequence,
            state: 'pending',
            attemptCount: 0,
            recordedAt: at,
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { outcomes: Outcome[] }).outcomes[0] as Outcome;
  };
  return { app, signUp, createCampaign, invite, upload };
}

/** A device repository over an in-memory replica: the payload is exactly what a device queues. */
function device(campaignId: string, userId: string, clock?: () => Date) {
  const rows = new InMemoryRepository<RulesMarkRecord>();
  return {
    rows,
    marks: new RulesMarkLocalRepository(
      rows,
      { userId, campaignId },
      clock === undefined ? {} : { clock },
    ),
  };
}

async function marked(
  local: ReturnType<typeof device>,
  section: string,
  write: 'bookmark' | 'unbookmark' | 'view',
): Promise<RulesMarkRecord> {
  const result =
    write === 'view'
      ? await local.marks.viewed(section)
      : await local.marks.bookmark(section, write === 'bookmark');
  if (!result.ok || result.value === undefined) throw new Error('local write refused');
  return result.value;
}

describe.skipIf(!available)('rules section marks on PostgreSQL (feature 14)', () => {
  test('a mark is its owner’s only, GM roles included; another user is refused (D-10)', async () => {
    const { app, signUp, createCampaign, invite, upload } = await runtime();
    try {
      const gm = await signUp();
      const player = await signUp();
      const campaignId = await createCampaign(gm);
      await invite(gm, campaignId, player, 'player');
      const mine = await marked(device(campaignId, player.id), SECTION as string, 'bookmark');
      expect(
        await upload(player, campaignId, {
          recordId: mine.id,
          operation: 'insert',
          expectedVersion: null,
          payload: mine,
        }),
      ).toMatchObject({ status: 'accepted', acceptedVersion: 1 });
      // The GM uploading the player's mark (their ID, their row) is refused, and changes nothing.
      const forged = { ...mine, bookmarked: false, bookmarkChangedAt: new Date().toISOString() };
      expect(
        await upload(gm, campaignId, {
          recordId: mine.id,
          operation: 'update',
          expectedVersion: 1,
          payload: forged,
        }),
      ).toMatchObject({ status: 'error', code: 'not_found_or_forbidden' });
      const gmMark = await marked(device(campaignId, gm.id), SECTION as string, 'view');
      expect(
        await upload(gm, campaignId, {
          recordId: gmMark.id,
          operation: 'insert',
          expectedVersion: null,
          payload: gmMark,
        }),
      ).toMatchObject({ status: 'accepted' });
      const [stored] = await db<{ bookmarked: boolean }[]>`
        select bookmarked from rules_section_marks where id = ${mine.id}`;
      expect(stored?.bookmarked).toBe(true);

      // The configured stream query returns each requester's own rows only.
      const query = await streamQuery();
      for (const [who, expected] of [
        [player, mine.id],
        [gm, gmMark.id],
      ] as const) {
        const rows = await db.unsafe<{ id: string }[]>(
          `select * from (${query}) streamed where streamed.campaign_id = $2::uuid`,
          [who.id, campaignId],
        );
        expect(rows.map((row) => row.id)).toEqual([expected]);
      }
      // Never audited (D-10).
      const events = await db`
        select 1 from audit_campaign_events where campaign_id = ${campaignId}
          and target_type in ('rules_section_mark', 'rules_section_marks')`;
      expect(events.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('a derived-ID mismatch, an undeclared section, a delete, or an audit envelope is refused', async () => {
    const { app, signUp, createCampaign, upload } = await runtime();
    try {
      const gm = await signUp();
      const campaignId = await createCampaign(gm);
      const mark = await marked(device(campaignId, gm.id), SECTION as string, 'bookmark');
      const wrongId = { ...mark, id: crypto.randomUUID() };
      expect(
        await upload(gm, campaignId, {
          recordId: wrongId.id,
          operation: 'insert',
          expectedVersion: null,
          payload: wrongId,
        }),
      ).toMatchObject({ status: 'error', code: 'invalid_rules_mark' });
      const undeclaredId = await rulesMarkId(campaignId, gm.id, 'no_such_section');
      const undeclared = {
        ...mark,
        id: undeclaredId,
        name: 'no_such_section',
        sectionId: 'no_such_section',
      };
      expect(
        await upload(gm, campaignId, {
          recordId: undeclaredId,
          operation: 'insert',
          expectedVersion: null,
          payload: undeclared,
        }),
      ).toMatchObject({ status: 'error', code: 'invalid_rules_mark' });
      expect(
        await upload(gm, campaignId, {
          recordId: mark.id,
          operation: 'insert',
          expectedVersion: null,
          payload: mark,
          audited: true,
        }),
      ).toMatchObject({ status: 'error', code: 'invalid_payload' });
      expect(
        await upload(gm, campaignId, {
          recordId: mark.id,
          operation: 'tombstone',
          expectedVersion: 1,
          payload: mark,
        }),
      ).toMatchObject({ status: 'error', code: 'invalid_payload' });
    } finally {
      await app.close();
    }
  });

  test('two devices of one user merge and never conflict; a resend is idempotent (D-09)', async () => {
    const { app, signUp, createCampaign, upload } = await runtime();
    try {
      const gm = await signUp();
      const campaignId = await createCampaign(gm);
      let now = Date.now() - 60_000;
      const clock = () => new Date(now);
      const first = device(campaignId, gm.id, clock);
      const second = device(campaignId, gm.id, clock);
      const bookmarked = await marked(first, SECTION as string, 'bookmark');
      const mutationId = crypto.randomUUID();
      const accepted = await upload(gm, campaignId, {
        recordId: bookmarked.id,
        operation: 'insert',
        expectedVersion: null,
        payload: bookmarked,
        mutationId,
      });
      expect(accepted).toMatchObject({ status: 'accepted', acceptedVersion: 1 });
      expect(
        await upload(gm, campaignId, {
          recordId: bookmarked.id,
          operation: 'insert',
          expectedVersion: null,
          payload: bookmarked,
          mutationId,
        }),
      ).toMatchObject({ status: 'accepted', acceptedVersion: 1 });
      // The second device never saw the bookmark: its first view is an insert of the same row.
      now += 1_000;
      const viewed = await marked(second, SECTION as string, 'view');
      expect(viewed.id).toBe(bookmarked.id);
      expect(
        await upload(gm, campaignId, {
          recordId: viewed.id,
          operation: 'insert',
          expectedVersion: null,
          payload: viewed,
        }),
      ).toMatchObject({ status: 'accepted', acceptedVersion: 2 });
      // The first device removes the bookmark at its stale version 1: merged, later change wins.
      now += 1_000;
      const removed = await marked(first, SECTION as string, 'unbookmark');
      expect(
        await upload(gm, campaignId, {
          recordId: removed.id,
          operation: 'update',
          expectedVersion: 1,
          payload: removed,
        }),
      ).toMatchObject({ status: 'accepted', acceptedVersion: 3 });
      const [row] = await db<{ bookmarked: boolean; viewed_at: Date | null; version: string }[]>`
        select bookmarked, viewed_at, version from rules_section_marks where id = ${removed.id}`;
      expect(row?.bookmarked).toBe(false);
      expect(row?.viewed_at?.toISOString()).toBe(viewed.viewedAt as string);
      // An older bookmark arriving late changes nothing.
      expect(
        await upload(gm, campaignId, {
          recordId: bookmarked.id,
          operation: 'update',
          expectedVersion: 1,
          payload: bookmarked,
        }),
      ).toMatchObject({ status: 'accepted', acceptedVersion: 3 });
      // Another section is another row.
      const other = await marked(first, OTHER_SECTION as string, 'view');
      expect(other.id).not.toBe(bookmarked.id);
    } finally {
      await app.close();
    }
  });

  test('CHECKs refuse a mark whose Visibility names someone else, or that is neither kind', async () => {
    const campaignId = crypto.randomUUID();
    campaigns.push(campaignId);
    const user = crypto.randomUUID();
    const insert = (targets: string[], bookmarked: boolean, changed: Date | null) =>
      db`insert into rules_section_marks (id, campaign_id, user_id, section_id, bookmarked,
          bookmark_changed_at, visibility_mode, visibility_targets, created_by, updated_by)
        values (${crypto.randomUUID()}, ${campaignId}, ${user}, ${crypto.randomUUID().slice(0, 8)},
          ${bookmarked}, ${changed}, 'players', ${db.json(targets)}, ${user}, ${user})`;
    // A postgres.js query runs on `then`; settle it explicitly.
    const outcome = (query: ReturnType<typeof insert>) =>
      query.then(
        () => 'inserted',
        () => 'refused',
      );
    expect(await outcome(insert([crypto.randomUUID()], true, new Date()))).toBe('refused');
    expect(await outcome(insert([user], true, null))).toBe('refused');
    expect(await outcome(insert([user], false, null))).toBe('refused');
    expect(markVisibility(user)).toEqual({ mode: 'players', playerIds: [user] });
    expect(await outcome(insert([user], true, new Date()))).toBe('inserted');
  });
});
