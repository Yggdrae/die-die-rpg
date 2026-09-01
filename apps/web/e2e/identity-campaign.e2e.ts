import { expect, type Page, test } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000101';
const invitationToken = 'i'.repeat(43);

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function mockApi(
  page: Page,
  handler: (path: string, method: string, body: unknown) => ReturnType<typeof json> | undefined,
) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON?.() as unknown;
    const response = handler(url.pathname, request.method(), body);
    if (response === undefined) await route.continue();
    else await route.fulfill(response);
  });
}

test('signup creates, invites, and deletes a manifest-driven campaign', async ({ page }) => {
  let campaignId = '';
  let createdInvitationRole = '';
  await mockApi(page, (path, method, body) => {
    if (path === '/auth/accounts' && method === 'POST') {
      return json({
        user: { id: userId, username: 'owner_user' },
        session: { expiresAt: '2026-09-01T00:00:00Z' },
      });
    }
    if (path === '/systems' && method === 'GET') {
      return json([
        {
          ref: { systemId: 'fixture-system', version: '0.1.0' },
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
        },
      ]);
    }
    if (path === '/campaigns' && method === 'GET') return json([]);
    if (path === '/campaigns' && method === 'POST') {
      const input = body as {
        id: string;
        name: string;
        description: string;
        system: { systemId: string; version: string };
        gameMode: string;
        moduleIds: string[];
        options: Record<string, unknown>;
      };
      campaignId = input.id;
      return json({
        id: input.id,
        name: input.name,
        description: input.description,
        system: input.system,
        gameMode: input.gameMode,
        modulePins: [],
        settings: { system: input.options },
        version: 1,
        createdAt: '2026-08-30T00:00:00Z',
        updatedAt: '2026-08-30T00:00:00Z',
      });
    }
    if (path === `/campaigns/${campaignId}/members` && method === 'GET') {
      return json({
        items: [
          {
            campaignId,
            user: { id: userId, username: 'owner_user' },
            role: 'owner',
            version: 1,
            joinedAt: '2026-08-30T00:00:00Z',
          },
        ],
      });
    }
    if (path === `/campaigns/${campaignId}/invitations` && method === 'GET') return json([]);
    if (path === `/campaigns/${campaignId}/invitations` && method === 'POST') {
      createdInvitationRole = (body as { targetRole: string }).targetRole;
      return json({
        invitation: {
          id: '00000000-0000-4000-8000-000000000201',
          campaignId,
          targetRole: createdInvitationRole,
          state: 'usable',
          expiresAt: '2026-09-01T00:00:00Z',
          createdAt: '2026-08-30T00:00:00Z',
        },
        token: invitationToken,
      });
    }
    if (path === `/campaigns/${campaignId}` && method === 'DELETE') {
      return json(undefined, 204);
    }
    return undefined;
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Username').fill('owner_user');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.locator('form').getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: /Fixture System/ }).check();
  await page.getByRole('radio', { name: 'Standard' }).check();
  await page.getByLabel('Campaign name').fill('Road Game');
  await page.getByLabel('Optional first invitation').selectOption('player');
  await page.getByRole('button', { name: 'Create campaign' }).click();

  await expect(page.getByText('Road Game')).toBeVisible();
  expect(createdInvitationRole).toBe('player');
  await page.getByRole('button', { name: 'Create invitation' }).click();
  await expect(page.getByText(invitationToken)).toBeVisible();
  await expect(page.getByText(/Updates are never automatic/)).toBeVisible();
  await page.getByRole('button', { name: 'Delete campaign' }).click();
  await expect(page.getByText('No campaign yet.')).toBeVisible();
});

test('logged-out invitation survives login and lands in the campaign', async ({ page }) => {
  const campaignId = '00000000-0000-4000-8000-000000000301';
  await mockApi(page, (path, method) => {
    if (path === `/invitations/${invitationToken}` && method === 'GET') {
      return json({
        campaignDisplayName: 'Invited Game',
        targetRole: 'player',
        expiresAt: '2026-09-01T00:00:00Z',
      });
    }
    if (path === '/auth/sessions' && method === 'POST') {
      return json({
        user: { id: userId, username: 'player_user' },
        session: { expiresAt: '2026-09-01T00:00:00Z' },
      });
    }
    if (path === `/invitations/${invitationToken}/accept` && method === 'POST') {
      return json({
        campaignId,
        user: { id: userId, username: 'player_user' },
        role: 'player',
        version: 1,
        joinedAt: '2026-08-30T00:00:00Z',
      });
    }
    if (path === '/campaigns' && method === 'GET') return json([]);
    if (path === '/systems' && method === 'GET') return json([]);
    return undefined;
  });

  await page.goto(`/invite/${invitationToken}`);
  await expect(page.getByText(/Join/)).toContainText('Invited Game');
  await page.getByLabel('Username').fill('player_user');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByText(`Joined campaign ${campaignId}.`)).toBeVisible();
});

test('generic authentication failure exposes only its stable code', async ({ page }) => {
  await mockApi(page, (path, method) => {
    if (path === '/auth/sessions' && method === 'POST') {
      return json({ code: 'invalid_credentials', message: 'Invalid credentials.' }, 401);
    }
    return undefined;
  });

  await page.goto('/');
  await page.getByLabel('Username').fill('missing_user');
  await page.getByLabel('Password').fill('incorrect password value');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toHaveText('invalid_credentials');
});
