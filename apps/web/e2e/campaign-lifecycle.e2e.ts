import { expect, type Page, test } from '@playwright/test';

/**
 * Feature 02 acceptance flows at the UI boundary. The API is mocked at the network edge
 * (the repository's e2e convention, see identity-campaign.e2e.ts); server-side behavior is
 * asserted against the real runtime and PostgreSQL in
 * apps/api/src/campaign-lifecycle.integration.test.ts.
 */

const userId = '00000000-0000-4000-8000-000000000101';
const campaignId = '00000000-0000-4000-8000-000000000401';
const FIXTURE_REF = { systemId: 'fixture-system', version: '0.1.0' };
const NEWER_REF = { systemId: 'fixture-system', version: '0.2.0' };

interface Req {
  readonly path: string;
  readonly search: string;
  readonly method: string;
  readonly body: unknown;
}
type Res = { status: number; contentType: string; body: string };

function json(body: unknown, status = 200): Res {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function mockApi(page: Page, handler: (request: Req) => Res | undefined) {
  const seen: Req[] = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const mapped: Req = {
      path: url.pathname,
      search: url.search,
      method: request.method(),
      body: request.postDataJSON?.() as unknown,
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

const summary = {
  ref: FIXTURE_REF,
  name: 'Fixture System',
  shortDescription: 'A generic test system with no product-specific behavior.',
  complexity: 'medium',
  documentationStatus: 'external',
  rulesEntryPoint: 'https://example.invalid/fixture-rules',
  integration: {
    mechanicsSupported: true,
    characterSheetSupported: true,
    rulesTextIntegrated: false,
    compendiumIntegrated: false,
    externalDocumentation: 'https://example.invalid/fixture-rules',
  },
};

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: campaignId,
    name: 'Road Game',
    description: '',
    system: FIXTURE_REF,
    gameMode: 'standard',
    modulePins: [],
    settings: {},
    version: 1,
    createdAt: '2026-08-30T00:00:00Z',
    updatedAt: '2026-08-30T00:00:00Z',
    ...overrides,
  };
}

function membership(role: string) {
  return {
    campaignId,
    user: { id: userId, username: 'table_user' },
    role,
    version: 1,
    joinedAt: '2026-08-30T00:00:00Z',
  };
}

async function logIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Username').fill('table_user');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
}

const loginResponse = json({
  user: { id: userId, username: 'table_user' },
  session: { expiresAt: '2026-09-01T00:00:00Z' },
});

