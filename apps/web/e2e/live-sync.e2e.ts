import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import postgres from 'postgres';

/**
 * Feature 03 tasks 04/07/08 against the running PowerSync service (compose `powersync`, 1.25.0)
 * and PostgreSQL: the production browser session (`BrowserSyncSession`, PowerSync web SDK
 * 1.39.1) writes authorized rows into browser SQLite, reconciles memberships, queues offline
 * writes, and reports status.
 *
 * The API is replaced at the network edge, as in the other specs, by a small stand-in with the
 * same wire contract: `GET /sync/bootstrap/:campaignId` mints the API's HS256 token only for a
 * current membership (else 404), and `POST /sync/mutations` applies the campaign-details update
 * with the version check and receipt idempotency of the real authority (proved against Fastify and
 * PostgreSQL in `apps/api/src/modules/sync`). Provider, replication, and browser storage are real.
 *
 * Skipped unless `DATABASE_URL` (or `TEST_DATABASE_URL`) and the PowerSync service are reachable.
 */

const ENDPOINT = process.env.POWERSYNC_ENDPOINT ?? 'http://localhost:8080';
const SECRET = process.env.POWERSYNC_JWT_SECRET ?? 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ';
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const SYNC_TIMEOUT = Number(process.env.E2E_SYNC_TIMEOUT_MS ?? 30_000);

const statements = new Map(
  readFileSync(fileURLToPath(new URL('fixtures/live-sync.sql', import.meta.url)), 'utf8')
    .split(/^-- name: /m)
    .slice(1)
    .map((block) => {
      const [name = '', ...body] = block.split('\n');
      const text = body
        .filter((line) => !line.startsWith('--'))
        .join('\n')
        .trim()
        .replace(/;$/, '');
      return [name.trim(), text] as const;
    }),
);

type Sql = postgres.Sql;
let sql: Sql | undefined;
let live = false;
const seeded = { users: [] as string[], campaigns: [] as string[] };

function run(
  db: Sql | postgres.TransactionSql,
  name: string,
  params: readonly (string | number | boolean | null | string[])[] = [],
) {
  const text = statements.get(name);
  if (text === undefined) throw new Error(`unknown statement ${name}`);
  return db.unsafe(text, params as never[]);
}

function db(): Sql {
  if (sql === undefined) throw new Error('database unavailable');
  return sql;
}

test.describe.configure({ mode: 'default' });
test.use({ serviceWorkers: 'block' });

test.beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  const candidate = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
  try {
    await candidate`select 1`;
    const probe = await fetch(`${ENDPOINT}/probes/liveness`, {
      signal: AbortSignal.timeout(2_000),
    });
    live = probe.ok;
    sql = candidate;
  } catch {
    await candidate.end({ timeout: 1 });
  }
});

test.afterAll(async () => {
  if (sql === undefined) return;
  // Route handlers query the database; none may outlive the connection closed below.
  await Promise.all([...contexts].map((context) => context.close().catch(() => undefined)));
  try {
    await sql.begin(async (tx) => {
      await run(tx, 'cleanup_settings', [seeded.campaigns]);
      await run(tx, 'cleanup_memberships', [seeded.campaigns]);
      await run(tx, 'cleanup_campaigns', [seeded.campaigns]);
      await run(tx, 'cleanup_users', [seeded.users]);
    });
  } finally {
    await sql.end({ timeout: 1 });
  }
});

async function seedUsers(count: number): Promise<string[]> {
  const users = Array.from({ length: count }, () => randomUUID());
  for (const userId of users) {
    const suffix = userId.replaceAll('-', '').slice(0, 12);
    await run(db(), 'seed_user', [userId, `Ls_${suffix}`, `ls_${suffix}`]);
  }
  seeded.users.push(...users);
  return users;
}

type Role = 'owner' | 'gm' | 'assistant_gm' | 'player';

async function seedCampaign(
  members: readonly { readonly user: string; readonly role: Role }[],
  name = 'Live sync table',
): Promise<string> {
  const campaign = randomUUID();
  const owner = members.find((member) => member.role === 'owner');
  if (owner === undefined) throw new Error('owner required');
  seeded.campaigns.push(campaign);
  // One transaction: the deferred exactly-one-owner trigger checks at commit.
  await db().begin(async (tx) => {
    await run(tx, 'seed_campaign', [campaign, name, owner.user]);
    for (const member of members) {
      await run(tx, 'seed_membership', [campaign, member.user, member.role]);
    }
  });
  return campaign;
}

async function seedSetting(
  campaign: string,
  namespace: string,
  memberVisible: boolean,
  by: string,
): Promise<void> {
  await run(db(), 'seed_setting', [
    campaign,
    namespace,
    JSON.stringify({ probe: namespace }),
    memberVisible,
    by,
  ]);
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** Same claims, key id, and lifetime as `HmacSyncTokenIssuer` in the API. */
function token(userId: string, campaignId: string, replicaId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'rpg-sync-hs256' }));
  const payload = base64Url(
    JSON.stringify({
      sub: userId,
      aud: 'powersync',
      iat: now,
      exp: now + 300,
      campaign_id: campaignId,
      replica_id: replicaId,
    }),
  );
  const signature = createHmac('sha256', Buffer.from(SECRET, 'base64url'))
    .update(`${header}.${payload}`)
    .digest();
  return `${header}.${payload}.${base64Url(signature)}`;
}

