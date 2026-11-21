import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';

/**
 * Feature 20 on the real stack (`PRD.md` s.45, s.68, s.76, s.88): the production search over the browser replica
 * (test-only host `features/search/e2e-harness.tsx`, composed like the app shell), the running PowerSync service, and
 * the real API composition root (`fixtures/encounters-api-server.ts`: a GM and a player in one campaign). A GM finds a
 * GM-only NPC in under 5 seconds and opens it; the player never finds it (count 0) but finds what everyone may see; a
 * location synchronized from the GM appears on the player's open search; the palette searches through feature 20; and
 * search works offline.
 *
 * Skipped unless PostgreSQL and the PowerSync service are reachable.
 */

const HELPER = 'apps/web/e2e/fixtures/encounters-api-server.ts';
const APP = 'http://127.0.0.1:4173';
const PORT = 4195;
const API = `http://127.0.0.1:${PORT}`;
const API_ORIGIN = 'https://table.invalid';
const ENDPOINT = process.env.POWERSYNC_ENDPOINT ?? 'http://localhost:8080';
const SYNC = Number(process.env.E2E_SYNC_TIMEOUT_MS ?? 30_000);
const FIND_BUDGET_MS = 5_000;

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

interface User {
  readonly cookie: string;
  readonly userId: string;
  readonly username: string;
}
interface Fixture {
  readonly campaignId: string;
  readonly gm: User;
  readonly casey: User;
}
interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
  network: { down: boolean };
}

let server: ChildProcess | undefined;
let fixture: Fixture | undefined;

test.beforeAll(async () => {
  test.setTimeout(90_000);
  if ((process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL) === undefined) return;
  try {
    const probe = await fetch(`${ENDPOINT}/probes/liveness`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!probe.ok) return;
  } catch {
    return;
  }
  const child = spawn('bun', [HELPER, 'serve', String(PORT)], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  fixture = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 60_000);
    let buffered = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const line = buffered.split('\n').find((entry) => entry.includes('"ready"'));
      if (line === undefined) return;
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
});

test.afterAll(() => {
  server?.kill();
  if (fixture !== undefined) {
    execFileSync('bun', [HELPER, 'cleanup', fixture.campaignId], { env: process.env });
  }
});

