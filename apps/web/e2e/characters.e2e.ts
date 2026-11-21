import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

/**
 * Feature 15 on the real stack (`PRD.md` s.87 Test 2, s.88): the production character screens over the browser
 * replica (test-only host `features/characters/e2e-harness.tsx`), the running PowerSync service, and the real
 * API composition root (`fixtures/characters-api-server.ts`). A player creates a character, changes a resource
 * offline and sees it at once, and rolls from the sheet; the GM sees the character, another player never does.
 *
 * Skipped unless PostgreSQL and the PowerSync service are reachable.
 */

const HELPER = 'apps/web/e2e/fixtures/characters-api-server.ts';
const APP = 'http://127.0.0.1:4173';
const PORT = 4191;
const API = `http://127.0.0.1:${PORT}`;
const API_ORIGIN = 'https://table.invalid';
const ENDPOINT = process.env.POWERSYNC_ENDPOINT ?? 'http://localhost:8080';
const SYNC = Number(process.env.E2E_SYNC_TIMEOUT_MS ?? 30_000);
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

interface User {
  readonly cookie: string;
  readonly userId: string;
}
interface Fixture {
  readonly campaignId: string;
  readonly gm: User;
  readonly casey: User;
  readonly dana: User;
}
interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
  network: { down: boolean };
}

let server: ChildProcess | undefined;
let fixture: Fixture | undefined;
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 1 });

test.beforeAll(async () => {
  test.setTimeout(90_000);
  if (databaseUrl === undefined) return;
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

test.afterAll(async () => {
  server?.kill();
  if (fixture !== undefined) {
    execFileSync('bun', [HELPER, 'cleanup', fixture.campaignId], { env: process.env });
  }
  await sql?.end({ timeout: 1 });
});

function harness<T>(page: Page, name: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    async (input) => {
      const module = (await import(
        '/src/features/characters/e2e-harness.tsx'
      )) as unknown as Record<string, (value?: unknown) => unknown>;
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
      const module = await import('/src/features/characters/e2e-harness.tsx');
      module.mountCharacters(input);
    },
    { userId: user.userId, campaignId: fixture?.campaignId ?? '' },
  );
  await expect(page.getByRole('heading', { name: 'Characters' })).toBeVisible({ timeout: SYNC });
  return { context, page, network };
}

async function serverHp(name: string): Promise<number | undefined> {
  if (sql === undefined || fixture === undefined) return undefined;
  const [row] = await sql<{ current: number }[]>`
    select (state->'resources'->'hp'->>'current')::int as current from characters
    where campaign_id = ${fixture.campaignId} and state->'fields'->>'name' = ${name}`;
  return row?.current;
}

test('a player creates a character, taps a resource offline, and the GM sees it; another player never does', async ({
  browser,
}) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(150_000);
  const current = fixture as Fixture;
  const casey = await device(browser, current.casey);
  const gm = await device(browser, current.gm);
  const dana = await device(browser, current.dana);
  try {
    const create = casey.page.getByRole('button', { name: 'Create character' });
    await expect(create).toBeVisible({ timeout: SYNC });
    await casey.page.getByLabel('New character name').fill('Ash');
    await create.click();
    const sheet = casey.page.getByRole('article', { name: 'Sheet of Ash' });
    await expect(sheet).toBeVisible();
    const hp = sheet.locator('output[aria-label="HP"]');
    await expect(hp).toHaveText('3');
    await expect.poll(() => harness<number>(casey.page, 'pendingCount'), { timeout: SYNC }).toBe(0);
    await expect.poll(() => serverHp('Ash'), { timeout: SYNC }).toBe(3);

    // Offline: the tap shows at once and waits in the queue.
    casey.network.down = true;
    await harness(casey.page, 'pauseSync');
    await sheet.getByRole('button', { name: 'Decrease HP' }).click();
    await expect(hp).toHaveText('2');
    expect(await harness<number>(casey.page, 'pendingCount')).toBe(1);
    expect(await serverHp('Ash')).toBe(3);
    casey.network.down = false;
    await harness(casey.page, 'resumeSync');
    await expect.poll(() => harness<number>(casey.page, 'pendingCount'), { timeout: SYNC }).toBe(0);
    await expect.poll(() => serverHp('Ash'), { timeout: SYNC }).toBe(2);
    // The accepted change is in the row now; the overlay must not count it twice.
    await expect(hp).toHaveText('2');

    await expect(gm.page.getByRole('button', { name: 'Ash' })).toBeVisible({ timeout: SYNC });
    await gm.page.getByRole('button', { name: 'Ash' }).click();
    await expect(
      gm.page.getByRole('article', { name: 'Sheet of Ash' }).locator('output[aria-label="HP"]'),
    ).toHaveText('2', { timeout: SYNC });
    await expect(dana.page.getByRole('button', { name: 'Create character' })).toBeVisible({
      timeout: SYNC,
    });
    expect(await harness<readonly string[]>(dana.page, 'storedCharacters')).toEqual([]);
    await expect(dana.page.getByRole('button', { name: 'Ash' })).toHaveCount(0);
  } finally {
    await casey.context.close();
    await gm.context.close();
    await dana.context.close();
  }
});

test('a player rolls a declared action from the sheet and applies its plan', async ({
  browser,
}) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(120_000);
  const current = fixture as Fixture;
  const casey = await device(browser, current.casey);
  try {
    await casey.page.getByRole('button', { name: 'Ash' }).click({ timeout: SYNC });
    const sheet = casey.page.getByRole('article', { name: 'Sheet of Ash' });
    const actions = sheet.getByRole('region', { name: 'Actions' });
    await actions.getByRole('button', { name: 'Save', exact: true }).click();
    await actions.getByRole('combobox').first().selectOption({ label: 'Strength' });
    await actions.getByRole('button', { name: 'Roll Save' }).click();
    const plan = actions.getByRole('region', { name: 'Plan' });
    await expect(plan.locator('[data-roll-result]')).toBeVisible();
    await expect(plan.locator('[data-outcome]')).toBeVisible();
    await plan.getByRole('button', { name: 'Decline' }).click();
    await expect(plan).toHaveCount(0);

    // A damage roll: what it does depends on the dice, so the test reads the plan, then checks the sheet.
    const before = Number(await sheet.locator('output[aria-label="HP"]').textContent());
    await actions.getByRole('button', { name: 'Take d6 damage' }).click();
    await actions.getByRole('button', { name: 'Roll Take d6 damage' }).click();
    await expect(plan.locator('[data-outcome]')).toBeVisible();
    const outcome = await plan.locator('[data-outcome]').getAttribute('data-outcome');
    const apply = plan.getByRole('button', { name: 'Apply', exact: true });
    await apply.click();
    if (outcome !== 'deflected') {
      await expect
        .poll(async () => Number(await sheet.locator('output[aria-label="HP"]').textContent()))
        .toBeLessThan(before + 1);
    }
    await expect.poll(() => harness<number>(casey.page, 'pendingCount'), { timeout: SYNC }).toBe(0);
    await expect
      .poll(
        async () =>
          (await serverHp('Ash')) ===
          Number(await sheet.locator('output[aria-label="HP"]').textContent()),
        {
          timeout: SYNC,
        },
      )
      .toBe(true);
  } finally {
    await casey.context.close();
  }
});