type Outcome =
  | { mutationId: string; status: 'accepted'; acceptedVersion: number; serverCursor: string }
  | {
      mutationId: string;
      status: 'conflict';
      expectedVersion: number;
      actualVersion: number;
      currentValue: unknown;
    }
  | { mutationId: string; status: 'error'; code: string; retryable: boolean };

interface UploadedMutation {
  readonly mutationId: string;
  readonly campaignId: string;
  readonly tableName: string;
  readonly recordId: string;
  readonly operation: string;
  readonly expectedVersion: number | null;
  readonly payload: { readonly name?: string };
}

/** Test stand-in for the API's sync routes (see the file comment). */
class Authority {
  /** `http500`: transport failure; `lost_ack`: apply, then drop the response; `unavailable`: retryable outcome. */
  fault: 'none' | 'http500' | 'lost_ack' | 'unavailable' = 'none';
  /**
   * Sync services unreachable: the API stand-in and the provider endpoint refuse requests.
   * Routed requests bypass Chromium's offline emulation, so the stand-in honors it itself.
   */
  syncDown = false;
  /** Runs before each bootstrap decision, with how many bootstraps were requested so far. */
  beforeBootstrap: ((requested: number) => Promise<unknown>) | undefined;
  #bootstrapsRequested = 0;
  readonly uploads: UploadedMutation[] = [];
  readonly bootstraps: { campaignId: string; status: number }[] = [];
  /** `POST /sync/replicas/:campaignId/ack` bodies (the API resolves audit event IDs itself). */
  readonly acks: { campaignId: string; body: Record<string, unknown> }[] = [];
  readonly #receipts = new Map<string, Outcome>();

  constructor(private readonly userId: string) {}

  async install(context: BrowserContext): Promise<void> {
    await context.route(`${ENDPOINT}/**`, (route) =>
      this.syncDown ? route.abort('internetdisconnected') : route.continue(),
    );
    await context.route('**/sync/bootstrap/**', async (route) => {
      if (this.syncDown) return route.abort('internetdisconnected');
      const url = new URL(route.request().url());
      const campaignId = url.pathname.split('/').at(-1) ?? '';
      const replicaId = url.searchParams.get('replicaId') ?? randomUUID();
      this.#bootstrapsRequested += 1;
      await this.beforeBootstrap?.(this.#bootstrapsRequested);
      const [row] = await run(db(), 'membership_active', [campaignId, this.userId]);
      if (Number(row?.count ?? 0) === 0) {
        this.bootstraps.push({ campaignId, status: 404 });
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'not_found', message: 'Not found.' }),
        });
      }
      this.bootstraps.push({ campaignId, status: 200 });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          campaignId,
          replicaId,
          endpoint: ENDPOINT,
          token: token(this.userId, campaignId, replicaId),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      });
    });
    await context.route('**/sync/replicas/*/ack', async (route) => {
      if (this.syncDown) return route.abort('internetdisconnected');
      const campaignId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
      const [row] = await run(db(), 'membership_active', [campaignId, this.userId]);
      if (Number(row?.count ?? 0) === 0) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'not_found', message: 'Not found.' }),
        });
      }
      this.acks.push({ campaignId, body: route.request().postDataJSON() });
      return route.fulfill({ status: 204, body: '' });
    });
    await context.route('**/sync/mutations', async (route) => {
      if (this.syncDown) return route.abort('internetdisconnected');
      const batch = route.request().postDataJSON() as { mutations: UploadedMutation[] };
      this.uploads.push(...batch.mutations);
      if (this.fault === 'http500') {
        return route.fulfill({ status: 500, body: '{"code":"internal"}' });
      }
      const outcomes: Outcome[] = [];
      for (const mutation of batch.mutations) outcomes.push(await this.#apply(mutation));
      if (this.fault === 'lost_ack') {
        this.fault = 'none';
        return route.abort('connectionreset');
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ outcomes }),
      });
    });
  }

  async #apply(mutation: UploadedMutation): Promise<Outcome> {
    const receipt = this.#receipts.get(mutation.mutationId);
    if (receipt !== undefined) return receipt;
    // Read first: the test ends a fault right after revoking, while this upload may be in flight.
    const fault = this.fault;
    const [membership] = await run(db(), 'membership_active', [mutation.campaignId, this.userId]);
    if (Number(membership?.count ?? 0) === 0) {
      return this.#store({
        mutationId: mutation.mutationId,
        status: 'error',
        code: 'not_found_or_forbidden',
        retryable: false,
      });
    }
    if (fault === 'unavailable') {
      return {
        mutationId: mutation.mutationId,
        status: 'error',
        code: 'unavailable',
        retryable: true,
      };
    }
    if (
      mutation.tableName !== 'campaigns' ||
      mutation.operation !== 'update' ||
      typeof mutation.payload.name !== 'string' ||
      mutation.expectedVersion === null
    ) {
      return this.#store({
        mutationId: mutation.mutationId,
        status: 'error',
        code: 'invalid_campaign_mutation',
        retryable: false,
      });
    }
    const [updated] = await run(db(), 'rename_campaign', [
      mutation.recordId,
      mutation.payload.name,
      mutation.expectedVersion,
    ]);
    if (updated !== undefined) {
      return this.#store({
        mutationId: mutation.mutationId,
        status: 'accepted',
        acceptedVersion: Number(updated.version),
        serverCursor: `campaign:${mutation.recordId}:${updated.version}`,
      });
    }
    const [current] = await run(db(), 'campaign_details', [mutation.recordId]);
    return this.#store({
      mutationId: mutation.mutationId,
      status: 'conflict',
      expectedVersion: mutation.expectedVersion,
      actualVersion: Number(current?.version ?? 0),
      currentValue: current ?? null,
    });
  }

  #store(outcome: Outcome): Outcome {
    this.#receipts.set(outcome.mutationId, outcome);
    return outcome;
  }
}

interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly authority: Authority;
  readonly userId: string;
}

type Backend = 'opfs' | 'indexeddb';

const contexts = new Set<BrowserContext>();

async function device(browser: Browser, userId: string): Promise<Device> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  contexts.add(context);
  const authority = new Authority(userId);
  await authority.install(context);
  const page = await context.newPage();
  await page.goto('/');
  return { context, page, authority, userId };
}

function supportsOpfs(page: Page): Promise<boolean> {
  return page.evaluate(() => typeof navigator.storage?.getDirectory === 'function');
}

async function open(
  target: Device,
  options: { backend: Backend; filename: string; campaignId?: string; connect?: boolean },
): Promise<void> {
  // The app falls back to IndexedDB where OPFS does not exist (`browserSupportsOpfs`); so do these.
  const backend =
    options.backend === 'opfs' && !(await supportsOpfs(target.page))
      ? 'indexeddb'
      : options.backend;
  await target.page.evaluate(
    async (input) => {
      const harness = await import('/src/features/sync/e2e-harness.ts');
      await harness.openLiveSession(input);
    },
    {
      userId: target.userId,
      backend,
      filename: options.filename,
      connect: options.connect ?? true,
      ...(options.campaignId === undefined ? {} : { campaignId: options.campaignId }),
    },
  );
}

type Rows = Awaited<ReturnType<typeof import('../src/features/sync/e2e-harness.ts')['liveRows']>>;
type Status = ReturnType<typeof import('../src/features/sync/e2e-harness.ts')['liveStatus']>;

function rows(target: Device): Promise<Rows> {
  return target.page.evaluate(async () => {
    const harness = await import('/src/features/sync/e2e-harness.ts');
    return harness.liveRows();
  });
}

function status(target: Device): Promise<Status> {
  return target.page.evaluate(async () => {
    const harness = await import('/src/features/sync/e2e-harness.ts');
    return harness.liveStatus();
  });
}

/** No network for the device: browser network emulation plus the routed API stand-in. */
async function setOffline(target: Device, offline: boolean): Promise<void> {
  target.authority.syncDown = offline;
  await target.context.setOffline(offline);
}

/** Calls one exported harness function in the page. */
function harness<T>(target: Device, name: string, arg?: unknown): Promise<T> {
  return target.page.evaluate(
    async (input) => {
      const module = (await import('/src/features/sync/e2e-harness.ts')) as unknown as Record<
        string,
        (value?: unknown) => unknown
      >;
      const fn = module[input.name];
      if (fn === undefined) throw new Error(`unknown harness function ${input.name}`);
      return fn(input.arg);
    },
    { name, arg },
  ) as Promise<T>;
}

function filename(label: string): string {
  return `live-${label}-${randomUUID()}.sqlite`;
}

test('a player browser replica holds exactly the permitted rows; revocation empties it', async ({
  browser,
}) => {
  test.skip(!live, 'PostgreSQL or the PowerSync service is unreachable');
  const [owner = '', player = '', outsider = ''] = await seedUsers(3);
  const campaign = await seedCampaign([
    { user: owner, role: 'owner' },
    { user: player, role: 'player' },
  ]);
  const foreign = await seedCampaign([{ user: outsider, role: 'owner' }], 'Other table');
  await seedSetting(campaign, 'table.visible', true, owner);
  await seedSetting(campaign, 'gm.secret', false, owner);
  await seedSetting(foreign, 'other.visible', true, outsider);

  const playerDevice = await device(browser, player);
  const ownerDevice = await device(browser, owner);
  await open(playerDevice, { backend: 'opfs', filename: filename('player'), campaignId: campaign });
  await open(ownerDevice, {
    backend: 'indexeddb',
    filename: filename('owner'),
    campaignId: campaign,
  });

  await expect
    .poll(async () => (await rows(playerDevice)).campaigns.map((row) => row.id), {
      timeout: SYNC_TIMEOUT,
    })
    .toEqual([campaign]);
  const synced = await rows(playerDevice);
  expect(synced.hasSynced).toBe(true);
  // Absence is asserted on browser SQLite, not on the interface.
  expect(synced.settings.map((row) => row.id)).toEqual([`${campaign}:table.visible`]);
  expect(synced.memberships).toEqual([
    expect.objectContaining({
      campaignId: campaign,
      userId: player,
      role: 'player',
      removedAt: null,
    }),
  ]);
  expect(synced.cache).toEqual([
    expect.objectContaining({
      campaignId: campaign,
      userId: player,
      role: 'player',
      removedAt: null,
    }),
  ]);
  await expect(playerDevice.page.locator('[data-sync-state]')).toHaveText('Synchronized');
  // Initial synchronization reports progress; "Synchronized" only after a consistent checkpoint.
  const history = await harness<{ state: string; hasSynced: boolean }[]>(
    playerDevice,
    'liveStatusHistory',
  );
  expect(history.some((entry) => entry.state === 'synchronizing')).toBe(true);
  expect(history.filter((entry) => entry.state === 'synchronized' && !entry.hasSynced)).toEqual([]);

  await expect
    .poll(async () => (await rows(ownerDevice)).settings.map((row) => row.id), {
      timeout: SYNC_TIMEOUT,
    })
    .toEqual([`${campaign}:gm.secret`, `${campaign}:table.visible`]);
  const ownerRows = await rows(ownerDevice);
  expect(ownerRows.campaigns.map((row) => row.id)).toEqual([campaign]);
  expect(ownerRows.memberships.map((row) => row.userId)).toEqual([owner]);

  // Revocation while connected: the provider removes the campaign rows and delivers the
  // membership tombstone; the reconciler purges the local replica state.
  await run(db(), 'revoke_membership', [campaign, player]);
  await expect
    .poll(
      async () => {
        const current = await rows(playerDevice);
        return {
          campaigns: current.campaigns.length,
          settings: current.settings.length,
          cacheRemoved: current.cache.every((row) => row.removedAt !== null),
          pending: current.pending.length,
        };
      },
      { timeout: SYNC_TIMEOUT },
    )
    .toEqual({ campaigns: 0, settings: 0, cacheRemoved: true, pending: 0 });
  const revoked = await rows(playerDevice);
  expect(revoked.memberships).toEqual([
    expect.objectContaining({ campaignId: campaign, userId: player }),
  ]);
  expect(revoked.memberships[0]?.removedAt).not.toBeNull();

  // The owner still has the campaign.
  expect((await rows(ownerDevice)).campaigns.map((row) => row.id)).toEqual([campaign]);

  // Signing out clears synchronized campaign data and the membership cache from the device.
  await harness(ownerDevice, 'signOutLive');
  const signedOut = await rows(ownerDevice);
  expect({
    campaigns: signedOut.campaigns.length,
    settings: signedOut.settings.length,
    memberships: signedOut.memberships.length,
    cache: signedOut.cache.length,
    pending: signedOut.pending.length,
  }).toEqual({ campaigns: 0, settings: 0, memberships: 0, cache: 0, pending: 0 });
  await playerDevice.context.close();
  await ownerDevice.context.close();
});

