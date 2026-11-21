import { afterAll, describe, expect, test } from 'bun:test';
import type { AuditEvent, CampaignAccessRevoked } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import { reconcileMembershipCache } from '@rpg/identity';
import { type CachedMembership, SyncStatusStore } from '@rpg/sync';
import { ReplicaAccessReconciler, ReplicaManager, SqliteReplicaStore } from '@rpg/sync/bun';
import postgres from 'postgres';
import { runOperatorRecoveryCommand } from './modules/identity/operator-cli.ts';
import { buildRuntimeApp } from './runtime.ts';

/**
 * Feature 01 task 13: P0 acceptance through the real composition root (`buildRuntimeApp`)
 * over HTTP and PostgreSQL. Covers the browser-visible contract: PRD test 1, the logged-out
 * invitation, revocation, removal and role authority, operator recovery, session lifecycle,
 * cookie/origin/rate-limit policy, and the absence of raw secrets from responses and logs.
 * Raw SQL only observes or ages persisted rows. Skipped when no database is reachable.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2 });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
})();
afterAll(async () => sql?.end({ timeout: 1 }));

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type Role = 'gm' | 'assistant_gm' | 'player';

interface Session {
  readonly cookie: string;
  readonly credential: string;
  readonly userId: string;
  readonly username: string;
  readonly password: string;
  readonly ip: string;
}

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly body: string;
  readonly headers: string;
  readonly setCookie: string;
}

const SESSION_COOKIE = /^rpg_session=([A-Za-z0-9_-]{43});/;
const suffix = crypto.randomUUID().slice(0, 8);
let ipCounter = 0;
const nextIp = () => {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 250) + 1}.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
};
let nameCounter = 0;

function sqlClient() {
  if (sql === undefined) throw new Error('database unavailable');
  return sql;
}

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

function createHarness(options: { production: boolean }) {
  if (databaseUrl === undefined) throw new Error('database unavailable');
  const lines: string[] = [];
  const audits: Omit<AuditEvent, 'id'>[] = [];
  const signals: CampaignAccessRevoked[] = [];
  const recorded: Recorded[] = [];
  const secrets = {
    passwords: new Set<string>(),
    sessionCredentials: new Set<string>(),
    invitationTokens: new Set<string>(),
    recoveryTokens: new Set<string>(),
  };
  const app = buildRuntimeApp({
    databaseUrl,
    allowedOrigin: origin,
    production: options.production,
    powerSyncEndpoint: 'http://localhost:8080',
    powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
    logger: { stream: { write: (line: string) => lines.push(line) } },
    integrations: {
      audit: {
        record: async (event) => {
          audits.push(event);
        },
      },
      revocations: {
        publish: async (event) => {
          signals.push(event);
        },
      },
    },
  });

  async function send(
    who: Session | undefined,
    method: Method,
    url: string,
    payload?: unknown,
    extra: {
      /** `null` omits Origin; a string replaces it. */
      readonly origin?: string | null;
      readonly ip?: string;
      readonly headers?: Record<string, string>;
    } = {},
  ) {
    const requestOrigin = extra.origin === undefined ? origin : extra.origin;
    const response = await app.inject({
      method,
      url,
      remoteAddress: extra.ip ?? who?.ip ?? nextIp(),
      headers: {
        ...(who === undefined ? {} : { cookie: who.cookie }),
        ...(method === 'GET' || requestOrigin === null ? {} : { origin: requestOrigin }),
        ...extra.headers,
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    const cookies = setCookies(response);
    recorded.push({
      method,
      url,
      status: response.statusCode,
      body: response.body,
      headers: JSON.stringify({ ...response.headers, 'set-cookie': undefined }),
      setCookie: cookies.join('\n'),
    });
    for (const cookie of cookies) {
      const credential = SESSION_COOKIE.exec(cookie)?.[1];
      if (credential !== undefined) secrets.sessionCredentials.add(credential);
    }
    if (method === 'POST' && /^\/campaigns\/[^/]+\/invitations$/.test(url)) {
      const token = (JSON.parse(response.body) as { token?: string }).token;
      if (token !== undefined) secrets.invitationTokens.add(token);
    }
    return response;
  }

  function session(
    response: Awaited<ReturnType<typeof send>>,
    username: string,
    password: string,
    ip: string,
  ): Session {
    expect(response.statusCode).toBe(200);
    const header = setCookies(response)[0] ?? '';
    const credential = SESSION_COOKIE.exec(header)?.[1];
    if (credential === undefined) throw new Error('no session cookie');
    return {
      cookie: `rpg_session=${credential}`,
      credential,
      userId: response.json().user.id,
      username,
      password,
      ip,
    };
  }

  async function signUp(name: string): Promise<Session> {
    nameCounter += 1;
    const username = `${name}_${suffix}${nameCounter}`;
    const password = `correct horse ${name} ${suffix}${nameCounter} staple`;
    secrets.passwords.add(password);
    const ip = nextIp();
    const response = await send(
      undefined,
      'POST',
      '/auth/accounts',
      { username, password },
      { ip },
    );
    return session(response, username, password, ip);
  }

  async function logIn(user: Session, password = user.password): Promise<Session> {
    secrets.passwords.add(password);
    const response = await send(
      undefined,
      'POST',
      '/auth/sessions',
      { username: user.username, password },
      { ip: user.ip },
    );
    return session(response, user.username, password, user.ip);
  }

  async function createCampaign(owner: Session, name = 'Identity Game'): Promise<string> {
    const id = crypto.randomUUID();
    const created = await send(owner, 'POST', '/campaigns', {
      id,
      system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
      gameMode: 'standard',
      options: {},
      moduleIds: [],
      name,
      description: '',
    });
    expect(created.statusCode).toBe(201);
    return id;
  }

  async function invite(who: Session, campaignId: string, targetRole: Role) {
    const issued = await send(who, 'POST', `/campaigns/${campaignId}/invitations`, { targetRole });
    expect(issued.statusCode).toBe(201);
    return {
      token: issued.json().token as string,
      invitationId: issued.json().invitation.id as string,
    };
  }

  async function join(who: Session, token: string) {
    const accepted = await send(who, 'POST', `/invitations/${token}/accept`);
    expect(accepted.statusCode).toBe(200);
    return accepted;
  }

  /** An owner-created campaign with one new member per role (in order). */
  async function campaignWith(roles: readonly Role[]) {
    const owner = await signUp('owner');
    const campaignId = await createCampaign(owner);
    const members: Session[] = [];
    for (const role of roles) {
      const member = await signUp(role);
      const { token } = await invite(owner, campaignId, role);
      await join(member, token);
      members.push(member);
    }
    return { owner, campaignId, members };
  }

  async function activeMembers(campaignId: string) {
    return sqlClient()`
      select user_id, role, version::int as version from identity_campaign_memberships
      where campaign_id = ${campaignId} and removed_at is null order by created_at`;
  }

  /** Every secret stays in its one intended carrier; no log line carries any of them. */
  function assertNoSecretLeaks() {
    const log = lines.join('');
    const all = [
      ...secrets.passwords,
      ...secrets.sessionCredentials,
      ...secrets.invitationTokens,
      ...secrets.recoveryTokens,
    ];
    for (const secret of all) expect(log).not.toContain(secret);
    for (const response of recorded) {
      const carriers = `${response.body}\n${response.headers}`;
      for (const secret of secrets.passwords) {
        expect(carriers).not.toContain(secret);
        expect(response.setCookie).not.toContain(secret);
      }
      for (const secret of secrets.recoveryTokens) {
        expect(carriers).not.toContain(secret);
        expect(response.setCookie).not.toContain(secret);
      }
      for (const credential of secrets.sessionCredentials) {
        expect(carriers).not.toContain(credential);
        const issuesSession =
          response.method === 'POST' &&
          (response.url === '/auth/accounts' || response.url === '/auth/sessions');
        if (!issuesSession) expect(response.setCookie).not.toContain(credential);
      }
      for (const token of secrets.invitationTokens) {
        expect(response.headers).not.toContain(token);
        expect(response.setCookie).not.toContain(token);
        const issuance =
          response.method === 'POST' &&
          response.status === 201 &&
          /^\/campaigns\/[^/]+\/invitations$/.test(response.url);
        if (!issuance) expect(response.body).not.toContain(token);
      }
    }
    return { responses: recorded.length, logLines: lines.length };
  }

  return {
    app,
    lines,
    audits,
    signals,
    recorded,
    secrets,
    send,
    signUp,
    logIn,
    createCampaign,
    invite,
    join,
    campaignWith,
    activeMembers,
    assertNoSecretLeaks,
  };
}

type Harness = ReturnType<typeof createHarness>;
const harnesses: Harness[] = [];
function harness(options: { production: boolean } = { production: false }): Harness {
  const created = createHarness(options);
  harnesses.push(created);
  return created;
}
afterAll(async () => {
  for (const created of harnesses) await created.app.close();
});

/** Issues a recovery token through the operator command, as a host operator would. */
async function operatorIssue(username: string, extraArgs: readonly string[] = []) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runOperatorRecoveryCommand({
    databaseUrl,
    args: ['--username', username, '--operator-reference', 'host:p0-acceptance', ...extraArgs],
    output: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
  });
  return { exitCode, stdout, stderr, token: stdout[0] ?? '' };
}

/** A token the test relies on: a failed issue reports its reason here, not as a later mismatch. */
async function operatorIssued(username: string) {
  const issued = await operatorIssue(username);
  expect(issued.exitCode === 0 ? [] : issued.stderr).toEqual([]);
  expect(issued.exitCode).toBe(0);
  return issued;
}

function jwtClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
}

