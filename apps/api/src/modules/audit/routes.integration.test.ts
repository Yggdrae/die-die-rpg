import { afterAll, describe, expect, test } from 'bun:test';
import {
  AccountAuditRepository,
  AuditQueryService,
  AuditRendererRegistry,
  CampaignAuditRepository,
  connectAuditDatabase,
  DurableAuditRecorder,
  PostgresAuditRepairOutbox,
  PrivateAuditRepository,
  type TargetVisibilitySnapshot,
} from '@rpg/audit';
import { ResourcePolicyRegistry } from '@rpg/authorization';
import type { AuditEvent, Role, Visibility } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.ts';
import { buildRuntimeApp } from '../../runtime.ts';
import { ContentAccess, type ResourceFactsSource } from '../authorization/content-access.ts';
import {
  CASEY,
  CREDENTIALS,
  GM,
  Members,
  MemoryNoteAdapter,
  NOTE,
  notePolicy,
  OBSERVER,
  ROWAN,
  SECRET,
  STRANGER,
} from '../authorization/test-fixture.ts';
import { registerIdentityAuthentication } from '../identity/authenticate.ts';
import { CAMPAIGN_RESOURCE_POLICY } from '../sync/sync-rules.ts';
import { registerAuditRoutes } from './routes.ts';
import { AuditTargetAccess } from './target-access.ts';