test('a device revoked while offline is refused on reconnect and its replica is cleared', async ({
  browser,
}) => {
  test.skip(!live, 'PostgreSQL or the PowerSync service is unreachable');
  const [owner = '', player = ''] = await seedUsers(2);
  const campaign = await seedCampaign([
    { user: owner, role: 'owner' },
    { user: player, role: 'player' },
  ]);
  await seedSetting(campaign, 'table.visible', true, owner);
  const playerDevice = await device(browser, player);
  const replica = filename('revoked-offline');
  await open(playerDevice, { backend: 'indexeddb', filename: replica, campaignId: campaign });
  await expect
    .poll(async () => (await rows(playerDevice)).settings.length, { timeout: SYNC_TIMEOUT })
    .toBe(1);

  // The app is closed; membership is revoked; the app reopens (no campaign hint: the cached
  // membership is the only candidate) and reconnects.
  await harness(playerDevice, 'closeLiveSession');
  await run(db(), 'revoke_membership', [campaign, player]);
  await open(playerDevice, { backend: 'indexeddb', filename: replica });
  await expect
    .poll(
      async () => {
        const current = await rows(playerDevice);
        return { campaigns: current.campaigns.length, settings: current.settings.length };
      },
      { timeout: SYNC_TIMEOUT },
    )
    .toEqual({ campaigns: 0, settings: 0 });
  const cleared = await rows(playerDevice);
  expect(cleared.cache).toEqual([
    expect.objectContaining({ campaignId: campaign, userId: player }),
  ]);
  expect(cleared.cache[0]?.removedAt).not.toBeNull();
  expect(playerDevice.authority.bootstraps).toContainEqual({ campaignId: campaign, status: 404 });
  expect((await status(playerDevice)).errorCode).toBe('no_campaign_access');
  await playerDevice.context.close();
});

