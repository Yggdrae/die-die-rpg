import { expect, type Page, test } from '@playwright/test';

/**
 * Feature 06 task 05. The page is the production `AuditLog` mounted by a test-only host
 * (`features/audit/e2e-harness.tsx`). The API is a route mock with the wire contract of the task 03
 * routes: it already decides what the requesting user may read (rows, totals, cursors) and answers
 * the safe 404 to a non-GM on the private route. That server behavior itself is proved against
 * Fastify and PostgreSQL in `apps/api/src/modules/audit/routes.integration.test.ts`; the browser
 * replica's store separation is proved against PowerSync in `live-sync.e2e.ts`.
 */

const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
const GM = '00000000-0000-4000-8000-0000000000b1';
const CASEY = '00000000-0000-4000-8000-0000000000c1';
const members = [
  { id: GM, username: 'gm_ana' },
  { id: CASEY, username: 'casey' },
];

interface Entry {
  id: string;
  actor: string;
  role: string;
  acceptedAt: string;
  text: string;
  /** Who the stand-in authority lets read it. */
  readers: 'all' | 'gm';
  action?: string;
}

const campaignEntries: Entry[] = [
  {
    id: '00000000-0000-4000-8000-000000000e05',
    actor: GM,
    role: 'gm',
    acceptedAt: '2026-10-26T14:35:00Z',
    text: 'Changed the party resource torches from 6 to 2.',
    readers: 'all',
    action: 'campaign.setting_changed',
  },
  {
    id: '00000000-0000-4000-8000-000000000e04',
    actor: GM,
    role: 'gm',
    acceptedAt: '2026-10-26T14:20:00Z',
    text: 'Revealed the Weathered Letter to casey.',
    readers: 'gm',
  },
  {
    id: '00000000-0000-4000-8000-000000000e03',
    actor: CASEY,
    role: 'player',
    acceptedAt: '2026-10-26T14:00:00Z',
    text: 'Renamed the campaign from Draft to Ashen Road.',
    readers: 'all',
    action: 'campaign.details_updated',
  },
];
const privateEntries: Entry[] = [
  {
    id: '00000000-0000-4000-8000-000000000f01',
    actor: GM,
    role: 'gm',
    acceptedAt: '2026-10-26T14:10:00Z',
    text: 'Secretly adjusted the ambush roll.',
    readers: 'gm',
  },
];

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/** Stateful stand-in for the authority: decides by the server-known role, never the client's. */
async function mockApi(page: Page, input: { serverRole: 'gm' | 'player'; pageSize?: number }) {
  const state = { requests: [] as string[], invalidateCursor: false };
  await page.route('**/campaigns/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.includes('/audit')) return route.fallback();
    state.requests.push(`${url.pathname}${url.search}`);
    const isPrivate = url.pathname.endsWith('/audit/private');
    if (isPrivate && input.serverRole !== 'gm') {
      return route.fulfill(json({ code: 'not_found', message: 'Not found.' }, 404));
    }
    const actorId = url.searchParams.get('actorId');
    const readable = (isPrivate ? privateEntries : campaignEntries).filter(
      (entry) =>
        (entry.readers === 'all' || input.serverRole === 'gm') &&
        (actorId === null || entry.actor === actorId),
    );
    const cursor = url.searchParams.get('cursor');
    if (
      cursor !== null &&
      (state.invalidateCursor || !readable.some((entry) => entry.id === cursor))
    ) {
      return route.fulfill(
        json(
          {
            code: 'validation_failed',
            message: 'Request rejected.',
            details: { reason: 'invalid_cursor' },
          },
          400,
        ),
      );
    }
    const start = cursor === null ? 0 : readable.findIndex((entry) => entry.id === cursor) + 1;
    const size = input.pageSize ?? 50;
    const items = readable.slice(start, start + size);
    const last = items.at(-1);
    return route.fulfill(
      json({
        items: items.map((entry) => ({
          id: entry.id,
          sessionId: null,
          actor: { userId: entry.actor, role: entry.role },
          action: entry.action ?? 'probe.changed',
          target: { type: 'campaign', id: CAMPAIGN },
          acceptedAt: entry.acceptedAt,
          description: { kind: 'registered', text: entry.text },
        })),
        total: readable.length,
        ...(start + size < readable.length && last !== undefined ? { nextCursor: last.id } : {}),
      }),
    );
  });
  return state;
}