/**
 * Feature 06 task 03: the authorized audit read API over real PostgreSQL stores and feature 04
 * decisions (invented fixture classes `fixture_note` and author-private `fixture_secret`). Every
 * test uses its own campaign ID, so rows from other runs never reach a total. Skipped when no
 * migrated database is reachable.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate = databaseUrl === undefined ? undefined : connectAuditDatabase(databaseUrl);
const connection = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await new CampaignAuditRepository(candidate.db).listForCampaign(crypto.randomUUID(), {
      limit: 1,
    });
    return candidate;
  } catch {
    await candidate.close();
    return undefined;
  }
})();
afterAll(async () => connection?.close());

const AGM = '00000000-0000-4000-8000-0000000000b2';
const ORIGIN = 'https://table.invalid';
const SECRET_VALUE = 'the-butler-did-it';
const credentials: Record<string, string> = { ...CREDENTIALS, [AGM]: 'A'.repeat(43) };
const EVERYONE: Visibility = { mode: 'everyone' };
const GM_ONLY_VIS: Visibility = { mode: 'gm_only' };

function wire(response: { statusCode: number; headers: object; body: string }) {
  const { date: _date, ...headers } = response.headers as Record<string, unknown>;
  return JSON.stringify({ status: response.statusCode, headers, body: response.body });
}

interface Entry {
  readonly id: string;
  readonly action: string;
  readonly target: { readonly type: string; readonly id: string };
  readonly sessionId: string | null;
  readonly description: { readonly kind: string; readonly text: string };
}
interface PageBody {
  readonly items: Entry[];
  readonly total: number;
  readonly nextCursor?: string;
}

describe.skipIf(connection === undefined)('audit read API (PostgreSQL)', () => {
  const db = () => {
    if (connection === undefined) throw new Error('database unavailable');
    return connection.db;
  };

  function context() {
    const campaignId = crypto.randomUUID();
    const otherCampaign = crypto.randomUUID();
    const live = new Set<string>([campaignId, otherCampaign]);
    const registry = new ResourcePolicyRegistry({ requireVisibilityAdapters: true });
    const notes = new MemoryNoteAdapter(NOTE);
    const secrets = new MemoryNoteAdapter(SECRET);
    registry.register(CAMPAIGN_RESOURCE_POLICY);
    registry.register(notePolicy(NOTE, false), notes);
    registry.register(notePolicy(SECRET, true), secrets);
    const members = new Members([
      [campaignId, GM, 'gm'],
      [campaignId, AGM, 'assistant_gm'],
      [campaignId, CASEY, 'player'],
      [campaignId, ROWAN, 'player'],
      [campaignId, OBSERVER, 'observer'],
      [otherCampaign, STRANGER, 'gm'],
    ]);
    const campaignSource: ResourceFactsSource = {
      resourceClass: 'campaign',
      loadFacts: async (campaign, resourceId) =>
        campaign === resourceId && live.has(campaign)
          ? {
              campaignId: campaign,
              resourceClass: 'campaign',
              resourceId,
              visibility: EVERYONE,
              version: 1,
            }
          : undefined,
    };
    const access = new ContentAccess({ registry, actors: members, sources: [campaignSource] });
    const renderers = new AuditRendererRegistry();
    renderers.register({
      action: 'note.retitled',
      version: 1,
      render: () => ({ text: 'Note retitled.' }),
    });
    renderers.register({
      action: 'note.broken',
      version: 1,
      render: () => {
        throw new Error(SECRET_VALUE);
      },
    });
    const campaignStore = new CampaignAuditRepository(db());
    const privateStore = new PrivateAuditRepository(db());
    const recorder = new DurableAuditRecorder({
      campaign: campaignStore,
      private: privateStore,
      account: new AccountAuditRepository(db()),
      outbox: new PostgresAuditRepairOutbox(db()),
      registry: renderers,
      diagnostics: { degraded: () => {}, deadLettered: () => {}, repaired: () => {} },
    });
    const app = buildApp();
    const byCredential = new Map(Object.entries(credentials).map(([id, value]) => [value, id]));
    registerIdentityAuthentication(app, {
      authenticate: async (credential) => {
        const userId = byCredential.get(credential);
        return userId === undefined
          ? undefined
          : { userId, sessionId: '00000000-0000-4000-8000-000000000999' };
      },
    });
    access.install(app);
    registerAuditRoutes(app, {
      access,
      targets: new AuditTargetAccess({ registry, sources: [campaignSource] }),
      queries: {
        campaign: new AuditQueryService(campaignStore, renderers),
        private: new AuditQueryService(privateStore, renderers),
      },
    });

    let at = 0;
    async function record(
      input: {
        readonly targetType?: string;
        readonly targetId: string;
        readonly snapshot?: TargetVisibilitySnapshot;
        readonly action?: string;
        readonly private?: boolean;
        readonly sessionId?: string;
        readonly actor?: string;
        readonly actorRole?: Role;
      },
      campaign = campaignId,
    ): Promise<string> {
      at += 1;
      const event: Omit<AuditEvent, 'id'> = {
        campaignId: campaign,
        actor: { userId: input.actor ?? GM, campaignId: campaign, role: input.actorRole ?? 'gm' },
        action: input.action ?? 'note.retitled',
        targetType: input.targetType ?? NOTE,
        targetId: input.targetId,
        before: { title: SECRET_VALUE },
        after: { title: `${SECRET_VALUE}-after` },
        at: new Date(Date.UTC(2026, 9, 26, 12, 0, at)).toISOString(),
        private: input.private ?? false,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      };
      const originMutationId = crypto.randomUUID();
      expect(
        await recorder.recordCampaign({
          event,
          originMutationId,
          targetVisibility: input.snapshot ?? { visibility: EVERYONE },
        }),
      ).toBe('recorded');
      const store = input.private === true ? privateStore : campaignStore;
      const rows = await store.listForCampaign(campaign, { limit: 200 });
      const row = rows.find((candidate) => candidate.originMutationId === originMutationId);
      if (row === undefined) throw new Error('event not stored');
      return row.id;
    }

    const get = (userId: string | undefined, path: string) =>
      app.inject({
        method: 'GET',
        url: path,
        headers: userId === undefined ? {} : { cookie: `rpg_session=${credentials[userId]}` },
      });
    const read = async (userId: string, suffix = '/audit', query = '') => {
      const response = await get(userId, `/campaigns/${campaignId}${suffix}${query}`);
      expect(response.statusCode).toBe(200);
      return response.json() as PageBody;
    };
    const ids = (page: PageBody) => page.items.map((item) => item.id);
    const note = (visibility: Visibility, authorUserId?: string, adapter = notes) =>
      adapter.put({
        id: crypto.randomUUID(),
        campaignId,
        visibility,
        ...(authorUserId === undefined ? {} : { authorUserId }),
      }).id;

    return {
      app,
      campaignId,
      otherCampaign,
      live,
      notes,
      secrets,
      record,
      get,
      read,
      ids,
      note,
    };
  }

  // Scenario: Audit data cannot reveal a hidden target. Players see only currently visible targets.
  test('players receive only events whose targets they may currently see', async () => {
    const t = context();
    const shared = t.note(EVERYONE);
    const unrevealed = t.note(GM_ONLY_VIS);
    const caseyOnly = t.note({ mode: 'players', playerIds: [CASEY] });
    const revealedLater = t.note(EVERYONE);
    const onShared = await t.record({ targetId: shared });
    // Recorded while visible to everyone, but the target is GM-only now: the current rule wins.
    const onUnrevealed = await t.record({ targetId: unrevealed });
    const onCaseyOnly = await t.record({ targetId: caseyOnly });
    // Recorded as GM-only (for example a visibility change); a later reveal does not widen it.
    const gmOnlyEvent = await t.record({
      targetId: revealedLater,
      action: 'visibility.revealed',
      snapshot: { visibility: GM_ONLY_VIS },
    });

    const gm = await t.read(GM);
    const agm = await t.read(AGM);
    const casey = await t.read(CASEY);
    const rowan = await t.read(ROWAN);
    expect(gm.total).toBe(4);
    expect(new Set(t.ids(gm))).toEqual(new Set([onShared, onUnrevealed, onCaseyOnly, gmOnlyEvent]));
    expect(agm.total).toBe(4);
    expect(t.ids(casey)).toEqual([onCaseyOnly, onShared]);
    expect(casey.total).toBe(2);
    expect(t.ids(rowan)).toEqual([onShared]);
    expect(rowan.total).toBe(1);

    // Reveal the GM-only note to everyone: its history follows the current visibility.
    const row = t.notes.rows.get(unrevealed);
    if (row === undefined) throw new Error('missing fixture row');
    row.visibility = EVERYONE;
    expect(t.ids(await t.read(ROWAN))).toEqual([onUnrevealed, onShared]);
    // And un-revealing hides it again, rows and total.
    row.visibility = GM_ONLY_VIS;
    const after = await t.read(ROWAN);
    expect(t.ids(after)).toEqual([onShared]);
    expect(after.total).toBe(1);
  });

  test('missing targets and undeclared classes are absent for every role', async () => {
    const t = context();
    const deleted = t.note(EVERYONE);
    const visible = t.note(EVERYONE);
    const onVisible = await t.record({ targetId: visible });
    await t.record({ targetId: deleted });
    await t.record({ targetId: crypto.randomUUID() });
    await t.record({ targetType: 'campaign_membership', targetId: CASEY });
    await t.record({ targetType: 'undeclared_thing', targetId: crypto.randomUUID() });
    const row = t.notes.rows.get(deleted);
    if (row === undefined) throw new Error('missing fixture row');
    row.deleted = true;
    for (const reader of [GM, AGM, CASEY]) {
      const page = await t.read(reader);
      expect(t.ids(page)).toEqual([onVisible]);
      expect(page.total).toBe(1);
    }
  });

  // Author-private: the Ownership Rule applies even to GM roles and even when the snapshot is
  // only `gm_only` or `everyone`.
  test('a GM role never sees events on another author’s private target', async () => {
    const t = context();
    const caseysSecret = t.note(EVERYONE, CASEY, t.secrets);
    const gmsSecret = t.note(EVERYONE, GM, t.secrets);
    const onCasey = await t.record({
      targetType: SECRET,
      targetId: caseysSecret,
      actor: CASEY,
      actorRole: 'player',
    });
    const onCaseyGmOnly = await t.record({
      targetType: SECRET,
      targetId: caseysSecret,
      snapshot: { visibility: GM_ONLY_VIS },
    });
    const onGm = await t.record({ targetType: SECRET, targetId: gmsSecret });
    const privateOnCasey = await t.record({
      targetType: SECRET,
      targetId: caseysSecret,
      private: true,
    });

    const gm = await t.read(GM);
    expect(t.ids(gm)).toEqual([onGm]);
    expect(gm.total).toBe(1);
    expect(t.ids(await t.read(AGM))).toEqual([]);
    // Casey is the author but a player: the GM-only snapshot still narrows that event.
    expect(t.ids(await t.read(CASEY))).toEqual([onCasey]);
    expect(t.ids(await t.read(ROWAN))).toEqual([]);
    const privateGm = await t.read(GM, '/audit/private');
    expect(t.ids(privateGm)).not.toContain(privateOnCasey);
    expect(privateGm.total).toBe(0);
    expect(onCaseyGmOnly).toBeDefined();
  });

  test('totals and pages are computed from the permitted set', async () => {
    const t = context();
    const visible = t.note(EVERYONE);
    const hidden = t.note(GM_ONLY_VIS);
    const expected: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const id = await t.record({ targetId: index % 2 === 0 ? visible : hidden });
      if (index % 2 === 0) expected.unshift(id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const page = await t.read(
        CASEY,
        '/audit',
        `?limit=3${cursor === undefined ? '' : `&cursor=${cursor}`}`,
      );
      expect(page.total).toBe(4);
      seen.push(...t.ids(page));
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(expected);
    // GM pages over all 7.
    expect((await t.read(GM, '/audit', '?limit=3')).total).toBe(7);
  });

  test('a hidden or unknown cursor is the same 400', async () => {
    const t = context();
    const hidden = t.note(GM_ONLY_VIS);
    const visible = t.note(EVERYONE);
    const hiddenEvent = await t.record({ targetId: hidden });
    await t.record({ targetId: visible });
    const privateEvent = await t.record({ targetId: visible, private: true });
    const base = `/campaigns/${t.campaignId}/audit?cursor=`;
    const onHidden = await t.get(CASEY, `${base}${hiddenEvent}`);
    const onPrivate = await t.get(CASEY, `${base}${privateEvent}`);
    const onUnknown = await t.get(CASEY, `${base}${crypto.randomUUID()}`);
    expect(onHidden.statusCode).toBe(400);
    expect(wire(onPrivate)).toBe(wire(onHidden));
    expect(wire(onUnknown)).toBe(wire(onHidden));
  });

  // Store separation: the campaign route never returns private rows; the private route is gated.
  test('the GM-private store has its own route and authorization and is never unioned', async () => {
    const t = context();
    const visible = t.note(EVERYONE);
    const hidden = t.note(GM_ONLY_VIS);
    const publicEvent = await t.record({ targetId: visible });
    const privateEvent = await t.record({ targetId: visible, private: true });
    const privateOnHidden = await t.record({ targetId: hidden, private: true });

    const campaign = await t.read(GM);
    expect(t.ids(campaign)).toEqual([publicEvent]);
    expect(campaign.total).toBe(1);
    for (const reader of [GM, AGM]) {
      const privatePage = await t.read(reader, '/audit/private');
      expect(t.ids(privatePage)).toEqual([privateOnHidden, privateEvent]);
      expect(privatePage.total).toBe(2);
    }

    const miss = await t.get(CASEY, `/campaigns/${t.campaignId}/no-such-route`);
    const privatePath = `/campaigns/${t.campaignId}/audit/private`;
    for (const reader of [CASEY, ROWAN, OBSERVER, STRANGER]) {
      expect(wire(await t.get(reader, privatePath))).toBe(wire(miss));
    }
    // No input selects or unions a store.
    for (const query of ['?store=private', '?private=true', '?include=private']) {
      expect((await t.get(GM, `/campaigns/${t.campaignId}/audit${query}`)).statusCode).toBe(400);
    }
    const body = (await t.get(CASEY, `/campaigns/${t.campaignId}/audit`)).body;
    expect(body).not.toContain(privateEvent);
    expect(body).not.toContain(privateOnHidden);
  });

  test('observers, non-members, other-campaign GMs, and deleted campaigns get the safe 404', async () => {
    const t = context();
    await t.record({ targetId: t.note(EVERYONE) });
    const miss = await t.get(CASEY, `/campaigns/${t.campaignId}/no-such-route`);
    expect(miss.statusCode).toBe(404);
    const paths = [
      `/campaigns/${t.campaignId}/audit`,
      `/campaigns/${t.campaignId}/sessions/${crypto.randomUUID()}/audit`,
      `/campaigns/${t.campaignId}/audit/private`,
    ];
    for (const path of paths) {
      for (const reader of [OBSERVER, STRANGER]) {
        expect(wire(await t.get(reader, path))).toBe(wire(miss));
      }
      expect((await t.get(undefined, path)).statusCode).toBe(401);
    }
    // A GM of another campaign gets the same answer for this campaign's audit.
    t.live.delete(t.campaignId);
    for (const path of paths) {
      expect(wire(await t.get(GM, path))).toBe(wire(miss));
    }
  });

  // Scenarios: A registered renderer explains an event; An unregistered event remains safe.
  test('rendered descriptions only, with a safe fallback and no raw values', async () => {
    const t = context();
    const target = t.note(EVERYONE);
    await t.record({ targetId: target, action: 'note.retitled' });
    await t.record({ targetId: target, action: 'note.broken' });
    await t.record({ targetId: target, action: 'note.unregistered' });
    const response = await t.get(GM, `/campaigns/${t.campaignId}/audit`);
    expect(response.statusCode).toBe(200);
    const page = response.json() as PageBody;
    expect(page.items.map((item) => item.description)).toEqual([
      { kind: 'generic', text: 'Recorded note.unregistered on fixture_note.' },
      { kind: 'generic', text: 'Recorded note.broken on fixture_note.' },
      { kind: 'registered', text: 'Note retitled.' },
    ]);
    expect(response.body).not.toContain(SECRET_VALUE);
    expect(response.body).not.toContain('before');
    expect(response.body).not.toContain('after');
    expect(response.body).not.toContain('Sequence');
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual([
      'acceptedAt',
      'action',
      'actor',
      'description',
      'id',
      'sessionId',
      'target',
    ]);
  });

  // Scenario Outline: Filters narrow without widening visibility. Scenario: session views.
  test('actor, target, and session filters only narrow the permitted set', async () => {
    const t = context();
    const visible = t.note(EVERYONE);
    const hidden = t.note(GM_ONLY_VIS);
    const session = crypto.randomUUID();
    const byCasey = await t.record({ targetId: visible, actor: CASEY, actorRole: 'player' });
    const inSession = await t.record({ targetId: visible, sessionId: session });
    await t.record({ targetId: hidden, actor: CASEY, actorRole: 'player', sessionId: session });

    expect(t.ids(await t.read(ROWAN, '/audit', `?actorId=${CASEY}`))).toEqual([byCasey]);
    expect(t.ids(await t.read(GM, '/audit', `?actorId=${CASEY}`))).toHaveLength(2);
    const hiddenFilter = await t.read(ROWAN, '/audit', `?targetType=${NOTE}&targetId=${hidden}`);
    const unknownFilter = await t.read(
      ROWAN,
      '/audit',
      `?targetType=${NOTE}&targetId=${crypto.randomUUID()}`,
    );
    expect(hiddenFilter).toEqual({ items: [], total: 0 });
    expect(unknownFilter).toEqual(hiddenFilter);
    const sessionPage = await t.read(ROWAN, `/sessions/${session}/audit`);
    expect(t.ids(sessionPage)).toEqual([inSession]);
    expect(sessionPage.total).toBe(1);
    expect((await t.read(GM, `/sessions/${session}/audit`)).total).toBe(2);
    expect((await t.read(GM, '/audit/private', `?sessionId=${session}`)).total).toBe(0);
  });

  test('role claims in the request are rejected or ignored', async () => {
    const t = context();
    await t.record({ targetId: t.note(GM_ONLY_VIS) });
    const path = `/campaigns/${t.campaignId}/audit`;
    expect((await t.get(CASEY, `${path}?role=gm`)).statusCode).toBe(400);
    const spoofed = await t.app.inject({
      method: 'GET',
      url: path,
      headers: { cookie: `rpg_session=${credentials[CASEY]}`, 'x-role': 'gm', role: 'gm' },
    });
    expect(spoofed.json() as PageBody).toEqual({ items: [], total: 0 });
  });
});

describe.skipIf(connection === undefined)('audit read API in the runtime composition', () => {
  test('the runtime serves the campaign log through the inventory and feature 04', async () => {
    if (databaseUrl === undefined) return;
    const app: FastifyInstance = buildRuntimeApp({
      databaseUrl,
      allowedOrigin: ORIGIN,
      production: false,
      powerSyncEndpoint: 'http://localhost:8080',
      powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
      logger: false,
    });
    try {
      await app.ready();
      const suffix = crypto.randomUUID().slice(0, 8);
      const signUp = async (name: string) => {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/accounts',
          payload: { username: `${name}_${suffix}`, password: 'correct horse battery staple' },
        });
        expect(response.statusCode).toBe(200);
        const raw = response.headers['set-cookie'];
        const header = Array.isArray(raw) ? raw[0] : raw;
        return {
          cookie: (header ?? '').split(';')[0] ?? '',
          userId: (response.json() as { user: { id: string } }).user.id,
        };
      };
      const owner = (await signUp('audit_reader')).cookie;
      const gm = (await signUp('audit_gm')).cookie;
      const player = (await signUp('audit_viewer')).cookie;
      const leaver = await signUp('audit_leaver');
      const stranger = (await signUp('audit_stranger')).cookie;
      const call = (
        cookie: string,
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        url: string,
        payload?: object,
      ) => app.inject({ method, url, headers: { cookie, origin: ORIGIN }, payload });
      const id = crypto.randomUUID();
      const created = await call(owner, 'POST', '/campaigns', {
        id,
        system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
        gameMode: 'standard',
        options: {},
        moduleIds: [],
        name: 'Audit Reader Game',
        description: '',
      });
      expect(created.statusCode).toBe(201);
      const join = async (cookie: string, targetRole: string) => {
        const invited = await call(owner, 'POST', `/campaigns/${id}/invitations`, { targetRole });
        const token = invited.json().token as string;
        const accepted = await call(cookie, 'POST', `/invitations/${token}/accept`);
        expect(accepted.statusCode).toBe(200);
        return (accepted.json() as { user: { id: string } }).user.id;
      };
      const gmId = await join(gm, 'gm');
      await join(player, 'player');
      await join(leaver.cookie, 'player');
      expect(
        (
          await call(owner, 'PATCH', `/campaigns/${id}/members/${gmId}/role`, {
            role: 'assistant_gm',
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await call(owner, 'DELETE', `/campaigns/${id}/members/${leaver.userId}`)).statusCode,
      ).toBe(204);

      // `campaign_membership` is a server-only feature 04 class readable by the GM roles. The
      // removed member's history stays readable (tombstone facts); a player sees none of it.
      const actionsOf = (response: { json(): unknown }) =>
        (response.json() as PageBody).items.map((item) => item.action).sort();
      const ownerPage = await call(owner, 'GET', `/campaigns/${id}/audit`);
      expect(ownerPage.statusCode).toBe(200);
      expect((ownerPage.json() as PageBody).total).toBe(6);
      expect(actionsOf(ownerPage)).toEqual([
        'campaign.created',
        'membership.created',
        'membership.created',
        'membership.created',
        'membership.removed',
        'membership.role_changed',
      ]);
      const gmPage = await call(gm, 'GET', `/campaigns/${id}/audit`);
      expect(gmPage.statusCode).toBe(200);
      expect((gmPage.json() as PageBody).total).toBe(6);
      const leaverHistory = await call(
        owner,
        'GET',
        `/campaigns/${id}/audit?targetType=campaign_membership&targetId=${leaver.userId}`,
      );
      expect(actionsOf(leaverHistory)).toEqual(['membership.created', 'membership.removed']);
      const playerPage = await call(player, 'GET', `/campaigns/${id}/audit`);
      expect(playerPage.statusCode).toBe(200);
      expect(playerPage.json()).toMatchObject({
        total: 1,
        items: [{ action: 'campaign.created', target: { type: 'campaign', id } }],
      });
      // The removed member has no campaign access at all.
      expect((await call(leaver.cookie, 'GET', `/campaigns/${id}/audit`)).statusCode).toBe(404);
      const ownerPrivate = await call(owner, 'GET', `/campaigns/${id}/audit/private`);
      expect(ownerPrivate.json() as PageBody).toEqual({ items: [], total: 0 });
      const miss = await call(stranger, 'GET', `/campaigns/${id}/nothing-here`);
      for (const [cookie, path] of [
        [player, `/campaigns/${id}/audit/private`],
        [stranger, `/campaigns/${id}/audit`],
        [stranger, `/campaigns/${id}/audit/private`],
      ] as const) {
        const response = await call(cookie, 'GET', path);
        expect(response.statusCode).toBe(404);
        expect(response.body).toBe(miss.body);
      }
    } finally {
      await app.close();
    }
  });
});