test('offline edits survive restart, converge on another client after reconnect, in causal order', async ({
  browser,
}) => {
  test.skip(!live, 'PostgreSQL or the PowerSync service is unreachable');
  const [owner = '', gm = ''] = await seedUsers(2);
  const campaign = await seedCampaign(
    [
      { user: owner, role: 'owner' },
      { user: gm, role: 'gm' },
    ],
    'Before the storm',
  );
  const ownerDevice = await device(browser, owner);
  const gmDevice = await device(browser, gm);
  const ownerReplica = filename('owner-offline');
  await open(ownerDevice, { backend: 'opfs', filename: ownerReplica, campaignId: campaign });
  await open(gmDevice, { backend: 'indexeddb', filename: filename('gm'), campaignId: campaign });
  for (const target of [ownerDevice, gmDevice]) {
    await expect(target.page.locator('[data-sync-state]')).toHaveText('Synchronized', {
      timeout: SYNC_TIMEOUT,
    });
  }

  // Connection lost mid-session: reads and writes continue locally.
  await setOffline(ownerDevice, true);
  await expect(ownerDevice.page.locator('[data-sync-state]')).toHaveText('Offline — 0 pending');
  await harness(ownerDevice, 'renameCampaignLocally', {
    campaignId: campaign,
    name: 'Renamed offline',
    expectedVersion: 1,
  });
  await harness(ownerDevice, 'renameCampaignLocally', {
    campaignId: campaign,
    name: 'Renamed twice offline',
    expectedVersion: 2,
  });
  let local = await rows(ownerDevice);
  expect(local.campaigns.map((row) => row.name)).toEqual(['Renamed twice offline']);
  expect(local.pendingCount).toBe(2);
  await expect(ownerDevice.page.locator('[data-sync-state]')).toHaveText('Offline — 2 pending');

  // Restart with the sync services still unreachable: the queue and the local value survive.
  // (No service worker runs in this spec, so the browser network returns for the app shell and
  // the SQLite worker assets; the provider and the API stay down.)
  await ownerDevice.context.setOffline(false);
  await harness(ownerDevice, 'closeLiveSession');
  await open(ownerDevice, { backend: 'opfs', filename: ownerReplica, campaignId: campaign });
  local = await rows(ownerDevice);
  expect(local.campaigns.map((row) => row.name)).toEqual(['Renamed twice offline']);
  // Queued, or 'uploading' after a failed attempt: unaccepted either way, and kept.
  expect(local.pending.map((row) => row.state === 'pending' || row.state === 'uploading')).toEqual([
    true,
    true,
  ]);
  await expect(ownerDevice.page.locator('[data-sync-state]')).toHaveText('Sync error — 2 pending', {
    timeout: SYNC_TIMEOUT,
  });
  expect((await run(db(), 'campaign_details', [campaign]))[0]).toEqual({
    name: 'Before the storm',
    version: 1,
  });
  expect((await rows(gmDevice)).campaigns.map((row) => row.name)).toEqual(['Before the storm']);

  // Reconnect: the queue drains in causal order and the other client converges.
  await setOffline(ownerDevice, false);
  await expect
    .poll(async () => (await rows(gmDevice)).campaigns.map((row) => [row.name, row.version]), {
      timeout: SYNC_TIMEOUT,
    })
    .toEqual([['Renamed twice offline', 3]]);
  await expect(ownerDevice.page.locator('[data-sync-state]')).toHaveText('Synchronized', {
    timeout: SYNC_TIMEOUT,
  });
  local = await rows(ownerDevice);
  expect(local.pendingCount).toBe(0);
  await expect
    .poll(async () => (await rows(ownerDevice)).campaigns.map((row) => [row.name, row.version]), {
      timeout: SYNC_TIMEOUT,
    })
    .toEqual([['Renamed twice offline', 3]]);
  expect(ownerDevice.authority.uploads.map((mutation) => mutation.expectedVersion)).toEqual([1, 2]);
  const history = await harness<{ state: string; label: string }[]>(
    ownerDevice,
    'liveStatusHistory',
  );
  // Never "Synchronized" while the queued work from before the restart existed.
  const firstSynchronized = history.findIndex((entry) => entry.state === 'synchronized');
  expect(firstSynchronized).toBeGreaterThan(0);
  expect(
    history.slice(0, firstSynchronized).some((entry) => entry.label.includes('2 pending')),
  ).toBe(true);
  await ownerDevice.context.close();
  await gmDevice.context.close();
});

test('failure injection: transport errors keep work pending, a lost acknowledgement applies once, a conflict stays unresolved', async ({
  browser,
}) => {
  test.skip(!live, 'PostgreSQL or the PowerSync service is unreachable');
  const [owner = ''] = await seedUsers(1);
  const campaign = await seedCampaign([{ user: owner, role: 'owner' }], 'Fault table');
  const ownerDevice = await device(browser, owner);
  await open(ownerDevice, {
    backend: 'indexeddb',
    filename: filename('faults'),
    campaignId: campaign,
  });
  const indicator = ownerDevice.page.locator('[data-sync-state]');
  await expect(indicator).toHaveText('Synchronized', { timeout: SYNC_TIMEOUT });

  // Upload transport failure: error with the pending count preserved, retried with the same id.
  ownerDevice.authority.fault = 'http500';
  const first = await harness<string>(ownerDevice, 'renameCampaignLocally', {
    campaignId: campaign,
    name: 'After a failure',
    expectedVersion: 1,
  });
  await expect(indicator).toHaveText('Sync error — 1 pending', { timeout: SYNC_TIMEOUT });
  expect((await rows(ownerDevice)).pendingCount).toBe(1);

  // Lost acknowledgement: the authority applies it, the response is dropped, the retry carries
  // the same mutation id and the receipt answers it; the record changes exactly once.
  ownerDevice.authority.fault = 'lost_ack';
  await expect(indicator).toHaveText('Synchronized', { timeout: SYNC_TIMEOUT });
  expect((await run(db(), 'campaign_details', [campaign]))[0]).toEqual({
    name: 'After a failure',
    version: 2,
  });
  const attempts = ownerDevice.authority.uploads.filter(
    (mutation) => mutation.mutationId === first,
  );
  expect(attempts.length).toBeGreaterThanOrEqual(3);

  // Retryable outcome: stays pending, never synchronized.
  ownerDevice.authority.fault = 'unavailable';
  await harness(ownerDevice, 'renameCampaignLocally', {
    campaignId: campaign,
    name: 'Unavailable for now',
    expectedVersion: 2,
  });
  await expect(indicator).toHaveText('Sync error — 1 pending', { timeout: SYNC_TIMEOUT });
  ownerDevice.authority.fault = 'none';
  await expect(indicator).toHaveText('Synchronized', { timeout: SYNC_TIMEOUT });

  // Deferred conflict: another writer changed the record; the offline write is rejected on
  // upload, both values are kept, and the status reports it as unresolved.
  await setOffline(ownerDevice, true);
  await harness(ownerDevice, 'renameCampaignLocally', {
    campaignId: campaign,
    name: 'Stale local name',
    expectedVersion: 3,
  });
  await run(db(), 'rename_campaign', [campaign, 'Server side name', 3]);
  await setOffline(ownerDevice, false);
  await expect(indicator).toHaveText('Sync error — 1 pending, 1 unresolved', {
    timeout: SYNC_TIMEOUT,
  });
  const conflicted = await rows(ownerDevice);
  expect(conflicted.conflicts).toHaveLength(1);
  expect(JSON.parse(conflicted.conflicts[0]?.submitted_value ?? 'null')).toEqual({
    name: 'Stale local name',
    description: '',
  });
  expect((await run(db(), 'campaign_details', [campaign]))[0]).toEqual({
    name: 'Server side name',
    version: 4,
  });
  await ownerDevice.context.close();
});

