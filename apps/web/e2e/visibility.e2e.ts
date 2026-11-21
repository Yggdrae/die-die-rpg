import { expect, type Page, test } from '@playwright/test';

/**
 * Feature 04 task 06. The page is the generic Visibility controls mounted by a test-only host
 * (`features/visibility/e2e-harness.tsx`); the API is a route mock that mimics the real contract
 * of `PATCH /campaigns/:campaignId/resources/:class/:resourceId/visibility`. The real route's
 * behavior (player B gets nothing, direct PATCH by a player is rejected) is proved against the
 * Fastify app in `apps/api/src/modules/authorization/*.test.ts`.
 */

const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
const RECORD = '00000000-0000-4000-8000-000000001001';
const CLASS = 'fixture_note';
const GM = '00000000-0000-4000-8000-0000000000b1';
const CASEY = '00000000-0000-4000-8000-0000000000c1';
const ROWAN = '00000000-0000-4000-8000-0000000000d1';

type Mode =
  | { mode: 'gm_only' }
  | { mode: 'everyone' }
  | { mode: 'players'; playerIds: string[] }
  | { mode: 'party'; partyIds: string[] };

interface MockOptions {
  visibility?: Mode;
  version?: number;
  members?: { id: string; username: string; role: string }[];
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/** Stateful stand-in for the API: same wire contract, same normalization, no authorization. */
async function mockApi(page: Page, options: MockOptions = {}) {
  const state = {
    visibility: options.visibility ?? ({ mode: 'gm_only' } as Mode),
    version: options.version ?? 1,
    members: options.members ?? [
      { id: GM, username: 'gm_user', role: 'gm' },
      { id: CASEY, username: 'casey', role: 'player' },
      { id: ROWAN, username: 'rowan', role: 'player' },
    ],
    requests: [] as unknown[],
    memberReads: 0,
  };
  await page.route('**/campaigns/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `/campaigns/${CAMPAIGN}/members` && request.method() === 'GET') {
      state.memberReads += 1;
      return route.fulfill(
        json({
          items: state.members.map((member) => ({
            campaignId: CAMPAIGN,
            user: { id: member.id, username: member.username },
            role: member.role,
            version: 1,
            updatedAt: '2026-10-25T00:00:00Z',
          })),
        }),
      );
    }
    if (path === `/campaigns/${CAMPAIGN}/resources/${CLASS}/${RECORD}`) {
      return route.fulfill(json({ visibility: state.visibility, version: state.version }));
    }
    if (
      path === `/campaigns/${CAMPAIGN}/resources/${CLASS}/${RECORD}/visibility` &&
      request.method() === 'PATCH'
    ) {
      const body = request.postDataJSON() as {
        operation: 'reveal' | 'unreveal';
        target: { mode: string; playerIds?: string[] };
        expectedVersion: number;
      };
      state.requests.push(body);
      if (body.expectedVersion !== state.version) {
        return route.fulfill(json({ code: 'version_conflict', message: 'Version conflict.' }, 409));
      }
      const current = state.visibility;
      let next: Mode = current;
      if (body.target.mode === 'everyone') {
        next = body.operation === 'reveal' ? { mode: 'everyone' } : { mode: 'gm_only' };
      } else {
        const ids = body.target.playerIds ?? [];
        if (
          body.operation === 'reveal' &&
          ids.some((id) => !state.members.some((member) => member.id === id))
        ) {
          return route.fulfill(
            json(
              {
                code: 'validation_failed',
                message: 'Request rejected.',
                details: { reason: 'target_not_member' },
              },
              400,
            ),
          );
        }
        const existing = current.mode === 'players' ? current.playerIds : [];
        if (body.operation === 'reveal') {
          if (current.mode !== 'everyone') {
            next = { mode: 'players', playerIds: [...new Set([...existing, ...ids])].sort() };
          }
        } else if (current.mode === 'players') {
          const left = existing.filter((id) => !ids.includes(id));
          next = left.length === 0 ? { mode: 'gm_only' } : { mode: 'players', playerIds: left };
        }
      }
      const changed = JSON.stringify(next) !== JSON.stringify(current);
      if (changed) {
        state.visibility = next;
        state.version += 1;
      }
      return route.fulfill(
        json({
          resourceClass: CLASS,
          resourceId: RECORD,
          visibility: state.visibility,
          version: state.version,
          changed,
        }),
      );
    }
    return route.continue();
  });
  return state;
}

