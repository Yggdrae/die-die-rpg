import { expect, type Page, test } from '@playwright/test';

/**
 * Feature 01 task 13: identity and membership flows at the UI boundary. The API is mocked at
 * the network edge (the repository's e2e convention, see identity-campaign.e2e.ts); the real
 * server contract is asserted against the runtime and PostgreSQL in
 * apps/api/src/identity-p0.integration.test.ts.
 */

const ownerId = '00000000-0000-4000-8000-000000000501';
const campaignId = '00000000-0000-4000-8000-000000000502';
const invitationToken = 'k'.repeat(43);
const recoveryToken = 'r'.repeat(43);
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new password value';
const FIXTURE_REF = { systemId: 'fixture-system', version: '0.1.0' };

interface Req {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}
type Res = { status: number; contentType: string; body: string };

function json(body: unknown, status = 200): Res {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function mockApi(page: Page, handler: (request: Req) => Res | undefined) {
  const seen: Req[] = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    const mapped: Req = {
      path: new URL(request.url()).pathname,
      method: request.method(),
      body: request.postDataJSON?.() as unknown,
      headers: request.headers(),
    };
    const response = handler(mapped);
    if (response === undefined) {
      await route.continue();
      return;
    }
    seen.push(mapped);
    await route.fulfill(response);
  });
  return seen;
}

function authResponse(userId: string, username: string) {
  return json({ user: { id: userId, username }, session: { expiresAt: '2026-09-01T00:00:00Z' } });
}

function campaignView() {
  return {
    id: campaignId,
    name: 'Table Game',
    description: '',
    system: FIXTURE_REF,
    gameMode: 'standard',
    modulePins: [],
    settings: {},
    version: 1,
    createdAt: '2026-08-30T00:00:00Z',
    updatedAt: '2026-08-30T00:00:00Z',
  };
}

function member(userId: string, username: string, role: string) {
  return {
    campaignId,
    user: { id: userId, username },
    role,
    version: 1,
    updatedAt: '2026-08-30T00:00:00Z',
  };
}