test('queued writes of a revoked member are not applied and leave the device', async ({
  browser,
}) => {
  test.skip(!live, 'PostgreSQL or the PowerSync service is unreachable');
  const [owner = '', gm = ''] = await seedUsers(2);
  const campaign = await seedCampaign(
    [
      { user: owner, role: 'owner' },
      { user: gm, role: 'gm' },
    ],
    'Kept name',
  );
  const gmDevice = await device(browser, gm);
  await open(gmDevice, { backend: 'opfs', filename: filename('revoked-gm'), campaignId: campaign });
  const indicator = gmDevice.page.locator('[data-sync-state]');
  await expect(indicator).toHaveText('Synchronized', { timeout: SYNC_TIMEOUT });

  // The write is confirmed locally but the authority keeps answering "retry later".
  gmDevice.authority.fault = 'unavailable';
  await harness(gmDevice, 'renameCampaignLocally', {
    campaignId: campaign,
    name: 'Written before removal',
    expectedVersion: 1,
  });
  await expect(indicator).toHaveText('Sync error — 1 pending', { timeout: SYNC_TIMEOUT });

  // Removed meanwhile: the authority refuses the write (current membership, not the cached
  // role), the provider removes the campaign and delivers the tombstone, the replica is purged.
  await run(db(), 'revoke_membership', [campaign, gm]);
  gmDevice.authority.fault = 'none';
  await expect
    .poll(
      async () => {
        const current = await rows(gmDevice);
        return {
          campaigns: current.campaigns.length,
          pending: current.pending.length,
          revoked: current.cache.every((row) => row.removedAt !== null),
        };
      },
      { timeout: SYNC_TIMEOUT },
    )
    .toEqual({ campaigns: 0, pending: 0, revoked: true });
  expect((await run(db(), 'campaign_details', [campaign]))[0]).toEqual({
    name: 'Kept name',
    version: 1,
  });
  expect((await status(gmDevice)).pendingCount).toBe(0);
  await gmDevice.context.close();
});

/**
 * The first membership pass of a GM switches the replica schema, reconnecting the provider inside
 * the session's serialized work. A 404 on that reconnect's bootstrap used to wait for a purge queued
 * behind the reconnect itself: the session hung with the revoked replica on the device.
 */
test('a revocation answered during the reconnect of a schema switch still purges the replica', async ({
  browser,
}) => {
  test.skip(!live, 'PostgreSQL or the PowerSync service is unreachable');
  const [owner = '', gm = ''] = await seedUsers(2);
  const campaign = await seedCampaign([
    { user: owner, role: 'owner' },
    { user: gm, role: 'gm' },
  ]);
  const gmDevice = await device(browser, gm);
  gmDevice.authority.beforeBootstrap = async (requested) =>
    requested === 2 ? run(db(), 'revoke_membership', [campaign, gm]) : undefined;
  await open(gmDevice, {
    backend: 'opfs',
    filename: filename('revoked-reconnect'),
    campaignId: campaign,
  });
  await expect
    .poll(
      async () => {
        const current = await rows(gmDevice);
        return {
          campaigns: current.campaigns.length,
          cachedRevoked: current.cache.map((row) => row.removedAt !== null),
        };
      },
      { timeout: SYNC_TIMEOUT },
    )
    .toEqual({ campaigns: 0, cachedRevoked: [true] });
  expect(gmDevice.authority.bootstraps.slice(0, 2).map((entry) => entry.status)).toEqual([
    200, 404,
  ]);
  await gmDevice.context.close();
});

/**
 * Cold open of a warm synchronized replica, per backend and browser: database creation to the
 * first campaign and settings reads, 20 samples, p95 = 19th fastest. Excludes the app shell and
 * worker script load (served by the dev server here, by the service worker when installed).
 */
