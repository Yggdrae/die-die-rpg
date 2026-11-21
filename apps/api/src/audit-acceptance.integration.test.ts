import { afterAll, describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { createPostgresAuditRuntime } from '@rpg/audit';
import type { AuditRecorder } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { createAuditRendererRegistry } from './modules/audit/contributors.ts';
import { runAuditRetentionReport } from './modules/audit/retention-cli.ts';
import { buildRuntimeApp } from './runtime.ts';

/**
 * Feature 06 task 06 acceptance through the real composition root (Fastify, PostgreSQL, the
 * registered contributor renderers):
 *
 * - a GM explains a change from the log alone: actor, time, and a rendered before/after;
 * - a player reads only what feature 04 lets them see, with a matching total, and gets the safe
 *   404 on the private route;
 * - order is the authority's, whatever the client clocks say;
 * - an audit store that fails never fails the user operation; the retention report deletes nothing
 *   and its failure is contained;
 * - audit is not exported (P0).
 *
 * Offline atomicity, store routing, and replica privacy are proved in
 * `modules/sync/campaign-applier.integration.test.ts`, `audit-sync.integration.test.ts`,
 * `sync-config.powersync.integration.test.ts`, and `apps/web/e2e/live-sync.e2e.ts`.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2 });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from audit_campaign_events limit 1`;
    return true;
  } catch {
    return false;
  }
})();
afterAll(async () => sql?.end({ timeout: 1 }));

function runtime(integrations?: { audit?: AuditRecorder }) {
  if (databaseUrl === undefined) throw new Error('database unavailable');
  return buildRuntimeApp({
    databaseUrl,
    allowedOrigin: origin,
    production: false,
    powerSyncEndpoint: 'http://localhost:8080',
    powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
    logger: false,
    ...(integrations === undefined ? {} : { integrations }),
  });
}

type App = ReturnType<typeof runtime>;

async function signUp(app: App, name: string) {
  const username = `${name}_${crypto.randomUUID().slice(0, 8)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/auth/accounts',
    payload: { username, password: 'correct horse battery staple' },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return { cookie: (header ?? '').split(';')[0] ?? '', userId: response.json().user.id as string };
}

type Session = Awaited<ReturnType<typeof signUp>>;

function call(
  app: App,
  who: Session,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: { cookie: who.cookie, origin },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function createCampaign(app: App, owner: Session, name: string) {
  const id = crypto.randomUUID();
  const created = await call(app, owner, 'POST', '/campaigns', {
    id,
    system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
    gameMode: 'standard',
    options: {},
    moduleIds: [],
    name,
    description: '',
  });
  expect(created.statusCode).toBe(201);
  return { id, version: created.json().version as number };
}

interface Entry {
  readonly id: string;
  readonly actor: { readonly userId: string };
  readonly action: string;
  readonly acceptedAt: string;
  readonly description: { readonly kind: string; readonly text: string };
}

describe.skipIf(!available)('audit acceptance (PostgreSQL, runtime composition)', () => {
  test("a GM explains a change; a player sees only permitted history; order is the authority's", async () => {
    if (databaseUrl === undefined) return;
    const app = runtime();
    try {
      const owner = await signUp(app, 'acc_owner');
      const player = await signUp(app, 'acc_player');
      const campaign = await createCampaign(app, owner, 'Draft');
      const invited = await call(app, owner, 'POST', `/campaigns/${campaign.id}/invitations`, {
        targetRole: 'player',
      });
      expect(
        (await call(app, player, 'POST', `/invitations/${invited.json().token}/accept`)).statusCode,
      ).toBe(200);
      const renamed = await call(app, owner, 'PATCH', `/campaigns/${campaign.id}`, {
        name: 'Ashen Road',
        description: '',
        expectedVersion: campaign.version,
      });
      expect(renamed.statusCode).toBe(200);

      // Two events whose client clocks disagree with acceptance order (feature 06 BDD: order
      // does not depend on client clocks).
      const audit = createPostgresAuditRuntime({
        connectionString: databaseUrl,
        diagnostics: { degraded: () => {}, deadLettered: () => {}, repaired: () => {} },
        registry: createAuditRendererRegistry(),
      });
      try {
        for (const at of ['2031-01-01T00:00:00Z', '2001-01-01T00:00:00Z']) {
          await audit.recorder.recordCampaign({
            targetVisibility: { visibility: { mode: 'everyone' } },
            event: {
              campaignId: campaign.id,
              actor: { userId: owner.userId, campaignId: campaign.id, role: 'owner' },
              action: 'campaign.setting_changed',
              targetType: 'campaign',
              targetId: campaign.id,
              after: { namespace: at.slice(0, 4) === '2031' ? 'clock.future' : 'clock.past' },
              at,
              private: false,
            },
          });
        }
      } finally {
        await audit.close();
      }

      const gmView = await call(app, owner, 'GET', `/campaigns/${campaign.id}/audit`);
      expect(gmView.statusCode).toBe(200);
      const gm = gmView.json() as { items: Entry[]; total: number };
      expect(gm.items.map((item) => item.action)).toEqual([
        'campaign.setting_changed',
        'campaign.setting_changed',
        'campaign.details_updated',
        'membership.created',
        'campaign.created',
      ]);
      // Newest accepted first, although its client clock says 2001.
      expect(gm.items.slice(0, 2).map((item) => item.description.text)).toEqual([
        'Changed the campaign setting clock.past.',
        'Changed the campaign setting clock.future.',
      ]);
      const change = gm.items[2];
      expect(change).toMatchObject({
        actor: { userId: owner.userId },
        description: {
          kind: 'registered',
          text: 'Renamed the campaign from "Draft" to "Ashen Road".',
        },
      });
      expect(Date.now() - Date.parse(change?.acceptedAt ?? '')).toBeLessThan(5 * 60_000);
      expect(gm.items[3]?.description.text).toBe('A member joined as player.');
      expect(gm.total).toBe(5);

      // The player reads campaign history but not membership events (GM roles only).
      const playerView = await call(app, player, 'GET', `/campaigns/${campaign.id}/audit`);
      const mine = playerView.json() as { items: Entry[]; total: number };
      expect(mine.items.map((item) => item.action)).toEqual([
        'campaign.setting_changed',
        'campaign.setting_changed',
        'campaign.details_updated',
        'campaign.created',
      ]);
      expect(mine.total).toBe(mine.items.length);
      expect(JSON.stringify(mine)).not.toContain('membership.created');
      const privateRoute = await call(
        app,
        player,
        'GET',
        `/campaigns/${campaign.id}/audit/private`,
      );
      expect(privateRoute.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  test('a failing audit store never fails the user operation', async () => {
    const failing: AuditRecorder = {
      record: async () => {
        throw new Error('audit store unavailable');
      },
    };
    const app = runtime({ audit: failing });
    try {
      const owner = await signUp(app, 'acc_isolated');
      const campaign = await createCampaign(app, owner, 'Isolated');
      const renamed = await call(app, owner, 'PATCH', `/campaigns/${campaign.id}`, {
        name: 'Still Saved',
        description: '',
        expectedVersion: campaign.version,
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().name).toBe('Still Saved');
    } finally {
      await app.close();
    }
  });

  test('the retention report deletes nothing; its failure is contained', async () => {
    if (sql === undefined || databaseUrl === undefined) return;
    const [before] = await sql<{ n: number }[]>`
      select (select count(*) from audit_campaign_events) + (select count(*) from audit_private_events)
        + (select count(*) from audit_account_events) as n`;
    const stdout: string[] = [];
    const exit = await runAuditRetentionReport({
      databaseUrl,
      output: { stdout: (line) => stdout.push(line), stderr: () => {} },
    });
    expect(exit).toBe(0);
    const report = JSON.parse(stdout.join('\n')) as {
      mode: string;
      deleted: number;
      deletionApproved: boolean;
      deletionEnabled: boolean;
    };
    // Policy approved (2026-10-28); deletion still off unless an operator enables it.
    expect(report).toMatchObject({
      mode: 'report_only',
      deleted: 0,
      deletionApproved: true,
      deletionEnabled: false,
    });
    const [after] = await sql<{ n: number }[]>`
      select (select count(*) from audit_campaign_events) + (select count(*) from audit_private_events)
        + (select count(*) from audit_account_events) as n`;
    expect(Number(after?.n)).toBeGreaterThanOrEqual(Number(before?.n));
    const stderr: string[] = [];
    const failed = await runAuditRetentionReport({
      databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none',
      output: { stdout: () => {}, stderr: (line) => stderr.push(line) },
    });
    expect(failed).toBe(1);
    expect(stderr).toEqual(['Audit retention report failed.']);
  });
});

describe('audit is not exported in P0', () => {
  test('no export contribution names an audit store', async () => {
    const root = new URL('../../../', import.meta.url);
    const offenders: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(new URL(relative, root), { withFileTypes: true })) {
        const path = `${relative}${entry.name}`;
        if (entry.isDirectory()) {
          if (!['node_modules', 'dist', 'drizzle'].includes(entry.name)) await walk(`${path}/`);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = await Bun.file(new URL(path, root)).text();
          if (
            /implements\s+ExportableModule|:\s*ExportableModule\b/.test(text) &&
            /audit/i.test(text)
          ) {
            offenders.push(path);
          }
        }
      }
    };
    for (const top of ['packages/', 'apps/']) await walk(top);
    expect(offenders).toEqual([]);
  });
});
