import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

/**
 * Feature 17 on the real stack (`PRD.md` s.87 Test 3, s.78, s.76): the production handout screen
 * over the browser replica (test-only host `features/handouts/e2e-harness.tsx`), the running
 * PowerSync service, and the real API composition root (`fixtures/content-api-server.ts`). A GM
 * reveals a handout to one player, who sees it in under 5 seconds and reads it offline; the other
 * player's local database never holds it. A reveal made offline waits on the GM device and reaches
 * the table on reconnect; hiding again removes it from players' devices.
 *
 * Skipped unless PostgreSQL and the PowerSync service are reachable.
 */

const HELPER = 'apps/web/e2e/fixtures/content-api-server.ts';
const APP = 'http://127.0.0.1:4173';
const PORT = 4192;
const API = `http://127.0.0.1:${PORT}`;
const API_ORIGIN = 'https://table.invalid';
const ENDPOINT = process.env.POWERSYNC_ENDPOINT ?? 'http://localhost:8080';
const SYNC = Number(process.env.E2E_SYNC_TIMEOUT_MS ?? 30_000);
const REVEAL_BUDGET_MS = 5_000;

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
  readonly dana: User;
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
      const module = (await import('/src/features/handouts/e2e-harness.tsx')) as unknown as Record<
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
      const module = await import('/src/features/handouts/e2e-harness.tsx');
      module.mountHandouts(input);
    },
    { userId: user.userId, campaignId: fixture?.campaignId ?? '' },
  );
  await expect(page.getByRole('heading', { name: 'Handouts' })).toBeVisible({ timeout: SYNC });
  return { context, page, network };
}

async function offline(target: Device): Promise<void> {
  target.network.down = true;
  await harness(target.page, 'pauseSync');
}

async function online(target: Device): Promise<void> {
  target.network.down = false;
  await harness(target.page, 'resumeSync');
}

async function prepare(gm: Device, title: string, text: string): Promise<void> {
  const form = gm.page.getByRole('form', { name: 'New handout' });
  await expect(form).toBeVisible({ timeout: SYNC });
  await form.getByLabel('Handout title').fill(title);
  await form.getByLabel('Handout text').fill(text);
  await form.getByRole('button', { name: 'Prepare handout' }).click();
  await expect(gm.page.getByRole('article', { name: `Handout ${title}` })).toBeVisible();
  await expect.poll(() => harness<number>(gm.page, 'pendingCount'), { timeout: SYNC }).toBe(0);
}

const holds = (page: Page, text: string) =>
  harness<readonly string[]>(page, 'storedEntities').then((rows) =>
    rows.some((row) => row.includes(text)),
  );

test('a reveal to one player reaches only them, in under 5 seconds, and opens offline', async ({
  browser,
}) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(150_000);
  const current = fixture as Fixture;
  const gm = await device(browser, current.gm);
  const casey = await device(browser, current.casey);
  const dana = await device(browser, current.dana);
  try {
    await prepare(gm, 'Sealed letter', 'The ferryman lies.');
    const preview = gm.page.getByRole('article', { name: 'Handout Sealed letter' });
    await expect(preview.getByTestId('handout-text')).toHaveText('The ferryman lies.');
    await expect(preview.getByTestId('handout-recipients')).toHaveText('Hidden');
    for (const player of [casey, dana]) {
      await expect(player.page.getByText('No handouts yet.')).toBeVisible({ timeout: SYNC });
      expect(await holds(player.page, 'ferryman')).toBe(false);
    }

    // The confirm action names the recipient before anything is revealed.
    const reveal = preview.getByRole('region', { name: 'Reveal' });
    await reveal.getByLabel(current.casey.username).check({ timeout: SYNC });
    const confirm = reveal.getByRole('button', { name: `Reveal to ${current.casey.username}` });
    await expect(confirm).toBeEnabled();
    const started = Date.now();
    await confirm.click();
    await expect(casey.page.getByRole('button', { name: 'Sealed letter' })).toBeVisible({
      timeout: REVEAL_BUDGET_MS,
    });
    const elapsed = Date.now() - started;
    console.info(`handout reveal: GM confirm -> player screen ${elapsed} ms`);
    expect(elapsed).toBeLessThan(REVEAL_BUDGET_MS);
    await expect(preview.getByTestId('handout-recipients')).toHaveText(
      `Revealed to ${current.casey.username}`,
      { timeout: SYNC },
    );

    // Player B: absent from the local database, not hidden on screen.
    await expect.poll(() => harness<number>(gm.page, 'pendingCount'), { timeout: SYNC }).toBe(0);
    await dana.page.waitForTimeout(2_000);
    expect(await holds(dana.page, 'ferryman')).toBe(false);
    expect(await holds(dana.page, 'Sealed letter')).toBe(false);
    await expect(dana.page.getByText('No handouts yet.')).toBeVisible();

    // Player A reads it with no network.
    await offline(casey);
    await casey.page.getByRole('button', { name: 'Sealed letter' }).click();
    await expect(
      casey.page
        .getByRole('article', { name: 'Handout Sealed letter' })
        .getByTestId('handout-text'),
    ).toHaveText('The ferryman lies.');
    await expect(casey.page.getByRole('region', { name: 'Reveal' })).toHaveCount(0);
  } finally {
    await gm.context.close();
    await casey.context.close();
    await dana.context.close();
  }
});

test('a reveal made offline waits on the GM device, reaches the table on reconnect, and hides again', async ({
  browser,
}) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(150_000);
  const current = fixture as Fixture;
  const gm = await device(browser, current.gm);
  const dana = await device(browser, current.dana);
  try {
    await prepare(gm, 'Old map', 'X marks the mill.');
    const preview = gm.page.getByRole('article', { name: 'Handout Old map' });
    const reveal = preview.getByRole('region', { name: 'Reveal' });
    // Members load while online, then the GM loses the network.
    await expect(reveal.getByLabel(current.dana.username)).toBeVisible({ timeout: SYNC });
    await offline(gm);
    await reveal.getByLabel('Everyone').check();
    await reveal.getByRole('button', { name: 'Reveal to everyone' }).click();
    await expect(reveal.locator('[data-delivery="waiting"]')).toBeVisible();
    expect(await harness<number>(gm.page, 'pendingCount')).toBe(1);
    await dana.page.waitForTimeout(2_000);
    expect(await holds(dana.page, 'X marks the mill.')).toBe(false);

    await online(gm);
    await expect.poll(() => harness<number>(gm.page, 'pendingCount'), { timeout: SYNC }).toBe(0);
    await expect(dana.page.getByRole('button', { name: 'Old map' })).toBeVisible({ timeout: SYNC });
    await expect(preview.getByTestId('handout-recipients')).toHaveText('Revealed to everyone');

    // Hide again: the screen says what it does, and the handout leaves the player's device.
    await expect(reveal).toContainText('keeps what they read');
    await reveal.getByRole('button', { name: 'Hide again' }).click();
    await expect(dana.page.getByRole('button', { name: 'Old map' })).toHaveCount(0, {
      timeout: SYNC,
    });
    await expect.poll(() => holds(dana.page, 'X marks the mill.'), { timeout: SYNC }).toBe(false);
    await expect(preview.getByTestId('handout-recipients')).toHaveText('Hidden', { timeout: SYNC });
  } finally {
    await gm.context.close();
    await dana.context.close();
  }
});