test('warm replica cold open p95 stays under two seconds on every available browser and backend', async ({
  browser,
}) => {
  test.skip(!live, 'PostgreSQL or the PowerSync service is unreachable');
  test.setTimeout(240_000);
  const [owner = ''] = await seedUsers(1);
  const campaign = await seedCampaign([{ user: owner, role: 'owner' }], 'Typical table');
  for (let index = 0; index < 200; index += 1) {
    await seedSetting(campaign, `typical.setting-${index}`, true, owner);
  }
  const browsers: { name: string; instance: Browser; owned: boolean }[] = [
    {
      name: `${test.info().project.name || 'msedge'} ${browser.version()}`,
      instance: browser,
      owned: false,
    },
  ];
  try {
    // Explicit channel: the test runner otherwise applies the configured `msedge` channel.
    const bundled = await chromium.launch({ headless: true, channel: 'chromium-headless-shell' });
    browsers.push({
      name: `chromium-headless-shell ${bundled.version()}`,
      instance: bundled,
      owned: true,
    });
  } catch (error) {
    console.info(`bundled chromium unavailable: ${String(error).split('\n')[0]}`);
    test.info().annotations.push({ type: 'skipped-browser', description: 'bundled chromium' });
  }
  const results: string[] = [];
  try {
    for (const target of browsers) {
      for (const backend of ['opfs', 'indexeddb'] as const) {
        const ownerDevice = await device(target.instance, owner);
        if (backend === 'opfs' && !(await supportsOpfs(ownerDevice.page))) {
          await ownerDevice.context.close();
          continue;
        }
        const replica = filename(`perf-${backend}`);
        await open(ownerDevice, { backend, filename: replica, campaignId: campaign });
        await expect
          .poll(async () => (await rows(ownerDevice)).settings.length, { timeout: SYNC_TIMEOUT })
          .toBe(200);
        const measured = await harness<{ samples: number[]; campaigns: number }>(
          ownerDevice,
          'measureWarmOpen',
          { filename: replica, backend, samples: 20 },
        );
        expect(measured.campaigns).toBe(1);
        const sorted = [...measured.samples].sort((left, right) => left - right);
        const p95 = sorted[18] ?? Number.POSITIVE_INFINITY;
        const line = `${target.name} ${backend}: p95 ${p95.toFixed(1)} ms, median ${(sorted[9] ?? 0).toFixed(1)} ms, max ${(sorted[19] ?? 0).toFixed(1)} ms`;
        results.push(line);
        console.info(`warm replica cold open — ${line}`);
        expect(p95).toBeLessThan(2_000);
        await ownerDevice.context.close();
      }
    }
  } finally {
    for (const target of browsers) if (target.owned) await target.instance.close();
    test.info().annotations.push({ type: 'cold-open-p95', description: results.join('; ') });
  }
});