async function mount(page: Page, viewerRole: string, state: { visibility: Mode; version: number }) {
  await page.goto('/');
  await page.evaluate(
    async (options) => {
      const harness = await import('/src/features/visibility/e2e-harness.tsx');
      harness.mountVisibilityHarness(options);
    },
    {
      campaignId: CAMPAIGN,
      resourceClass: CLASS,
      resourceId: RECORD,
      viewerRole,
      visibility: state.visibility,
      version: state.version,
    },
  );
}

const current = (page: Page) => page.getByTestId('visibility-current');

test.use({ serviceWorkers: 'block' });

test('targeted reveal, additive repeat, duplicate no-op and removal back to GM only', async ({
  page,
}) => {
  const state = await mockApi(page);
  await mount(page, 'gm', state);

  await expect(current(page)).toContainText('GM only');
  const picker = page.getByRole('group', { name: 'Reveal to players' });
  await expect(picker.getByLabel('casey')).toBeVisible();
  await expect(picker.getByLabel('rowan')).toBeVisible();
  await expect(picker.getByLabel('gm_user')).toHaveCount(0);

  // Targeted reveal to Casey only.
  await picker.getByLabel('casey').check();
  await page.getByRole('button', { name: 'Reveal to selected players' }).click();
  await expect(current(page)).toContainText('Selected players');
  await expect(page.getByRole('list', { name: 'Players who can see this' })).toContainText('casey');
  await expect(page.getByRole('list', { name: 'Players who can see this' })).not.toContainText(
    'rowan',
  );
  await expect(page.getByTestId('record-version')).toHaveText('version 2');
  expect(state.requests[0]).toEqual({
    operation: 'reveal',
    target: { mode: 'players', playerIds: [CASEY] },
    expectedVersion: 1,
  });

  // Additive: Rowan joins, Casey keeps access.
  await picker.getByLabel('rowan').check();
  await page.getByRole('button', { name: 'Reveal to selected players' }).click();
  const recipients = page.getByRole('list', { name: 'Players who can see this' });
  await expect(recipients).toContainText('casey');
  await expect(recipients).toContainText('rowan');
  await expect(page.getByTestId('record-version')).toHaveText('version 3');

  // Repeating a reveal changes nothing: no version bump, an explicit notice.
  await picker.getByLabel('casey').check();
  await page.getByRole('button', { name: 'Reveal to selected players' }).click();
  await expect(page.getByRole('status')).toContainText('Already revealed');
  await expect(page.getByTestId('record-version')).toHaveText('version 3');

  // Un-reveal one recipient, then the last one: stored as gm_only, never an empty grant.
  await expect(page.getByTestId('visibility-unreveal-note')).toContainText('keeps what they saw');
  await page.getByRole('button', { name: 'Remove casey' }).click();
  await expect(recipients).not.toContainText('casey');
  await expect(recipients).toContainText('rowan');
  await page.getByRole('button', { name: 'Remove rowan' }).click();
  await expect(current(page)).toContainText('GM only');
  await expect(page.getByRole('status')).toContainText('Hidden');
  expect(state.visibility).toEqual({ mode: 'gm_only' });
  await expect(page.getByRole('button', { name: 'Hide from everyone' })).toHaveCount(0);
  expect(JSON.stringify(state.requests)).not.toMatch(/role|actor|userId/i);
});

test('reveal to everyone then hide from everyone shows the prior-knowledge limitation', async ({
  page,
}) => {
  const state = await mockApi(page);
  await mount(page, 'owner', state);

  await page.getByRole('button', { name: 'Reveal to everyone' }).click();
  await expect(current(page)).toContainText('Everyone in the campaign');
  await expect(page.getByLabel('casey', { exact: true })).toBeDisabled();
  await expect(page.getByTestId('visibility-unreveal-note')).toContainText(
    'Anyone who already saw it keeps what they saw',
  );
  await expect(page.getByTestId('visibility-unreveal-note')).toContainText('copy or export');

  await page.getByRole('button', { name: 'Hide from everyone' }).click();
  await expect(current(page)).toContainText('GM only');
  expect(state.visibility).toEqual({ mode: 'gm_only' });
  expect(state.version).toBe(3);
});