function harness<T>(page: Page, name: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    async (input) => {
      const module = (await import('/src/features/search/e2e-harness.tsx')) as unknown as Record<
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

async function device(browser: Browser, user: User): Promise<Device> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const network = { down: false };
  await context.route(`${ENDPOINT}/**`, (route) =>
    network.down ? route.abort('internetdisconnected') : route.continue(),
  );
  const relay = async (route: Parameters<Parameters<BrowserContext['route']>[1]>[0]) => {
    if (network.down) return route.abort('internetdisconnected');
    const request = route.request();
    try {
      const response = await route.fetch({
        url: request.url().replace(APP, API),
        headers: { ...request.headers(), origin: API_ORIGIN, cookie: user.cookie },
      });
      await route.fulfill({ response });
    } catch {
      await route.abort('failed').catch(() => undefined);
    }
  };
  await context.route(`${APP}/campaigns/**`, relay);
  await context.route(`${APP}/sync/**`, relay);
  const page = await context.newPage();
  await page.goto('/');
  await page.evaluate(
    async (input) => {
      const module = await import('/src/features/search/e2e-harness.tsx');
      module.mountSearch(input);
    },
    { userId: user.userId, campaignId: fixture?.campaignId ?? '' },
  );
  await expect(page.locator('[data-search-ready="true"]')).toBeVisible({ timeout: SYNC });
  return { context, page, network };
}

async function settled(target: Device): Promise<void> {
  await expect.poll(() => harness<number>(target.page, 'pendingCount'), { timeout: SYNC }).toBe(0);
}

const box = (page: Page) =>
  page.getByRole('region', { name: 'Campaign search' }).getByRole('searchbox', {
    name: 'Search campaign',
  });
const results = (page: Page): Locator =>
  page
    .getByRole('region', { name: 'Campaign search' })
    .getByRole('list', { name: 'Search results' });
const count = (page: Page) => page.getByTestId('search-count');

test('a GM finds a GM-only NPC in under 5 seconds; the player finds only what they may see (PRD s.88)', async ({
  browser,
}) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(180_000);
  const current = fixture as Fixture;
  const gm = await device(browser, current.gm);
  const casey = await device(browser, current.casey);
  try {
    await harness(gm.page, 'createEntity', {
      type: 'npc',
      name: 'Mirela Voss',
      summary: 'Herbalist who watches the ford.',
    });
    await harness(gm.page, 'createEntity', {
      type: 'location',
      name: 'Wareham Ford',
      everyone: true,
    });
    await settled(gm);

    // FR-007: three letters of a name, the NPC first, labelled with its type, in under 5 seconds.
    const begun = Date.now();
    await box(gm.page).fill('mir');
    const first = results(gm.page).getByRole('listitem').first();
    await expect(first.getByRole('link', { name: 'Mirela Voss' })).toBeVisible();
    const elapsed = Date.now() - begun;
    console.info(`search: "mir" -> Mirela Voss in ${elapsed} ms`);
    expect(elapsed).toBeLessThan(FIND_BUDGET_MS);
    await expect(first).toContainText('NPC');
    await expect(count(gm.page)).toHaveText('1 result');
    // A body match carries its own snippet; "ford" ranks the title match first.
    await box(gm.page).fill('ford');
    await expect(results(gm.page).getByRole('listitem').first()).toContainText('Wareham Ford');
    await expect(results(gm.page)).toContainText('Herbalist who watches the ford.');

    // FR-006: a result opens the owning view.
    await box(gm.page).fill('mir');
    await first.getByRole('link', { name: 'Mirela Voss' }).click();
    await expect(
      gm.page
        .getByRole('region', { name: 'Campaign content' })
        .getByRole('article', { name: 'Mirela Voss details' }),
    ).toBeVisible();

    // FR-004: the player's search finds what everyone may see and never the GM-only NPC.
    await box(casey.page).fill('ware');
    await expect(results(casey.page).getByRole('link', { name: 'Wareham Ford' })).toBeVisible({
      timeout: SYNC,
    });
    await box(casey.page).fill('mir');
    await expect(count(casey.page)).toHaveText('0 results');
    await expect(results(casey.page).getByRole('listitem')).toHaveCount(0);
    await box(casey.page).fill('herbalist');
    await expect(count(casey.page)).toHaveText('0 results');

    // FR-005: a location the GM creates reaches the player's open search with no reload.
    await box(casey.page).fill('old mi');
    await expect(count(casey.page)).toHaveText('0 results');
    await harness(gm.page, 'createEntity', { type: 'location', name: 'Old Mill', everyone: true });
    await settled(gm);
    await expect(results(casey.page).getByRole('link', { name: 'Old Mill' })).toBeVisible({
      timeout: SYNC,
    });

    // The player's own character is searchable and opens its sheet.
    await harness(casey.page, 'createCharacter', 'Bryn Ashdown');
    await box(casey.page).fill('bryn');
    const bryn = results(casey.page).getByRole('link', { name: 'Bryn Ashdown' });
    await expect(bryn).toBeVisible({ timeout: SYNC });
    await expect(results(casey.page)).toContainText('Character');
    await bryn.click();
    await expect(casey.page.getByRole('article', { name: 'Sheet of Bryn Ashdown' })).toBeVisible();
    await settled(casey);

    // FR-008: the palette searches through feature 20; a held entity opens the lookup panel.
    const mode = gm.page.getByRole('region', { name: 'Session Mode' });
    const start = mode.getByRole('button', { name: /^Start session \d+$/ });
    await expect(start).toBeVisible({ timeout: SYNC });
    await start.click();
    await expect(mode.getByRole('button', { name: 'End session' })).toBeVisible({ timeout: SYNC });
    await gm.page.keyboard.press('Control+K');
    const palette = gm.page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByRole('textbox', { name: 'Command' }).fill('ware');
    const option = palette.getByRole('button', { name: 'Wareham Ford' });
    await expect(option).toBeVisible();
    await expect(palette.getByRole('list', { name: 'Results' })).toContainText('Location');
    await option.click();
    await expect(palette).toHaveCount(0);
    await expect(mode.getByRole('region', { name: 'Lookup' })).toContainText('Wareham Ford');
    await mode.getByRole('button', { name: 'End session' }).click();
    await mode.getByRole('button', { name: /^Confirm end of Session \d+$/ }).click();
    await settled(gm);
  } finally {
    await gm.context.close();
    await casey.context.close();
  }
});

test('search works offline: an NPC created with no connection is found at once (PRD s.76)', async ({
  browser,
}) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(120_000);
  const current = fixture as Fixture;
  const gm = await device(browser, current.gm);
  try {
    // The replica from the first test is on this device's fresh replica once synchronized.
    await box(gm.page).fill('ware');
    await expect(results(gm.page).getByRole('link', { name: 'Wareham Ford' })).toBeVisible({
      timeout: SYNC,
    });
    gm.network.down = true;
    await harness(gm.page, 'pauseSync');
    await harness(gm.page, 'createEntity', { type: 'npc', name: 'Tobin Reed' });
    await box(gm.page).fill('tob');
    await expect(results(gm.page).getByRole('link', { name: 'Tobin Reed' })).toBeVisible();
    // Synchronized content stays findable offline, as online.
    await box(gm.page).fill('ware');
    await expect(results(gm.page).getByRole('link', { name: 'Wareham Ford' })).toBeVisible();
    expect(await harness<number>(gm.page, 'pendingCount')).toBeGreaterThan(0);
    gm.network.down = false;
    await harness(gm.page, 'resumeSync');
    await settled(gm);
    await box(gm.page).fill('tob');
    await expect(results(gm.page).getByRole('link', { name: 'Tobin Reed' })).toBeVisible();
  } finally {
    await gm.context.close();
  }
});