describe.skipIf(!available)('identity and membership P0 acceptance (runtime + PostgreSQL)', () => {
  const shared = available ? harness() : (undefined as never);

  test('PRD test 1: signup, campaign, invitation joins, role resolution, initial sync bootstrap', async () => {
    const h = shared;
    const owner = await h.signUp('t1owner');
    const campaignId = await h.createCampaign(owner);

    // Creator is the sole owner: exactly one owner membership, with one MVP role.
    const created = (await h.send(owner, 'GET', `/campaigns/${campaignId}/members`)).json();
    expect(created.items).toHaveLength(1);
    expect(created.items[0]).toMatchObject({ role: 'owner', user: { id: owner.userId } });

    const player = await h.signUp('t1player');
    const gm = await h.signUp('t1gm');
    const playerInvite = await h.invite(owner, campaignId, 'player');
    const gmInvite = await h.invite(owner, campaignId, 'gm');
    const joinedPlayer = await h.join(player, playerInvite.token);
    expect(joinedPlayer.json()).toMatchObject({
      campaignId,
      role: 'player',
      user: { id: player.userId },
    });
    await h.join(gm, gmInvite.token);

    // Each current member once, with exactly one role, never observer.
    const listed = (await h.send(gm, 'GET', `/campaigns/${campaignId}/members`)).json();
    expect(listed.items.map((m: { user: { id: string } }) => m.user.id).sort()).toEqual(
      [owner.userId, player.userId, gm.userId].sort(),
    );
    for (const membership of listed.items) {
      expect(['owner', 'gm', 'assistant_gm', 'player']).toContain(membership.role);
    }
    expect(listed.items.filter((m: { role: string }) => m.role === 'owner')).toHaveLength(1);
    expect((await h.activeMembers(campaignId)).filter((row) => row.role === 'owner')).toHaveLength(
      1,
    );

    // The user's campaign list returns the campaign once with the invitation's role.
    const mine = (await h.send(player, 'GET', '/users/me/campaigns')).json();
    expect(mine.items.filter((m: { campaignId: string }) => m.campaignId === campaignId)).toEqual([
      expect.objectContaining({ role: 'player', campaignId }),
    ]);

    // Roles resolve from membership: only the owner may edit campaign details.
    const campaign = (await h.send(owner, 'GET', `/campaigns/${campaignId}`)).json();
    const edit = (who: Session) =>
      h.send(who, 'PATCH', `/campaigns/${campaignId}`, {
        name: 'Renamed',
        description: '',
        expectedVersion: campaign.version,
      });
    for (const denied of [player, gm]) {
      const response = await edit(denied);
      expect([response.statusCode, response.json().code]).toEqual([404, 'not_found_or_forbidden']);
    }
    expect((await edit(owner)).statusCode).toBe(200);

    // Initial synchronization (automatable part): bootstrap issues a short-lived token scoped
    // to this user and campaign; non-members and anonymous callers get nothing.
    for (const member of [owner, gm, player]) {
      const response = await h.send(member, 'GET', `/sync/bootstrap/${campaignId}`);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.campaignId).toBe(campaignId);
      const claims = jwtClaims(body.token);
      expect(claims).toMatchObject({ sub: member.userId, campaign_id: campaignId });
      expect(Number(claims.exp) * 1000).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    }
    const outsider = await h.signUp('t1outsider');
    expect((await h.send(outsider, 'GET', `/sync/bootstrap/${campaignId}`)).statusCode).toBe(404);
    expect((await h.send(undefined, 'GET', `/sync/bootstrap/${campaignId}`)).statusCode).toBe(401);
    // Device leg without the sync provider (tracked by feature 03 task 04): each member's own
    // `current_user_memberships` rows, read as the stream shapes them, initialise a fresh replica
    // through the real reconciler. Roles resolve offline; a non-member replica resolves nothing.
    const streamRows = async (userId: string): Promise<CachedMembership[]> => {
      const rows = await sqlClient()`
        select campaign_id, user_id, role, version::int as version, updated_at, removed_at
        from identity_campaign_memberships where user_id = ${userId}`;
      return rows.map((row) => ({
        campaignId: row.campaign_id,
        userId: row.user_id,
        role: row.role,
        version: row.version,
        updatedAt: new Date(row.updated_at).toISOString(),
        removedAt: row.removed_at === null ? null : new Date(row.removed_at).toISOString(),
      }));
    };
    const initialSync = async (userId: string) => {
      const store = new SqliteReplicaStore();
      const access = new ReplicaAccessReconciler(
        store,
        new ReplicaManager(store, new SyncStatusStore(), []),
        reconcileMembershipCache,
      );
      const report = await access.applyMemberships(userId, await streamRows(userId), {
        complete: true,
      });
      return { access, report };
    };
    for (const [member, role] of [
      [owner, 'owner'],
      [gm, 'gm'],
      [player, 'player'],
    ] as const) {
      const device = await initialSync(member.userId);
      expect(device.report.removed).toEqual([]);
      expect(device.access.actor(member.userId, campaignId)?.role).toBe(role);
    }
    const outsiderDevice = await initialSync(outsider.userId);
    expect(outsiderDevice.access.actor(outsider.userId, campaignId)).toBeUndefined();
    h.assertNoSecretLeaks();
  }, 60_000);

  test('logged-out invitation is previewed publicly and retained through signup and login', async () => {
    const h = shared;
    const owner = await h.signUp('lo_owner');
    const campaignId = await h.createCampaign(owner, 'Open Table');
    const first = await h.invite(owner, campaignId, 'player');

    // Preview without authentication: display name, role, expiry only.
    const preview = await h.send(undefined, 'GET', `/invitations/${first.token}`);
    expect(preview.statusCode).toBe(200);
    expect(Object.keys(preview.json()).sort()).toEqual([
      'campaignDisplayName',
      'expiresAt',
      'targetRole',
    ]);
    expect(preview.json()).toMatchObject({
      campaignDisplayName: 'Open Table',
      targetRole: 'player',
    });
    expect(preview.body).not.toContain(campaignId);
    expect(preview.body).not.toContain(owner.username);

    // Acceptance requires authentication; a refused attempt does not consume the invitation.
    const anonymous = await h.send(undefined, 'POST', `/invitations/${first.token}/accept`);
    expect(anonymous.statusCode).toBe(401);
    expect((await h.activeMembers(campaignId)).length).toBe(1);
    expect((await h.send(undefined, 'GET', `/invitations/${first.token}`)).statusCode).toBe(200);

    // Path 1: the invited user creates an account, then accepts the same invitation.
    const newcomer = await h.signUp('lo_new');
    const joined = await h.join(newcomer, first.token);
    expect(joined.json()).toMatchObject({ campaignId, role: 'player' });
    expect((await h.send(newcomer, 'GET', `/campaigns/${campaignId}/members`)).statusCode).toBe(
      200,
    );

    // Path 2: an existing user logs in (a failed attempt first) and accepts a second one.
    const second = await h.invite(owner, campaignId, 'assistant_gm');
    const returning = await h.signUp('lo_ret');
    const failed = await h.send(
      undefined,
      'POST',
      '/auth/sessions',
      { username: returning.username, password: 'not the right password at all' },
      { ip: returning.ip },
    );
    expect(failed.statusCode).toBe(401);
    expect((await h.send(undefined, 'GET', `/invitations/${second.token}`)).statusCode).toBe(200);
    const loggedIn = await h.logIn(returning);
    expect(loggedIn.credential).not.toBe(returning.credential);
    const rejoined = await h.join(loggedIn, second.token);
    expect(rejoined.json()).toMatchObject({ campaignId, role: 'assistant_gm' });

    // The invitation grants nothing outside its campaign and role.
    const mine = (await h.send(loggedIn, 'GET', '/users/me/campaigns')).json();
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ campaignId, role: 'assistant_gm' });
    expect((await h.send(loggedIn, 'GET', `/invitations/${second.token}`)).statusCode).toBe(404);
    h.assertNoSecretLeaks();
  }, 60_000);

  test('unusable invitations are generic, revocation ignores the creator, other roles cannot revoke', async () => {
    const h = shared;
    const { owner, campaignId, members } = await h.campaignWith(['gm', 'player']);
    const [gm, player] = members as [Session, Session];
    const stranger = await h.signUp('un_stranger');

    const revoked = await h.invite(owner, campaignId, 'player');
    const used = await h.invite(owner, campaignId, 'player');
    const expired = await h.invite(owner, campaignId, 'player');
    await h.join(await h.signUp('un_user'), used.token);
    await sqlClient()`
      update identity_invitations
      set created_at = now() - interval '5 minutes', expires_at = now()
      where id = ${expired.invitationId}`;

    // A player (and a stranger) cannot revoke; the invitation stays usable.
    for (const who of [player, stranger]) {
      const denied = await h.send(
        who,
        'DELETE',
        `/campaigns/${campaignId}/invitations/${revoked.invitationId}`,
      );
      expect([denied.statusCode, denied.json().code]).toEqual([404, 'not_found_or_forbidden']);
    }
    expect((await h.send(undefined, 'GET', `/invitations/${revoked.token}`)).statusCode).toBe(200);

    // A different owner/gm than the creator revokes it.
    const revocation = await h.send(
      gm,
      'DELETE',
      `/campaigns/${campaignId}/invitations/${revoked.invitationId}`,
    );
    expect(revocation.statusCode).toBe(204);
    const listed = (await h.send(owner, 'GET', `/campaigns/${campaignId}/invitations`)).json();
    expect(
      listed.find((invitation: { id: string }) => invitation.id === revoked.invitationId).state,
    ).toBe('revoked');

    // Every unusable state previews and accepts with the same generic result.
    const unknown = 'Z'.repeat(43);
    const states = [revoked.token, used.token, expired.token, unknown];
    const previews = await Promise.all(
      states.map((token) => h.send(undefined, 'GET', `/invitations/${token}`)),
    );
    expect(new Set(previews.map((r) => r.statusCode))).toEqual(new Set([404]));
    expect(new Set(previews.map((r) => r.body)).size).toBe(1);
    expect(previews[0]?.json().code).toBe('unusable_invitation');
    const attempts = [];
    for (const token of states)
      attempts.push(await h.send(stranger, 'POST', `/invitations/${token}/accept`));
    expect(new Set(attempts.map((r) => r.statusCode))).toEqual(new Set([404]));
    expect(new Set(attempts.map((r) => r.body)).size).toBe(1);
    expect((await h.send(stranger, 'GET', '/users/me/campaigns')).json().items).toEqual([]);
    h.assertNoSecretLeaks();
  }, 60_000);

  test('removal, role change, and ownership transfer enforce authority and revoke access at once', async () => {
    const h = shared;
    const { owner, campaignId, members } = await h.campaignWith([
      'gm',
      'gm',
      'assistant_gm',
      'player',
      'player',
    ]);
    const [gmA, gmB, assistant, player, bystander] = members as [
      Session,
      Session,
      Session,
      Session,
      Session,
    ];
    const remove = (actor: Session, target: Session) =>
      h.send(actor, 'DELETE', `/campaigns/${campaignId}/members/${target.userId}`);
    const roleOf = async (user: Session) =>
      (await h.activeMembers(campaignId)).find((row) => row.user_id === user.userId)?.role;
    const ownerCount = async () =>
      (await h.activeMembers(campaignId)).filter((row) => row.role === 'owner').length;

    // Lower or equal authority cannot remove anyone; memberships stay unchanged.
    for (const [actor, target] of [
      [assistant, player],
      [player, assistant],
      [gmA, gmB],
      [bystander, gmA],
    ] as const) {
      const denied = await remove(actor, target);
      expect(denied.statusCode).toBe(404);
    }
    expect((await h.activeMembers(campaignId)).length).toBe(6);

    // The sole owner cannot be removed by anyone.
    expect((await remove(owner, owner)).statusCode).toBe(409);
    expect((await remove(gmA, owner)).statusCode).toBeGreaterThanOrEqual(400);
    expect(await ownerCount()).toBe(1);

    // GM removes a player: access ends everywhere on the server, with audit and a signal.
    const removed = await remove(gmA, player);
    expect(removed.statusCode).toBe(204);
    expect(h.audits.at(-1)).toMatchObject({
      action: 'membership.removed',
      targetId: player.userId,
    });
    expect(h.signals.at(-1)).toMatchObject({
      campaignId,
      userId: player.userId,
      reason: 'removed',
    });
    expect((await h.send(player, 'GET', `/campaigns/${campaignId}`)).statusCode).toBe(404);
    expect((await h.send(player, 'GET', '/campaigns')).json<unknown>()).toEqual([]);
    expect((await h.send(player, 'GET', `/campaigns/${campaignId}/members`)).statusCode).toBe(404);
    expect((await h.send(player, 'GET', `/sync/bootstrap/${campaignId}`)).statusCode).toBe(404);
    expect((await h.send(player, 'GET', '/users/me/campaigns')).json().items).toEqual([]);
    const listed = (await h.send(owner, 'GET', `/campaigns/${campaignId}/members`)).json();
    expect(listed.items.map((m: { user: { id: string } }) => m.user.id)).not.toContain(
      player.userId,
    );
    expect((await remove(gmA, player)).statusCode).toBe(404);

    // A GM removes themselves; the owner is unchanged.
    expect((await remove(gmA, gmA)).statusCode).toBe(204);
    expect((await h.send(gmA, 'GET', `/campaigns/${campaignId}`)).statusCode).toBe(404);
    expect((await h.send(gmA, 'GET', `/sync/bootstrap/${campaignId}`)).statusCode).toBe(404);
    expect(await roleOf(owner)).toBe('owner');

    // Role changes: owner only, assignable non-owner roles only, effective immediately.
    const change = (actor: Session, target: Session, role: string) =>
      h.send(actor, 'PATCH', `/campaigns/${campaignId}/members/${target.userId}/role`, { role });
    const promoted = await change(owner, bystander, 'gm');
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ role: 'gm', version: 2 });
    expect(await roleOf(bystander)).toBe('gm');
    expect(h.audits.at(-1)).toMatchObject({ action: 'membership.role_changed' });
    expect((await change(owner, bystander, 'observer')).statusCode).toBe(400);
    expect((await change(owner, bystander, 'owner')).statusCode).toBe(400);
    expect((await change(owner, owner, 'gm')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await change(bystander, assistant, 'gm')).statusCode).toBe(404);
    expect(await roleOf(assistant)).toBe('assistant_gm');
    expect(await roleOf(owner)).toBe('owner');
    // The new role is what the server now enforces: a promoted gm may invite, a demoted one may not.
    expect(
      (
        await h.send(bystander, 'POST', `/campaigns/${campaignId}/invitations`, {
          targetRole: 'player',
        })
      ).statusCode,
    ).toBe(201);
    expect((await change(owner, bystander, 'player')).statusCode).toBe(200);
    expect(
      (
        await h.send(bystander, 'POST', `/campaigns/${campaignId}/invitations`, {
          targetRole: 'player',
        })
      ).statusCode,
    ).toBe(404);

    // Ownership transfer: owner only, to a current member; the former owner becomes gm.
    const transfer = (actor: Session, target: Session) =>
      h.send(actor, 'POST', `/campaigns/${campaignId}/ownership-transfer`, {
        targetUserId: target.userId,
      });
    expect((await transfer(assistant, assistant)).statusCode).toBe(404);
    expect((await transfer(owner, player)).statusCode).toBe(404);
    expect(await ownerCount()).toBe(1);
    expect(await roleOf(owner)).toBe('owner');
    const transferred = await transfer(owner, assistant);
    expect(transferred.statusCode).toBe(200);
    expect(transferred.json()).toMatchObject({
      owner: { role: 'owner', user: { id: assistant.userId } },
      formerOwner: { role: 'gm', user: { id: owner.userId } },
    });
    expect(await ownerCount()).toBe(1);
    expect(await roleOf(assistant)).toBe('owner');
    expect(await roleOf(owner)).toBe('gm');
    expect(h.audits.at(-1)).toMatchObject({ action: 'membership.ownership_transferred' });
    h.assertNoSecretLeaks();
  }, 90_000);

  test('operator recovery: single-use, revokes sessions, fails closed, and campaign authority is not recovery authority', async () => {
    const h = shared;
    const { owner, campaignId, members } = await h.campaignWith(['player']);
    const [user] = members as [Session];
    const second = await h.logIn(user);
    const newPassword = `replacement ${suffix} password material`;
    h.secrets.passwords.add(newPassword);

    // Campaign authority grants no way to issue a token: there is no HTTP issuance surface.
    const before = await sqlClient()`
      select count(*)::int as n from identity_recovery_tokens where user_id = ${user.userId}`;
    for (const url of [
      '/auth/recovery',
      '/auth/recovery/issue',
      `/users/${user.userId}/recovery`,
    ]) {
      for (const caller of [owner, undefined]) {
        const response = await h.send(caller, 'POST', url, { username: user.username });
        expect([response.statusCode, response.json().code]).toEqual([
          404,
          'not_found_or_forbidden',
        ]);
      }
    }
    const crossCampaign = await h.send(owner, 'POST', `/campaigns/${campaignId}/recovery`, {
      userId: user.userId,
    });
    expect(crossCampaign.statusCode).toBe(404);
    expect(
      (
        await sqlClient()`
          select count(*)::int as n from identity_recovery_tokens where user_id = ${user.userId}`
      )[0]?.n,
    ).toBe(before[0]?.n);

    // Only the trusted host command issues one, and it never accepts a chosen password.
    const chosen = await operatorIssue(user.username, ['--new-password', newPassword]);
    expect(chosen.exitCode).toBe(2);
    expect(chosen.stdout).toEqual([]);
    const issued = await operatorIssued(user.username);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    h.secrets.recoveryTokens.add(issued.token);
    expect(issued.stderr.join('\n')).not.toContain(issued.token);

    // An invalid new password neither changes the password nor spends the token.
    const weak = await h.send(undefined, 'POST', '/auth/recovery/consume', {
      token: issued.token,
      newPassword: 'x'.repeat(14),
    });
    expect(weak.statusCode).toBe(400);

    const consumed = await h.send(undefined, 'POST', '/auth/recovery/consume', {
      token: issued.token,
      newPassword,
    });
    expect(consumed.statusCode).toBe(204);
    expect(consumed.body).toBe('');
    expect(setCookies(consumed)).toEqual([]);

    // Every earlier session is revoked, the old password is dead, and a new login is required.
    const live = await sqlClient()`
      select count(*)::int as n from identity_sessions
      where user_id = ${user.userId} and revoked_at is null`;
    expect(live[0]?.n).toBe(0);
    for (const stale of [user, second]) {
      expect((await h.send(stale, 'GET', '/users/me/campaigns')).statusCode).toBe(401);
    }
    const oldLogin = await h.send(
      undefined,
      'POST',
      '/auth/sessions',
      { username: user.username, password: user.password },
      { ip: user.ip },
    );
    expect(oldLogin.statusCode).toBe(401);
    const recovered = await h.logIn(user, newPassword);
    expect((await h.send(recovered, 'GET', '/users/me/campaigns')).statusCode).toBe(200);

    // The token is single-use.
    const replayPassword = `replay ${suffix} password material`;
    h.secrets.passwords.add(replayPassword);
    const replay = await h.send(undefined, 'POST', '/auth/recovery/consume', {
      token: issued.token,
      newPassword: replayPassword,
    });
    expect([replay.statusCode, replay.json().code]).toEqual([404, 'not_found_or_forbidden']);
    expect((await h.send(recovered, 'GET', '/users/me/campaigns')).statusCode).toBe(200);
    const replayLogin = await h.send(
      undefined,
      'POST',
      '/auth/sessions',
      { username: user.username, password: replayPassword },
      { ip: user.ip },
    );
    expect(replayLogin.statusCode).toBe(401);

    // Expired, revoked, and unrecognized tokens fail closed with one generic result.
    const expiredIssue = await operatorIssued(user.username);
    h.secrets.recoveryTokens.add(expiredIssue.token);
    await sqlClient()`
      update identity_recovery_tokens
      set issued_at = now() - interval '30 minutes', expires_at = now()
      where user_id = ${user.userId} and used_at is null and revoked_at is null`;
    const revokedIssue = await operatorIssued(user.username);
    h.secrets.recoveryTokens.add(revokedIssue.token);
    await sqlClient()`
      update identity_recovery_tokens set revoked_at = now()
      where user_id = ${user.userId} and used_at is null and revoked_at is null
        and expires_at > now()`;
    const unusable = [expiredIssue.token, revokedIssue.token, 'Y'.repeat(43), issued.token];
    const results = [];
    for (const token of unusable) {
      results.push(
        await h.send(undefined, 'POST', '/auth/recovery/consume', {
          token,
          newPassword: `never applied ${suffix} password`,
        }),
      );
    }
    expect(new Set(results.map((r) => r.statusCode))).toEqual(new Set([404]));
    expect(new Set(results.map((r) => r.body)).size).toBe(1);
    expect((await h.logIn(user, newPassword)).userId).toBe(user.userId);

    // Concurrent consumption: exactly one attempt changes the password.
    const raced = await operatorIssued(user.username);
    h.secrets.recoveryTokens.add(raced.token);
    const candidates = [
      `race one ${suffix} password material`,
      `race two ${suffix} password material`,
    ];
    for (const candidate of candidates) h.secrets.passwords.add(candidate);
    const outcomes = await Promise.all(
      candidates.map((candidate) =>
        h.send(undefined, 'POST', '/auth/recovery/consume', {
          token: raced.token,
          newPassword: candidate,
        }),
      ),
    );
    expect(outcomes.map((r) => r.statusCode).sort()).toEqual([204, 404]);
    const winner = candidates[outcomes.findIndex((r) => r.statusCode === 204)] ?? '';
    const loser = candidates.find((candidate) => candidate !== winner) ?? '';
    expect((await h.logIn(user, winner)).userId).toBe(user.userId);
    const loserLogin = await h.send(
      undefined,
      'POST',
      '/auth/sessions',
      { username: user.username, password: loser },
      { ip: user.ip },
    );
    expect(loserLogin.statusCode).toBe(401);
    const [tokenRow] = await sqlClient()`
      select count(*)::int as n from identity_recovery_tokens
      where user_id = ${user.userId} and used_at is not null`;
    expect(tokenRow?.n).toBe(2);
    h.assertNoSecretLeaks();
  }, 120_000);

  test('account policy over HTTP: normalized uniqueness, username and password boundaries, exact password', async () => {
    const h = shared;
    const create = (username: string, password: string) =>
      h.send(undefined, 'POST', '/auth/accounts', { username, password }, { ip: nextIp() });
    const accountRows = async (normalized: string) =>
      (
        await sqlClient()`
          select
            (select count(*)::int from identity_users where username_normalized = ${normalized}) as users,
            (select count(*)::int from identity_sessions s join identity_users u on u.id = s.user_id
              where u.username_normalized = ${normalized}) as sessions`
      )[0];
    const base = `Pol${suffix}`;
    const password = `policy ${suffix} password ok`;
    h.secrets.passwords.add(password);

    // Unique after normalization: the second submission is rejected and creates nothing.
    const first = await create(`${base}_GM`, password);
    expect(first.statusCode).toBe(200);
    expect(first.json().user.username).toBe(`${base}_GM`);
    for (const variant of [`  ${base.toLowerCase()}_gm  `, `${base.toUpperCase()}_gm`]) {
      const duplicate = await create(variant, password);
      expect([duplicate.statusCode, duplicate.json().code]).toEqual([409, 'username_taken']);
      expect(setCookies(duplicate)).toEqual([]);
    }
    expect(await accountRows(`${base.toLowerCase()}_gm`)).toEqual({ users: 1, sessions: 1 });

    // Outside the username policy: rejected with no account and no session.
    const rejectedUsernames = [
      'ab',
      'abcdefghijklmnopqrstuvwxyz1234567',
      `_${base}`,
      `${base} gm`,
      `${base}josé`,
    ];
    for (const username of rejectedUsernames) {
      const response = await create(username, password);
      expect([username, response.statusCode]).toEqual([username, 400]);
      expect(setCookies(response)).toEqual([]);
    }
    expect(
      (
        await sqlClient()`
          select count(*)::int as n from identity_users
          where username_normalized in (${rejectedUsernames.map((name) => name.trim().toLowerCase())})`
      )[0]?.n,
    ).toBe(0);

    // Password boundaries in code points: 14 and 129 rejected; 15, and 128 four-byte points, accepted.
    const boundaries: readonly [string, number, boolean][] = [
      ['pw14', 14, false],
      ['pw15', 15, true],
      ['pw128', 128, true],
      ['pw129', 129, false],
    ];
    for (const [label, points, accepted] of boundaries) {
      const candidate = (label === 'pw128' ? '\u{1F3B2}' : 'x').repeat(points);
      h.secrets.passwords.add(candidate);
      const username = `${label}_${suffix}`;
      const response = await create(username, candidate);
      expect([label, response.statusCode]).toEqual([label, accepted ? 200 : 400]);
      expect((await accountRows(username))?.users).toBe(accepted ? 1 : 0);
    }
    const emoji = '\u{1F3B2}'.repeat(128);
    expect(new TextEncoder().encode(emoji).length).toBe(512);

    // The exact submitted sequence is the password: no trimming, no Unicode normalization.
    const spaced = ` ${'s'.repeat(15)}`;
    const composed = `café ${'c'.repeat(12)}`;
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    for (const secret of [spaced, composed]) h.secrets.passwords.add(secret);
    const exact = await create(`exact_${suffix}`, spaced);
    const unicode = await create(`nfc_${suffix}`, composed);
    expect([exact.statusCode, unicode.statusCode]).toEqual([200, 200]);
    const login = (username: string, candidate: string) =>
      h.send(
        undefined,
        'POST',
        '/auth/sessions',
        { username, password: candidate },
        { ip: nextIp() },
      );
    expect((await login(`exact_${suffix}`, spaced.trim().padEnd(16, 's'))).statusCode).toBe(401);
    expect((await login(`exact_${suffix}`, 's'.repeat(15))).statusCode).toBe(401);
    expect((await login(`exact_${suffix}`, spaced)).statusCode).toBe(200);
    expect((await login(`nfc_${suffix}`, decomposed)).statusCode).toBe(401);
    expect((await login(`nfc_${suffix}`, composed)).statusCode).toBe(200);
    h.assertNoSecretLeaks();
  }, 90_000);

  test('no P0 account-deletion operation exists; membership removal is the way to revoke access', async () => {
    const h = shared;
    const user = await h.signUp('nodelete');
    for (const [method, url] of [
      ['DELETE', '/users/me'],
      ['DELETE', `/users/${user.userId}`],
      ['DELETE', '/auth/accounts'],
      ['DELETE', '/accounts/me'],
      ['POST', '/users/me/delete'],
    ] as const) {
      const response = await h.send(user, method, url);
      expect([response.statusCode, response.json().code]).toEqual([404, 'not_found_or_forbidden']);
    }
    const [row] = await sqlClient()`
      select count(*)::int as n from identity_users where id = ${user.userId}`;
    expect(row?.n).toBe(1);
    expect((await h.send(user, 'GET', '/users/me/campaigns')).statusCode).toBe(200);
  });

  test('client-supplied role claims never change authorization', async () => {
    const h = shared;
    const { owner, campaignId, members } = await h.campaignWith(['player']);
    const [player] = members as [Session];
    const forged = { 'x-campaign-role': 'owner', 'x-role': 'owner', role: 'owner' };
    const invitationRows = async () =>
      (
        await sqlClient()`
          select count(*)::int as n from identity_invitations where campaign_id = ${campaignId}`
      )[0]?.n;
    const invitationsBefore = await invitationRows();

    const byHeader = await h.send(
      player,
      'POST',
      `/campaigns/${campaignId}/invitations`,
      { targetRole: 'player' },
      { headers: forged },
    );
    expect([byHeader.statusCode, byHeader.json().code]).toEqual([404, 'not_found_or_forbidden']);
    for (const reserved of ['observer', 'owner']) {
      const response = await h.send(owner, 'POST', `/campaigns/${campaignId}/invitations`, {
        targetRole: reserved,
      });
      expect([reserved, response.statusCode]).toEqual([reserved, 400]);
    }
    const byBody = await h.send(player, 'POST', `/campaigns/${campaignId}/invitations`, {
      targetRole: 'player',
      role: 'owner',
      actorRole: 'owner',
    });
    expect(byBody.statusCode).toBe(400);
    const byQuery = await h.send(
      player,
      'DELETE',
      `/campaigns/${campaignId}/members/${owner.userId}?role=owner&actorRole=owner`,
      undefined,
      { headers: forged },
    );
    expect(byQuery.statusCode).toBeGreaterThanOrEqual(400);
    const selfPromotion = await h.send(
      player,
      'PATCH',
      `/campaigns/${campaignId}/members/${player.userId}/role`,
      { role: 'gm', actorRole: 'owner' },
      { headers: forged },
    );
    expect(selfPromotion.statusCode).toBe(400);
    const selfPromotionValid = await h.send(
      player,
      'PATCH',
      `/campaigns/${campaignId}/members/${player.userId}/role`,
      { role: 'gm' },
      { headers: forged },
    );
    expect(selfPromotionValid.statusCode).toBe(404);
    const edit = await h.send(
      player,
      'PATCH',
      `/campaigns/${campaignId}`,
      { name: 'Hijacked', description: '', expectedVersion: 1, actorRole: 'owner' },
      { headers: forged },
    );
    expect(edit.statusCode).toBeGreaterThanOrEqual(400);

    expect(await invitationRows()).toBe(invitationsBefore);
    const rows = await h.activeMembers(campaignId);
    expect(rows.map((row) => [row.user_id, row.role])).toEqual([
      [owner.userId, 'owner'],
      [player.userId, 'player'],
    ]);
    const campaign = (await h.send(owner, 'GET', `/campaigns/${campaignId}`)).json();
    expect(campaign.name).toBe('Identity Game');
  }, 60_000);

  test('session lifecycle: expiry boundary, logout revocation, origin-checked logout, generic login failure', async () => {
    const h = shared;
    const user = await h.signUp('sess');
    const other = await h.logIn(user);
    const expiring = await h.logIn(user);
    const probe = (who: Session) => h.send(who, 'GET', '/users/me/campaigns');

    // Expired: expiry is exclusive, so a session whose expiry has been reached is unauthenticated.
    const digest = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expiring.credential)),
    );
    await sqlClient()`
      update identity_sessions
      set created_at = now() - interval '30 days', expires_at = now()
      where credential_digest = ${digest}`;
    expect((await probe(expiring)).statusCode).toBe(401);
    expect((await probe(other)).statusCode).toBe(200);
    expect((await probe(user)).statusCode).toBe(200);

    // Logout needs a same-origin request and revokes exactly that credential.
    for (const bad of [null, 'https://attacker.invalid', 'null']) {
      const denied = await h.send(other, 'DELETE', '/auth/session', undefined, { origin: bad });
      expect(denied.statusCode).toBe(403);
      expect((await probe(other)).statusCode).toBe(200);
    }
    const loggedOut = await h.send(other, 'DELETE', '/auth/session');
    expect(loggedOut.statusCode).toBe(204);
    expect(setCookies(loggedOut).join(';')).toContain('Max-Age=0');
    const afterLogout = await probe(other);
    expect(afterLogout.statusCode).toBe(401);
    const [revoked] = await sqlClient()`
      select count(*)::int as n from identity_sessions
      where user_id = ${user.userId} and revoked_at is not null`;
    expect(revoked?.n).toBe(1);
    expect((await probe(user)).statusCode).toBe(200);

    // Invalid credentials: one generic result for a wrong password and an unknown user.
    const wrongPassword = await h.send(
      undefined,
      'POST',
      '/auth/sessions',
      { username: user.username, password: 'this is definitely incorrect' },
      { ip: user.ip },
    );
    const unknownUser = await h.send(
      undefined,
      'POST',
      '/auth/sessions',
      { username: `ghost_${suffix}`, password: 'this is definitely incorrect' },
      { ip: user.ip },
    );
    expect([wrongPassword.statusCode, unknownUser.statusCode]).toEqual([401, 401]);
    expect(wrongPassword.body).toBe(unknownUser.body);
    expect(wrongPassword.json().code).toBe('invalid_credentials');
    expect(setCookies(wrongPassword)).toEqual([]);
    expect(h.lines.join('')).toContain('login failed');
    expect(h.lines.join('')).not.toContain('this is definitely incorrect');
    h.assertNoSecretLeaks();
  }, 60_000);

  test('mutations require a same-origin request and change nothing without one', async () => {
    const h = shared;
    const { owner, campaignId, members } = await h.campaignWith(['player']);
    const [player] = members as [Session];
    const pending = await h.invite(owner, campaignId, 'player');
    const outsider = await h.signUp('og_outsider');
    const before = {
      members: await h.activeMembers(campaignId),
      invitations: (
        await sqlClient()`
          select count(*)::int as n from identity_invitations
          where campaign_id = ${campaignId} and revoked_at is null and used_at is null`
      )[0]?.n,
    };
    const requests: readonly {
      readonly who: Session;
      readonly method: Method;
      readonly url: string;
      readonly payload?: unknown;
    }[] = [
      {
        who: owner,
        method: 'POST',
        url: `/campaigns/${campaignId}/invitations`,
        payload: { targetRole: 'gm' },
      },
      {
        who: owner,
        method: 'DELETE',
        url: `/campaigns/${campaignId}/invitations/${pending.invitationId}`,
      },
      { who: owner, method: 'DELETE', url: `/campaigns/${campaignId}/members/${player.userId}` },
      {
        who: owner,
        method: 'PATCH',
        url: `/campaigns/${campaignId}/members/${player.userId}/role`,
        payload: { role: 'gm' },
      },
      {
        who: owner,
        method: 'POST',
        url: `/campaigns/${campaignId}/ownership-transfer`,
        payload: { targetUserId: player.userId },
      },
      { who: outsider, method: 'POST', url: `/invitations/${pending.token}/accept` },
    ];
    for (const bad of [null, 'https://attacker.invalid', origin.replace('https', 'http')]) {
      for (const request of requests) {
        const response = await h.send(request.who, request.method, request.url, request.payload, {
          origin: bad,
        });
        expect([request.method, request.url, response.statusCode]).toEqual([
          request.method,
          request.url,
          403,
        ]);
      }
    }
    expect(await h.activeMembers(campaignId)).toEqual(before.members);
    expect(
      (
        await sqlClient()`
          select count(*)::int as n from identity_invitations
          where campaign_id = ${campaignId} and revoked_at is null and used_at is null`
      )[0]?.n,
    ).toBe(before.invitations);
    expect((await h.send(outsider, 'GET', '/users/me/campaigns')).json().items).toEqual([]);
    expect((await h.send(undefined, 'GET', `/invitations/${pending.token}`)).statusCode).toBe(200);
    // Reads need no origin; the same call with the correct origin succeeds.
    expect((await h.send(owner, 'GET', `/campaigns/${campaignId}/members`)).statusCode).toBe(200);
    expect(
      (await h.send(outsider, 'POST', `/invitations/${pending.token}/accept`)).statusCode,
    ).toBe(200);
  }, 60_000);

  test('cookie policy: HttpOnly, SameSite=Lax, Secure in production, digest-only storage', async () => {
    const development = shared;
    const production = harness({ production: true });
    for (const [h, secure] of [
      [development, false],
      [production, true],
    ] as const) {
      const user = await h.signUp('cookie');
      const response = await h.send(
        undefined,
        'POST',
        '/auth/sessions',
        { username: user.username, password: user.password },
        { ip: user.ip },
      );
      expect(response.statusCode).toBe(200);
      const cookie = setCookies(response)[0] ?? '';
      expect(cookie).toMatch(/^rpg_session=[A-Za-z0-9_-]{43}; /);
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie.includes('Secure')).toBe(secure);
      const expires = /Expires=([^;]+)/.exec(cookie)?.[1] ?? '';
      expect(new Date(expires).getTime()).toBe(
        Math.floor(new Date(response.json().session.expiresAt).getTime() / 1000) * 1000,
      );
      // The body carries the session description but never the credential.
      expect(Object.keys(response.json()).sort()).toEqual(['session', 'user']);
      expect(response.body).not.toContain(
        cookie.slice('rpg_session='.length, 'rpg_session='.length + 43),
      );
      expect(JSON.stringify(response.json())).not.toMatch(/password|hash|digest|credential/i);

      const credential = SESSION_COOKIE.exec(cookie)?.[1] ?? '';
      const [stored] = await sqlClient()`
        select octet_length(credential_digest)::int as length,
               position(convert_to(${credential}, 'UTF8') in credential_digest)::int as found
        from identity_sessions where user_id = ${user.userId}
        order by created_at desc limit 1`;
      expect(stored).toEqual({ length: 32, found: 0 });
      expect(h.assertNoSecretLeaks().responses).toBeGreaterThan(0);
    }
  }, 60_000);

  test('rate limiting is per client and scope, fails closed, and reveals no account existence', async () => {
    const h = harness();
    const victim = await h.signUp('rl');
    const address = '192.0.2.10';
    const attempt = (username: string, password: string, ip = address) =>
      h.send(undefined, 'POST', '/auth/sessions', { username, password }, { ip });

    // Login: the first ten attempts (existing or unknown users) all fail identically.
    const failures = [];
    for (let index = 0; index < 10; index += 1) {
      failures.push(
        await attempt(
          index % 2 === 0 ? victim.username : `ghost_${suffix}_${index}`,
          'wrong password material',
        ),
      );
    }
    expect(new Set(failures.map((r) => r.statusCode))).toEqual(new Set([401]));
    expect(new Set(failures.map((r) => r.json().code))).toEqual(new Set(['invalid_credentials']));

    // The eleventh is limited even with the correct password: no session, no oracle.
    const limited = await attempt(victim.username, victim.password);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('limit_exceeded');
    expect(setCookies(limited)).toEqual([]);
    expect(limited.body).not.toContain(victim.username);
    const limitedUnknown = await attempt(`ghost_${suffix}_x`, 'wrong password material');
    expect(limitedUnknown.statusCode).toBe(429);
    expect(limitedUnknown.body).toBe(limited.body);

    // Another client address is unaffected, and so is another scope for the limited one.
    expect((await attempt(victim.username, victim.password, '192.0.2.11')).statusCode).toBe(200);

    // Account creation is limited too, and a refused request creates no account.
    const creator = '192.0.2.20';
    const created = [];
    for (let index = 0; index < 10; index += 1) {
      created.push(
        await h.send(
          undefined,
          'POST',
          '/auth/accounts',
          {
            username: `rl_${suffix}_${index}`,
            password: `rate limit creation ${suffix} ${index} ok`,
          },
          { ip: creator },
        ),
      );
    }
    expect(new Set(created.map((r) => r.statusCode))).toEqual(new Set([200]));
    const refused = await h.send(
      undefined,
      'POST',
      '/auth/accounts',
      { username: `rl_${suffix}_blocked`, password: `rate limit creation ${suffix} blocked ok` },
      { ip: creator },
    );
    expect(refused.statusCode).toBe(429);
    expect(setCookies(refused)).toEqual([]);
    expect(
      (
        await sqlClient()`
          select count(*)::int as n from identity_users
          where username_normalized = ${`rl_${suffix}_blocked`}`
      )[0]?.n,
    ).toBe(0);

    // Recovery consumption: brute force is limited and a limited valid token is not spent.
    const issued = await operatorIssued(victim.username);
    h.secrets.recoveryTokens.add(issued.token);
    const guesser = '192.0.2.30';
    for (let index = 0; index < 10; index += 1) {
      const guess = await h.send(
        undefined,
        'POST',
        '/auth/recovery/consume',
        { token: String(index).repeat(43), newPassword: `never applied ${suffix} password` },
        { ip: guesser },
      );
      expect(guess.statusCode).toBe(404);
    }
    const newPassword = `after limit ${suffix} password material`;
    h.secrets.passwords.add(newPassword);
    const blocked = await h.send(
      undefined,
      'POST',
      '/auth/recovery/consume',
      { token: issued.token, newPassword },
      { ip: guesser },
    );
    expect(blocked.statusCode).toBe(429);
    const [unspent] = await sqlClient()`
      select count(*)::int as n from identity_recovery_tokens
      where user_id = ${victim.userId} and used_at is null and revoked_at is null`;
    expect(unspent?.n).toBeGreaterThanOrEqual(1);
    const accepted = await h.send(
      undefined,
      'POST',
      '/auth/recovery/consume',
      { token: issued.token, newPassword },
      { ip: '192.0.2.31' },
    );
    expect(accepted.statusCode).toBe(204);
    h.assertNoSecretLeaks();
  }, 120_000);

  test('no raw secret reached a browser-visible response carrier or a captured log line', () => {
    const { responses, logLines } = shared.assertNoSecretLeaks();
    expect(responses).toBeGreaterThan(100);
    expect(logLines).toBeGreaterThan(100);
    expect(shared.secrets.passwords.size).toBeGreaterThan(10);
    expect(shared.secrets.sessionCredentials.size).toBeGreaterThan(10);
    expect(shared.secrets.invitationTokens.size).toBeGreaterThan(5);
    expect(shared.secrets.recoveryTokens.size).toBeGreaterThanOrEqual(4);
    // The one intended carriers were actually exercised: cookie on session issuance, token on invitation issuance.
    expect(
      shared.recorded.some(
        (r) => r.setCookie.includes('rpg_session=') && r.url === '/auth/accounts',
      ),
    ).toBe(true);
    expect(
      shared.recorded.some((r) => r.url.endsWith('/invitations') && r.body.includes('"token"')),
    ).toBe(true);
  });
});