test('a version conflict is shown, nothing is applied, and reload then retry resubmits', async ({
  page,
}) => {
  const state = await mockApi(page);
  await mount(page, 'gm', state);

  // Another GM changes the record after this page loaded it.
  state.visibility = { mode: 'players', playerIds: [ROWAN] };
  state.version = 4;

  await page.getByLabel('casey', { exact: true }).check();
  await page.getByRole('button', { name: 'Reveal to selected players' }).click();
  const conflict = page.getByTestId('visibility-conflict');
  await expect(conflict).toContainText('was not applied');
  expect(state.visibility).toEqual({ mode: 'players', playerIds: [ROWAN] });
  await expect(page.getByTestId('record-version')).toHaveText('version 1');
  await expect(page.getByRole('button', { name: 'Retry my change' })).toBeDisabled();

  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByTestId('record-version')).toHaveText('version 4');
  await expect(page.getByRole('list', { name: 'Players who can see this' })).toContainText('rowan');
  await page.getByRole('button', { name: 'Retry my change' }).click();

  const recipients = page.getByRole('list', { name: 'Players who can see this' });
  await expect(recipients).toContainText('casey');
  await expect(recipients).toContainText('rowan');
  await expect(page.getByTestId('record-version')).toHaveText('version 5');
  expect(state.requests.at(-1)).toMatchObject({ expectedVersion: 4 });
});

test('a member removed after the list loaded is refused and the picker refreshes', async ({
  page,
}) => {
  const state = await mockApi(page);
  await mount(page, 'gm', state);
  await expect(page.getByLabel('rowan', { exact: true })).toBeVisible();

  state.members = state.members.filter((member) => member.id !== ROWAN);
  await page.getByLabel('rowan', { exact: true }).check();
  await page.getByRole('button', { name: 'Reveal to selected players' }).click();

  await expect(page.getByRole('alert').first()).toContainText('no longer a member');
  await expect(page.getByLabel('rowan', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('casey', { exact: true })).toBeVisible();
  expect(state.visibility).toEqual({ mode: 'gm_only' });
  expect(state.memberReads).toBeGreaterThanOrEqual(2);
});

test('observers never appear as reveal targets', async ({ page }) => {
  const state = await mockApi(page, {
    members: [
      { id: GM, username: 'gm_user', role: 'gm' },
      { id: CASEY, username: 'casey', role: 'player' },
      { id: ROWAN, username: 'watcher', role: 'observer' },
    ],
  });
  await mount(page, 'gm', state);
  await expect(page.getByLabel('casey', { exact: true })).toBeVisible();
  await expect(page.getByLabel('watcher', { exact: true })).toHaveCount(0);
});

test('players get no controls at all', async ({ page }) => {
  const state = await mockApi(page);
  await mount(page, 'player', state);
  await expect(page.getByText('Who can see this')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  expect(state.requests).toHaveLength(0);
});

test('party visibility is read-only and offers no controls', async ({ page }) => {
  const state = await mockApi(page, { visibility: { mode: 'party', partyIds: [CASEY] } });
  await mount(page, 'gm', state);
  await expect(page.getByTestId('visibility-party-unavailable')).toContainText(
    'Party sharing is not available yet',
  );
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
});

test('a safe denial from the server is shown without saying whether the record exists', async ({
  page,
}) => {
  const state = await mockApi(page);
  await mount(page, 'gm', state);
  await page.route(`**/campaigns/${CAMPAIGN}/resources/${CLASS}/${RECORD}/visibility`, (route) =>
    route.fulfill(json({ code: 'not_found_or_forbidden', message: 'Not found.' }, 404)),
  );
  await page.getByRole('button', { name: 'Reveal to everyone' }).click();
  await expect(page.getByRole('alert')).toContainText('not available, or you cannot change');
  await expect(current(page)).toContainText('GM only');
});