test('wizard offers only declared choices, searches summaries, and a failed creation persists nothing', async ({
  page,
}) => {
  let failNext = true;
  const seen = await mockApi(page, ({ path, search, method, body }) => {
    if (path === '/auth/sessions' && method === 'POST') return loginResponse;
    if (path === '/systems' && method === 'GET') {
      return json(search.includes('query=zzz') ? [] : [summary]);
    }
    if (path === '/campaigns' && method === 'GET') return json([]);
    if (path === '/campaigns' && method === 'POST') {
      if (failNext) {
        failNext = false;
        return json({ code: 'internal_error', message: 'Something went wrong.' }, 500);
      }
      const input = body as { id: string; name: string; system: unknown; gameMode: string };
      return json(campaign({ id: input.id, name: input.name, gameMode: input.gameMode }), 201);
    }
    if (path.endsWith('/members')) return json({ items: [membership('owner')] });
    if (path.endsWith('/invitations')) return json([]);
    return undefined;
  });
  await logIn(page);

  // Selection renders from the summary and shows each integration status separately.
  await expect(page.getByRole('radio', { name: /Fixture System/ })).toBeVisible();
  const statuses = page.getByText(/Mechanics supported; character sheet supported/);
  await expect(statuses).toContainText('rules text not integrated');
  await expect(statuses).toContainText('compendium not integrated');
  await expect(statuses).toContainText('external documentation available');
  // Rules are reachable before a campaign exists, without creating one or changing selection.
  await expect(page.getByRole('link', { name: 'Rules for Fixture System' })).toHaveAttribute(
    'href',
    'https://example.invalid/fixture-rules',
  );

  // Search narrows to declared summary fields; clearing restores the list.
  await page.getByLabel('Search systems').fill('zzz');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('No installed system matches.')).toBeVisible();
  await page.getByLabel('Search systems').fill('');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('radio', { name: /Fixture System/ }).check();

  // Only declared modes appear; steps with nothing declared are skipped.
  const modes = page.getByRole('group', { name: 'Game mode' }).getByRole('radio');
  await expect(modes).toHaveCount(1);
  await expect(modes.first()).toHaveAccessibleName('Standard');
  await expect(page.getByRole('group', { name: 'System options' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Modules' })).toHaveCount(0);
  await modes.first().check();

  // An empty name cannot be submitted.
  await page.getByRole('button', { name: 'Create campaign' }).click();
  expect(
    seen.filter((request) => request.method === 'POST' && request.path === '/campaigns'),
  ).toHaveLength(0);

  // A failure persists nothing and is retryable without cleanup.
  await page.getByLabel('Campaign name').fill('Road Game');
  await page.getByRole('button', { name: 'Create campaign' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('No campaign yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Create campaign' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Road Game' })).toBeVisible();

  const posts = seen.filter(
    (request) => request.method === 'POST' && request.path === '/campaigns',
  );
  expect(posts).toHaveLength(2);
  const first = posts[0]?.body as Record<string, unknown>;
  const retry = posts[1]?.body as Record<string, unknown>;
  expect(first.system).toEqual(FIXTURE_REF);
  expect(first.gameMode).toBe('standard');
  // Neither request claims a role or actor: authority is the session.
  expect(Object.keys(first).sort()).toEqual(
    ['description', 'gameMode', 'id', 'moduleIds', 'name', 'options', 'system'].sort(),
  );
  expect(retry.name).toBe('Road Game');
});

test('abandoning the wizard persists nothing and keeps no draft', async ({ page }) => {
  const seen = await mockApi(page, ({ path, method }) => {
    if (path === '/auth/sessions' && method === 'POST') return loginResponse;
    if (path === '/systems') return json([summary]);
    if (path === '/campaigns' && method === 'GET') return json([]);
    return undefined;
  });
  await logIn(page);
  await page.getByRole('radio', { name: /Fixture System/ }).check();
  await page.getByLabel('Campaign name').fill('Never saved');
  await page.reload();
  // Still signed in on this device, with a fresh wizard.
  await expect(page.getByRole('heading', { name: 'Create campaign' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Fixture System/ })).not.toBeChecked();
  expect(
    seen.filter((request) => request.method === 'POST' && request.path === '/campaigns'),
  ).toHaveLength(0);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain('Never saved');
});

test('a player sees no owner controls and a non-member sees no campaign data', async ({ page }) => {
  let role = 'player';
  await mockApi(page, ({ path, method }) => {
    if (path === '/auth/sessions' && method === 'POST') return loginResponse;
    if (path === '/systems') return json([summary]);
    if (path === '/campaigns' && method === 'GET') return json([campaign()]);
    if (path === `/campaigns/${campaignId}/members`) {
      return role === 'none'
        ? json({ code: 'not_found_or_forbidden', message: 'Not found.' }, 404)
        : json({ items: [membership(role)] });
    }
    if (path === `/campaigns/${campaignId}/invitations`) return json([]);
    return undefined;
  });
  await logIn(page);
  await expect(page.getByText('table_user — player')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete campaign' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save details' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'System version' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create invitation' })).toHaveCount(0);

  // A non-member's read is denied with no member or invitation detail on screen.
  role = 'none';
  await page.reload();
  await expect(page.getByRole('alert')).toHaveText('Campaign administration unavailable.');
  await expect(page.getByText('table_user — ')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete campaign' })).toHaveCount(0);
});

test('system version update is explicit; keep current and a conflict change nothing', async ({
  page,
}) => {
  let pin = FIXTURE_REF;
  let conflict = true;
  const updateBodies: unknown[] = [];
  const seen = await mockApi(page, ({ path, method, body }) => {
    if (path === '/auth/sessions' && method === 'POST') return loginResponse;
    if (path === '/systems') return json([summary]);
    if (path === '/campaigns' && method === 'GET') return json([campaign({ system: pin })]);
    if (path === `/campaigns/${campaignId}/members`) return json({ items: [membership('owner')] });
    if (path === `/campaigns/${campaignId}/invitations`) return json([]);
    if (path === `/campaigns/${campaignId}/system-update` && method === 'GET') {
      return json({ current: pin, target: NEWER_REF });
    }
    if (path === `/campaigns/${campaignId}/system-update` && method === 'POST') {
      if (conflict) {
        conflict = false;
        return json({ code: 'version_conflict', message: 'Version conflict.' }, 409);
      }
      updateBodies.push(body);
      pin = NEWER_REF;
      return json(campaign({ system: pin, version: 2 }));
    }
    return undefined;
  });
  await logIn(page);
  await expect(
    page.getByText(/Current pin: fixture-system@0\.1\.0\. Updates are never automatic/),
  ).toBeVisible();

  // Opening the campaign and choosing keep current never writes.
  await page.getByRole('button', { name: 'Keep current' }).click();
  expect(
    seen.filter((request) => request.path.endsWith('/system-update') && request.method === 'POST'),
  ).toHaveLength(0);

  // A stale submit is a conflict and the pin is unchanged.
  await page.getByRole('button', { name: 'Review and update to latest installed version' }).click();
  await expect(page.getByRole('alert')).toHaveText('Update failed.');
  await expect(page.getByText(/Current pin: fixture-system@0\.1\.0/)).toBeVisible();

  // The explicit choice applies exactly the reviewed target.
  await page.getByRole('button', { name: 'Review and update to latest installed version' }).click();
  await expect(page.getByText(/Current pin: fixture-system@0\.2\.0/)).toBeVisible();
  expect(updateBodies).toEqual([{ targetVersion: '0.2.0', expectedVersion: 1 }]);
  expect(
    seen.filter((request) => request.path.endsWith('/system-update') && request.method === 'POST'),
  ).toHaveLength(2);
});

test('deleting a campaign removes it from the list; a failed delete leaves it', async ({
  page,
}) => {
  let failDelete = true;
  let deleteBody: unknown;
  await mockApi(page, ({ path, method, body }) => {
    if (path === '/auth/sessions' && method === 'POST') return loginResponse;
    if (path === '/systems') return json([summary]);
    if (path === '/campaigns' && method === 'GET') return json([campaign()]);
    if (path === `/campaigns/${campaignId}/members`) return json({ items: [membership('owner')] });
    if (path === `/campaigns/${campaignId}/invitations`) return json([]);
    if (path === `/campaigns/${campaignId}` && method === 'DELETE') {
      if (failDelete) {
        failDelete = false;
        return json({ code: 'not_found_or_forbidden', message: 'Not found.' }, 404);
      }
      deleteBody = body;
      return { status: 204, contentType: 'application/json', body: '' };
    }
    return undefined;
  });
  await logIn(page);
  await page.getByRole('button', { name: 'Delete campaign' }).click();
  await expect(page.getByRole('alert')).toHaveText('Delete failed.');
  await expect(page.getByRole('listitem').filter({ hasText: 'Road Game' })).toBeVisible();

  await page.getByRole('button', { name: 'Delete campaign' }).click();
  await expect(page.getByText('No campaign yet.')).toBeVisible();
  expect(deleteBody).toEqual({ expectedVersion: 1 });
});