async function mount(
  page: Page,
  options: {
    viewerRole?: string;
    online?: boolean;
    local?: { campaign?: unknown; private?: unknown };
  },
): Promise<void> {
  await page.goto('/');
  await page.evaluate(
    async (input) => {
      const harness = await import('/src/features/audit/e2e-harness.tsx');
      harness.mountAuditHarness(input as Parameters<typeof harness.mountAuditHarness>[0]);
    },
    {
      campaignId: CAMPAIGN,
      members,
      online: options.online ?? true,
      ...(options.viewerRole === undefined ? {} : { viewerRole: options.viewerRole }),
      ...(options.local === undefined ? {} : { local: options.local }),
    },
  );
}

const entries = (page: Page) => page.locator('[data-testid="audit-entries"] > li');

test('a GM explains a resource change from the log: actor, time, before and after', async ({
  page,
}) => {
  await mockApi(page, { serverRole: 'gm' });
  await mount(page, { viewerRole: 'gm' });
  const change = entries(page).filter({ hasText: 'torches' });
  await expect(change).toHaveText(
    '2026-10-26 14:35:00 gm_ana Changed the party resource torches from 6 to 2.',
  );
  await expect(entries(page)).toHaveCount(3);
  await expect(page.getByTestId('audit-total')).toHaveText('3 events');
  // Newest first by authority order.
  await expect(entries(page).first()).toContainText('torches');
  // The GM's private log is a separate view of a separate store.
  await page.getByRole('tab', { name: 'GM-private log' }).click();
  await expect(entries(page)).toHaveText([
    '2026-10-26 14:10:00 gm_ana Secretly adjusted the ambush roll.',
  ]);
});

test('a player sees no private view, no hidden row, and a total of visible events only', async ({
  page,
}) => {
  const api = await mockApi(page, { serverRole: 'player' });
  await mount(page, { viewerRole: 'player' });
  await expect(entries(page)).toHaveCount(2);
  await expect(page.getByTestId('audit-total')).toHaveText('2 events');
  await expect(page.getByRole('tab', { name: 'GM-private log' })).toHaveCount(0);
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('Weathered Letter');
  expect(text).not.toContain('ambush');
  expect(api.requests.some((request) => request.includes('/audit/private'))).toBe(false);
  // The player's device has no private store either: nothing local was asked for it.
  const reads = await page.evaluate(
    () => (globalThis as { auditLocalReads?: { store: string }[] }).auditLocalReads ?? [],
  );
  expect(reads.every((read) => read.store === 'campaign')).toBe(true);
});