async function logIn(page: Page, username: string, password = PASSWORD) {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

/** The client never states who is acting: no role header, no actor-role field in any body. */
function expectNoActorRoleClaims(seen: readonly Req[]) {
  for (const request of seen) {
    expect(Object.keys(request.headers).filter((name) => /role/i.test(name))).toEqual([]);
    expect(JSON.stringify(request.body ?? null)).not.toMatch(
      /actorRole|callerRole|userRole|memberRole|authenticatedRole|campaignRole/,
    );
  }
}

async function storedText(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
}

test('login then logout ends the session and keeps no secret in the page or browser storage', async ({
  page,
}) => {
  const seen = await mockApi(page, ({ path, method }) => {
    if (path === '/auth/sessions' && method === 'POST') return authResponse(ownerId, 'table_owner');
    if (path === '/auth/session' && method === 'DELETE') return json(undefined, 204);
    if (path === '/systems') return json([]);
    if (path === '/campaigns' && method === 'GET') return json([]);
    return undefined;
  });

  await page.goto('/');
  await logIn(page, 'table_owner');
  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
  expect(await storedText(page)).not.toContain(PASSWORD);
  expect(await page.content()).not.toContain(PASSWORD);

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toHaveCount(0);
  expect(
    seen.filter((request) => request.method === 'DELETE' && request.path === '/auth/session'),
  ).toHaveLength(1);
  // After logout the form is empty and nothing from the session remains.
  await expect(page.getByLabel('Password')).toHaveValue('');
  expect(await storedText(page)).not.toContain(PASSWORD);
  expectNoActorRoleClaims(seen);
});

test('a logged-out invitation survives a failed login and completes through account creation', async ({
  page,
}) => {
  let attempts = 0;
  const seen = await mockApi(page, ({ path, method }) => {
    if (path === `/invitations/${invitationToken}` && method === 'GET') {
      return json({
        campaignDisplayName: 'Invited Game',
        targetRole: 'assistant_gm',
        expiresAt: '2026-09-01T00:00:00Z',
      });
    }
    if (path === '/auth/sessions' && method === 'POST') {
      attempts += 1;
      return json({ code: 'invalid_credentials', message: 'Invalid credentials.' }, 401);
    }
    if (path === '/auth/accounts' && method === 'POST') return authResponse(ownerId, 'new_player');
    if (path === `/invitations/${invitationToken}/accept` && method === 'POST') {
      return json(member(ownerId, 'new_player', 'assistant_gm'));
    }
    if (path === '/campaigns' && method === 'GET') return json([]);
    if (path === '/systems') return json([]);
    return undefined;
  });

  await page.goto(`/invite/${invitationToken}`);
  // Preview shows exactly the campaign name, role, and expiry.
  const preview = page.getByText(/Join/);
  await expect(preview).toContainText('Invited Game');
  await expect(preview).toContainText('assistant_gm');
  await expect(page.getByText(campaignId)).toHaveCount(0);

  // A failed login neither accepts nor discards the invitation.
  await logIn(page, 'new_player', 'wrong password material');
  await expect(page.getByRole('alert')).toHaveText('invalid_credentials');
  await expect(preview).toContainText('Invited Game');
  expect(attempts).toBe(1);
  expect(seen.some((request) => request.path.endsWith('/accept'))).toBe(false);

  // Creating an account completes the join and lands in the campaign.
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Username').fill('new_player');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('form').getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText(`Joined campaign ${campaignId}.`)).toBeVisible();

  const sequence = seen
    .filter((request) => request.method === 'POST')
    .map((request) => `${request.method} ${request.path}`);
  expect(sequence).toEqual([
    'POST /auth/sessions',
    'POST /auth/accounts',
    `POST /invitations/${invitationToken}/accept`,
  ]);
  expect(sequence.filter((entry) => entry.endsWith('/accept'))).toHaveLength(1);
  const accept = seen.find((request) => request.path.endsWith('/accept'));
  expect(accept?.body ?? null).toBeNull();
  expectNoActorRoleClaims(seen);
});

test('an unusable invitation shows one generic message and reveals nothing', async ({ page }) => {
  await mockApi(page, ({ path, method }) => {
    if (path.startsWith('/invitations/') && method === 'GET') {
      return json({ code: 'unusable_invitation', message: 'Invitation unavailable.' }, 404);
    }
    return undefined;
  });

  await page.goto(`/invite/${invitationToken}`);
  await expect(page.getByRole('alert')).toHaveText('Invitation unavailable.');
  await expect(page.getByText(/Join/)).toHaveCount(0);
  await expect(page.getByText(/expired|revoked|already used/i)).toHaveCount(0);
});

test('an owner revokes a pending invitation and it can no longer be used', async ({ page }) => {
  const invitation = {
    id: '00000000-0000-4000-8000-000000000601',
    campaignId,
    targetRole: 'player',
    expiresAt: '2026-09-01T00:00:00Z',
    state: 'usable',
  };
  const seen = await mockApi(page, ({ path, method }) => {
    if (path === '/auth/sessions' && method === 'POST') return authResponse(ownerId, 'table_owner');
    if (path === '/systems') return json([]);
    if (path === '/campaigns' && method === 'GET') return json([campaignView()]);
    if (path === `/campaigns/${campaignId}/members`) {
      return json({ items: [member(ownerId, 'table_owner', 'owner')] });
    }
    if (path === `/campaigns/${campaignId}/invitations` && method === 'GET') {
      return json([invitation]);
    }
    if (path === `/campaigns/${campaignId}/invitations/${invitation.id}` && method === 'DELETE') {
      invitation.state = 'revoked';
      return json(undefined, 204);
    }
    return undefined;
  });

  await page.goto('/');
  await logIn(page, 'table_owner');
  await expect(page.getByText('player — usable')).toBeVisible();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('player — revoked')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
  expect(
    seen.filter((request) => request.method === 'DELETE' && request.path.includes('/invitations/')),
  ).toHaveLength(1);
  expectNoActorRoleClaims(seen);
});

test('an owner removes a member and changes a role; the UI sends no authority of its own', async ({
  page,
}) => {
  const gmId = '00000000-0000-4000-8000-000000000511';
  const playerId = '00000000-0000-4000-8000-000000000512';
  let members = [
    member(ownerId, 'table_owner', 'owner'),
    member(gmId, 'table_gm', 'gm'),
    member(playerId, 'table_player', 'player'),
  ];
  const seen = await mockApi(page, ({ path, method, body }) => {
    if (path === '/auth/sessions' && method === 'POST') return authResponse(ownerId, 'table_owner');
    if (path === '/systems') return json([]);
    if (path === '/campaigns' && method === 'GET') return json([campaignView()]);
    if (path === `/campaigns/${campaignId}/members` && method === 'GET') {
      return json({ items: members });
    }
    if (path === `/campaigns/${campaignId}/invitations`) return json([]);
    if (path === `/campaigns/${campaignId}/members/${playerId}` && method === 'DELETE') {
      members = members.filter((entry) => entry.user.id !== playerId);
      return json(undefined, 204);
    }
    if (path === `/campaigns/${campaignId}/members/${gmId}/role` && method === 'PATCH') {
      const role = (body as { role: string }).role;
      members = members.map((entry) => (entry.user.id === gmId ? { ...entry, role } : entry));
      return json(members.find((entry) => entry.user.id === gmId));
    }
    return undefined;
  });

  await page.goto('/');
  await logIn(page, 'table_owner');
  const row = (name: string) => page.getByRole('listitem').filter({ hasText: `${name} —` });
  await expect(row('table_player')).toBeVisible();
  // The owner cannot be removed from the UI; lower roles can.
  await expect(row('table_owner').getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await expect(row('table_gm').getByRole('button', { name: 'Remove' })).toHaveCount(1);

  await row('table_gm').getByLabel('Role for table_gm').selectOption('assistant_gm');
  await expect(page.getByText('table_gm — assistant_gm')).toBeVisible();
  const change = seen.find((request) => request.method === 'PATCH');
  expect(change?.body).toEqual({ role: 'assistant_gm' });

  await row('table_player').getByRole('button', { name: 'Remove' }).click();
  await expect(row('table_player')).toHaveCount(0);
  await expect(row('table_gm')).toBeVisible();
  expect(
    seen.filter((request) => request.method === 'DELETE' && request.path.includes('/members/')),
  ).toHaveLength(1);
  expectNoActorRoleClaims(seen);
});

test('a gm sees removal only for lower roles and themselves, never another gm or the owner', async ({
  page,
}) => {
  const gmId = '00000000-0000-4000-8000-000000000521';
  const members = [
    member(ownerId, 'table_owner', 'owner'),
    member(gmId, 'table_gm', 'gm'),
    member('00000000-0000-4000-8000-000000000522', 'other_gm', 'gm'),
    member('00000000-0000-4000-8000-000000000523', 'table_assistant', 'assistant_gm'),
    member('00000000-0000-4000-8000-000000000524', 'table_player', 'player'),
  ];
  const seen = await mockApi(page, ({ path, method }) => {
    if (path === '/auth/sessions' && method === 'POST') return authResponse(gmId, 'table_gm');
    if (path === '/systems') return json([]);
    if (path === '/campaigns' && method === 'GET') return json([campaignView()]);
    if (path === `/campaigns/${campaignId}/members`) return json({ items: members });
    if (path === `/campaigns/${campaignId}/invitations`) return json([]);
    return undefined;
  });

  await page.goto('/');
  await logIn(page, 'table_gm');
  const removeIn = (name: string) =>
    page
      .getByRole('listitem')
      .filter({ hasText: `${name} —` })
      .getByRole('button', { name: 'Remove' });
  await expect(page.getByText('table_player — player')).toBeVisible();
  for (const [name, expected] of [
    ['table_owner', 0],
    ['other_gm', 0],
    ['table_gm', 1],
    ['table_assistant', 1],
    ['table_player', 1],
  ] as const) {
    await expect(removeIn(name)).toHaveCount(expected);
  }
  // A gm cannot change roles or transfer ownership.
  await expect(page.getByLabel(/Role for/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Transfer ownership' })).toHaveCount(0);
  expectNoActorRoleClaims(seen);
});

test('a recovery token sets a new password; a rejected token reveals only its generic code', async ({
  page,
}) => {
  let accepted = false;
  const seen = await mockApi(page, ({ path, method, body }) => {
    if (path === '/auth/recovery/consume' && method === 'POST') {
      const input = body as { token: string; newPassword: string };
      if (input.token !== recoveryToken || accepted) {
        return json({ code: 'not_found_or_forbidden', message: 'Not found.' }, 404);
      }
      accepted = true;
      return json(undefined, 204);
    }
    if (path === '/auth/sessions' && method === 'POST') {
      const input = body as { password: string };
      return input.password === NEW_PASSWORD
        ? authResponse(ownerId, 'table_owner')
        : json({ code: 'invalid_credentials', message: 'Invalid credentials.' }, 401);
    }
    if (path === '/systems') return json([]);
    if (path === '/campaigns' && method === 'GET') return json([]);
    return undefined;
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Use recovery token' }).click();
  await expect(page.getByRole('heading', { name: 'Recover account' })).toBeVisible();

  // An unrecognized token fails closed without saying why.
  await page.getByLabel('Recovery token').fill('z'.repeat(43));
  await page.getByLabel('New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Replace password' }).click();
  await expect(page.getByRole('alert')).toHaveText('not_found_or_forbidden');
  await expect(page.getByRole('heading', { name: 'Recover account' })).toBeVisible();

  // The operator-issued token replaces the password and returns to login: no session yet.
  await page.getByLabel('Recovery token').fill(recoveryToken);
  await page.getByRole('button', { name: 'Replace password' }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toHaveCount(0);

  // The old password no longer works; the new one does.
  await logIn(page, 'table_owner', PASSWORD);
  await expect(page.getByRole('alert')).toHaveText('invalid_credentials');
  await logIn(page, 'table_owner', NEW_PASSWORD);
  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();

  const consume = seen.filter((request) => request.path === '/auth/recovery/consume');
  expect(consume).toHaveLength(2);
  expect(consume[1]?.body).toEqual({ token: recoveryToken, newPassword: NEW_PASSWORD });
  expect(await storedText(page)).not.toContain(recoveryToken);
  expect(await storedText(page)).not.toContain(NEW_PASSWORD);
  expect(await page.content()).not.toContain(recoveryToken);
  expectNoActorRoleClaims(seen);
});