test('the dashboard shows the live sync status and logging out clears the replica', async ({
  browser,
}) => {
  test.skip(!live, 'PostgreSQL or the PowerSync service is unreachable');
  const [owner = ''] = await seedUsers(1);
  const campaign = await seedCampaign([{ user: owner, role: 'owner' }], 'Dashboard table');
  await seedSetting(campaign, 'table.visible', true, owner);
  const ownerDevice = await device(browser, owner);
  // Campaign/identity API at the network edge; sync routes come from the stand-in.
  await ownerDevice.context.route(
    (url) =>
      url.pathname === '/campaigns' ||
      url.pathname.startsWith('/campaigns/') ||
      url.pathname.startsWith('/systems') ||
      url.pathname === '/auth/session',
    (route) =>
      route.request().method() === 'DELETE'
        ? route.fulfill({ status: 204 })
        : route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  // Feature 05: a pinned attachment on this device must leave with the replica on logout.
  const pinned = crypto.randomUUID();
  await harness(ownerDevice, 'seedPinnedAttachment', {
    userId: owner,
    campaignId: campaign,
    attachmentId: pinned,
  });
  await harness(ownerDevice, 'mountDashboard', { userId: owner, campaignId: campaign });
  const indicator = ownerDevice.page.locator('#dashboard-host [data-sync-state]');
  await expect(indicator).toHaveText('Synchronized', { timeout: SYNC_TIMEOUT });

  await ownerDevice.page.getByRole('button', { name: 'Log out' }).click();
  await expect(ownerDevice.page.locator('body[data-logged-out="true"]')).toHaveCount(1);
  expect(await harness(ownerDevice, 'offlineAttachmentIds', owner)).toEqual({
    records: [],
    bytes: [],
  });
  // The dashboard's replica (default per-user file, OPFS here) holds nothing after logout.
  await open(ownerDevice, {
    backend: 'opfs',
    filename: `rpg-replica-${owner}.sqlite`,
    connect: false,
  });
  const cleared = await rows(ownerDevice);
  expect({
    campaigns: cleared.campaigns.length,
    settings: cleared.settings.length,
    cache: cleared.cache.length,
  }).toEqual({ campaigns: 0, settings: 0, cache: 0 });
  await ownerDevice.context.close();
});

// Feature 05 task 05: attachment bytes ride the same removal signal as the replica.
test('revocation through the provider removes pinned attachment bytes and metadata of that campaign only', async ({
  browser,
}) => {
  test.skip(!live, 'PostgreSQL or the PowerSync service is unreachable');
  const [owner = '', player = ''] = await seedUsers(2);
  const campaign = await seedCampaign([
    { user: owner, role: 'owner' },
    { user: player, role: 'player' },
  ]);
  const kept = await seedCampaign([
    { user: owner, role: 'owner' },
    { user: player, role: 'player' },
  ]);
  const playerDevice = await device(browser, player);
  const revokedPin = crypto.randomUUID();
  const keptPin = crypto.randomUUID();
  for (const [campaignId, attachmentId] of [
    [campaign, revokedPin],
    [kept, keptPin],
  ] as const) {
    await harness(playerDevice, 'seedPinnedAttachment', {
      userId: player,
      campaignId,
      attachmentId,
    });
  }
  await playerDevice.page.evaluate(
    async (input) => {
      const module = await import('/src/features/sync/e2e-harness.ts');
      await module.openLiveSession(input);
    },
    {
      userId: player,
      backend: 'indexeddb' as const,
      filename: filename('player-attachments'),
      campaignId: campaign,
      connect: true,
      attachments: true,
    },
  );
  await expect
    .poll(async () => (await rows(playerDevice)).campaigns.map((row) => row.id).sort(), {
      timeout: SYNC_TIMEOUT,
    })
    .toEqual([campaign, kept].sort());
  expect(await harness(playerDevice, 'offlineAttachmentIds', player)).toEqual({
    records: [revokedPin, keptPin].sort(),
    bytes: [revokedPin, keptPin].sort(),
  });

  await run(db(), 'revoke_membership', [campaign, player]);
  await expect
    .poll(() => harness(playerDevice, 'offlineAttachmentIds', player), { timeout: SYNC_TIMEOUT })
    .toEqual({ records: [keptPin], bytes: [keptPin] });
  await harness(playerDevice, 'closeLiveSession');
  await playerDevice.context.close();
});

type AuditRows = Awaited<
  ReturnType<typeof import('../src/features/sync/e2e-harness.ts')['liveAudit']>
>;

function audit(target: Device): Promise<AuditRows> {
  return harness<AuditRows>(target, 'liveAudit');
}

test('audit stores replicate per role; a player replica never holds or addresses the private store', async ({
  browser,
}) => {
  test.skip(!live, 'PostgreSQL or the PowerSync service is unreachable');
  const [owner = '', player = ''] = await seedUsers(2);
  const campaign = await seedCampaign([
    { user: owner, role: 'owner' },
    { user: player, role: 'player' },
  ]);
  const shared = randomUUID();
  const gmOnly = randomUUID();
  const gmPrivate = randomUUID();
  await run(db(), 'seed_audit_campaign', [
    shared,
    campaign,
    1,
    owner,
    JSON.stringify({ visibility: { mode: 'everyone' } }),
  ]);
  await run(db(), 'seed_audit_campaign', [
    gmOnly,
    campaign,
    2,
    owner,
    JSON.stringify({ visibility: { mode: 'gm_only' } }),
  ]);
  await run(db(), 'seed_audit_private', [
    gmPrivate,
    campaign,
    1,
    owner,
    JSON.stringify({ visibility: { mode: 'everyone' } }),
  ]);

  const playerDevice = await device(browser, player);
  const ownerDevice = await device(browser, owner);
  await open(playerDevice, {
    backend: 'opfs',
    filename: filename('audit-player'),
    campaignId: campaign,
  });
  await open(ownerDevice, {
    backend: 'indexeddb',
    filename: filename('audit-owner'),
    campaignId: campaign,
  });

  await expect
    .poll(async () => (await audit(playerDevice)).campaign, { timeout: SYNC_TIMEOUT })
    .toEqual([shared]);
  // Below the interface: no private table, view, index, untyped row, or stream subscription.
  const playerAudit = await audit(playerDevice);
  expect(playerAudit.private).toBeNull();
  expect(playerAudit.privateObjects).toEqual([]);
  expect(playerAudit.internalMentionsPrivate).toBe(false);
  expect(playerAudit.subscriptions.every((item) => item.startsWith('campaign_audit|'))).toBe(true);
  expect(playerAudit.subscriptions.length).toBeGreaterThan(0);

  await expect
    .poll(async () => (await audit(ownerDevice)).private, { timeout: SYNC_TIMEOUT })
    .toEqual([gmPrivate]);
  const ownerAudit = await audit(ownerDevice);
  expect(ownerAudit.campaign).toEqual([shared, gmOnly].sort());
  expect(ownerAudit.privateObjects).toContain('audit_private_events');
  expect(ownerAudit.subscriptions.some((item) => item.startsWith('gm_private_audit|'))).toBe(true);

  // Retention follow-up: once its windows have synced, each replica names the newest audit event
  // it holds per store (never a sequence); a player never acknowledges the private store.
  const claims = (target: Device) =>
    target.authority.acks
      .filter((ack) => ack.campaignId === campaign && 'throughEventId' in ack.body)
      .map((ack) => `${String(ack.body.tableName)}:${String(ack.body.throughEventId)}`);
  await expect
    .poll(() => [...new Set(claims(ownerDevice))].sort(), { timeout: SYNC_TIMEOUT })
    .toEqual([`audit_campaign_events:${gmOnly}`, `audit_private_events:${gmPrivate}`]);
  await expect
    .poll(() => [...new Set(claims(playerDevice))], { timeout: SYNC_TIMEOUT })
    .toEqual([`audit_campaign_events:${shared}`]);
  for (const ack of [...ownerDevice.authority.acks, ...playerDevice.authority.acks]) {
    expect(Object.keys(ack.body).sort()).toEqual(['replicaId', 'tableName', 'throughEventId']);
  }

  // Revocation removes the player's audit rows with the rest of the campaign replica.
  await run(db(), 'revoke_membership', [campaign, player]);
  await expect
    .poll(async () => (await audit(playerDevice)).campaign, { timeout: SYNC_TIMEOUT })
    .toEqual([]);
  await expect
    .poll(async () => (await audit(playerDevice)).subscriptions, { timeout: SYNC_TIMEOUT })
    .toEqual([]);
});