test('a client that claims a GM role still gets nothing from the private log', async ({ page }) => {
  // The UI hint is fooled; the server decides by the role it resolves itself.
  await mockApi(page, { serverRole: 'player' });
  await mount(page, { viewerRole: 'gm' });
  await page.getByRole('tab', { name: 'GM-private log' }).click();
  await expect(page.getByTestId('audit-unavailable')).toBeVisible();
  await expect(entries(page)).toHaveCount(0);
  await expect(page.getByTestId('audit-total')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain('ambush');
});

test('offline, pending entries stand apart from accepted history and partial history is stated', async ({
  page,
}) => {
  const api = await mockApi(page, { serverRole: 'gm' });
  await mount(page, {
    viewerRole: 'gm',
    online: false,
    local: {
      campaign: {
        entries: [
          {
            id: '00000000-0000-4000-8000-0000000000d2',
            state: 'pending',
            campaignId: CAMPAIGN,
            sessionId: null,
            actor: { userId: GM, role: 'gm' },
            action: 'campaign.details_updated',
            target: { type: 'campaign', id: CAMPAIGN },
            at: '2026-10-26T15:00:00Z',
            before: { name: 'Ashen Road' },
            after: { name: 'Ember Road' },
            rendererVersion: 0,
          },
          {
            id: campaignEntries[0]?.id,
            state: 'accepted',
            campaignId: CAMPAIGN,
            sessionId: null,
            actor: { userId: GM, role: 'gm' },
            action: 'campaign.setting_changed',
            target: { type: 'campaign', id: CAMPAIGN },
            at: '2026-10-26T14:35:00Z',
            rendererVersion: 1,
          },
        ],
        partial: true,
        pendingCount: 1,
      },
    },
  });
  await expect(page.getByTestId('audit-offline')).toBeVisible();
  await expect(page.getByTestId('audit-partial')).toBeVisible();
  await expect(entries(page)).toHaveCount(2);
  const pending = entries(page).first();
  await expect(pending).toHaveAttribute('data-audit-state', 'pending');
  await expect(pending).toContainText('Pending — not yet accepted');
  await expect(entries(page).nth(1)).toHaveAttribute('data-audit-state', 'accepted');
  await expect(entries(page).nth(1)).not.toContainText('Pending');
  // No authority total is claimed for a partial local log, and raw values are never shown.
  await expect(page.getByTestId('audit-total')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain('Ember Road');
  expect(api.requests).toEqual([]);
});

test('online, a device entry stays labeled pending above the authority history', async ({
  page,
}) => {
  await mockApi(page, { serverRole: 'gm' });
  await mount(page, {
    viewerRole: 'gm',
    local: {
      campaign: {
        entries: [
          {
            id: '00000000-0000-4000-8000-0000000000d3',
            state: 'pending',
            campaignId: CAMPAIGN,
            sessionId: null,
            actor: { userId: CASEY, role: 'player' },
            action: 'campaign.details_updated',
            target: { type: 'campaign', id: CAMPAIGN },
            at: '2026-10-26T15:10:00Z',
            rendererVersion: 0,
          },
        ],
        partial: false,
        pendingCount: 1,
      },
    },
  });
  await expect(entries(page)).toHaveCount(4);
  await expect(entries(page).first()).toHaveAttribute('data-audit-source', 'device');
  await expect(entries(page).first()).toContainText('casey');
  await expect(entries(page).first()).toContainText('Pending — not yet accepted');
  // The authority total counts accepted events only.
  await expect(page.getByTestId('audit-total')).toHaveText('3 events');
});

test('older pages load by cursor; a cursor that became invalid restarts from the newest', async ({
  page,
}) => {
  const api = await mockApi(page, { serverRole: 'gm', pageSize: 2 });
  await mount(page, { viewerRole: 'gm' });
  await expect(entries(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Load older entries' }).click();
  await expect(entries(page)).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Load older entries' })).toHaveCount(0);
  expect(api.requests.at(-1)).toContain(`cursor=${campaignEntries[1]?.id}`);

  await mount(page, { viewerRole: 'gm' });
  await expect(entries(page)).toHaveCount(2);
  api.invalidateCursor = true;
  await page.getByRole('button', { name: 'Load older entries' }).click();
  await expect(page.getByRole('status')).toContainText('showing the newest entries again');
  await expect(entries(page)).toHaveCount(2);
  await expect(entries(page).first()).toContainText('torches');
});

test('the actor filter narrows the request; it never widens what is shown', async ({ page }) => {
  const api = await mockApi(page, { serverRole: 'player' });
  await mount(page, { viewerRole: 'player' });
  await expect(entries(page)).toHaveCount(2);
  await page.getByLabel('Actor').selectOption({ label: 'gm_ana' });
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(entries(page)).toHaveCount(1);
  await expect(entries(page).first()).toContainText('torches');
  await expect(page.getByTestId('audit-total')).toHaveText('1 event');
  expect(api.requests.at(-1)).toContain(`actorId=${GM}`);
});
