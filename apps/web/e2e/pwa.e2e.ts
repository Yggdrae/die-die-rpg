import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test';
import { build, type PreviewServer, preview } from 'vite';

/**
 * Feature 03: the production bundle as an installed app would run it. A real `vite build` served by
 * `vite preview` with its service worker, the real API (`fixtures/content-api-server.ts`), and the
 * running PowerSync service. The device goes offline and the app restarts from the service worker,
 * through the same origin and with no harness.
 *
 * Not covered: an actual home-screen install on a phone. Chromium's own installability check stands
 * in for that step.
 */

const HELPER = 'apps/web/e2e/fixtures/content-api-server.ts';
const PACKAGES = 'apps/web/e2e/fixtures/rpgpack.ts';
const STORAGE_PORT = new URL(process.env.S3_ENDPOINT ?? 'http://localhost:9000').port;
const APP_PORT = 4179;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_PORT = 4189;
const API = `http://127.0.0.1:${API_PORT}`;
const API_ORIGIN = 'https://table.invalid';
const ENDPOINT = process.env.POWERSYNC_ENDPOINT ?? 'http://localhost:8080';
const SYNC = Number(process.env.E2E_SYNC_TIMEOUT_MS ?? 30_000);
const PASSWORD = 'correct horse battery staple';
const WEBKIT_OFFLINE =
  'Playwright WebKit fails navigations through a service worker while offline ("internal error")';

test.describe.configure({ mode: 'serial' });

interface User {
  readonly cookie: string;
  readonly username: string;
}
interface Fixture {
  readonly campaignId: string;
  readonly gm: User;
  readonly casey: User;
}

let site: PreviewServer | undefined;
let outDir: string | undefined;
let api: ChildProcess | undefined;
let fixture: Fixture | undefined;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  // Not the `build` script: its `sync:assets` step replaces files the dev server is serving to the
  // other specs. The server's own `predev` already copied them.
  outDir = mkdtempSync(join(tmpdir(), 'rpg-pwa-'));
  await build({ root: 'apps/web', logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  site = await preview({
    root: 'apps/web',
    logLevel: 'silent',
    build: { outDir },
    preview: { host: '127.0.0.1', port: APP_PORT, strictPort: true },
  });
  if ((process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL) === undefined) return;
  try {
    const probe = await fetch(`${ENDPOINT}/probes/liveness`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!probe.ok) return;
  } catch {
    return;
  }
  const child = spawn('bun', [HELPER, 'serve', String(API_PORT)], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api = child;
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
  api?.kill();
  await site?.close();
  if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
  if (fixture !== undefined) {
    execFileSync('bun', [HELPER, 'cleanup', fixture.campaignId], { env: process.env });
  }
});

/** Waits until the service worker controls this page, so later navigations come from its cache. */
async function controlled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller !== null) return;
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
    });
  });
}

test('Chromium accepts the production build as installable', async ({ browserName }, testInfo) => {
  test.skip(
    browserName !== 'chromium' || testInfo.project.use.channel === undefined,
    'the installability check is a protocol call of branded Chromium; the headless shell never answers it',
  );
  // A persistent profile: Chromium refuses every incognito context, which `browser` would give.
  const context = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    headless: true,
    ...(testInfo.project.use.channel === undefined
      ? {}
      : { channel: testInfo.project.use.channel }),
  });
  const page = await context.newPage();
  await page.goto(APP);
  await controlled(page);
  const session = await context.newCDPSession(page);
  const { installabilityErrors } = await session.send('Page.getInstallabilityErrors');
  expect(installabilityErrors).toEqual([]);
  await context.close();
});

test('the app shell and every sync worker asset load with no network', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName === 'webkit', WEBKIT_OFFLINE);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(APP);
  await controlled(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const failed = await page.evaluate(async () => {
    const assets = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.includes('/assets/'));
    const required = ['/sync-assets/powersync-1.39.1/WASQLiteDB.umd.js', ...assets];
    const results = await Promise.all(
      required.map(async (path) => ((await fetch(path)).ok ? undefined : path)),
    );
    return results.filter((path) => path !== undefined);
  });
  expect(failed).toEqual([]);
  await context.close();
});

test.describe('a signed-in member reopening the installed app', () => {
  test.beforeEach(() => {
    test.skip(fixture === undefined, 'PostgreSQL or the PowerSync service is unreachable');
  });

  /** One device; API calls go to the helper with the user's session, as the same origin would. */
  async function device(browserContext: BrowserContext, user: User) {
    const network = { down: false };
    // This device's session: logging in replaces it, as the browser's cookie jar would.
    let cookie = user.cookie;
    await browserContext.route(`${ENDPOINT}/**`, (route) =>
      network.down ? route.abort('internetdisconnected') : route.continue(),
    );
    await browserContext.route(
      (url) =>
        url.origin === APP &&
        /^\/(auth|campaigns|exports|sync|systems)(\/|$|\?)/.test(url.pathname),
      async (route) => {
        if (network.down) return route.abort('internetdisconnected');
        const request = route.request();
        // A navigation here is the app itself, which only the service worker or preview serves.
        if (request.isNavigationRequest()) return route.fallback();
        try {
          const response = await route.fetch({
            url: request.url().replace(APP, API),
            headers: { ...request.headers(), origin: API_ORIGIN, cookie },
          });
          const issued = response.headers()['set-cookie']?.split(';')[0];
          if (issued?.includes('=') === true && response.ok()) cookie = issued;
          await route.fulfill({ response });
        } catch {
          await route.abort('failed').catch(() => undefined);
        }
      },
    );
    return network;
  }

  async function synced(page: Page): Promise<void> {
    const status = page.locator('[data-sync-state]');
    await expect(status).toHaveAttribute('data-sync-state', 'synchronized', { timeout: SYNC });
    await expect(status).toHaveAttribute('data-pending-count', '0', { timeout: SYNC });
  }

  function entity(page: Page, name: string) {
    return page
      .getByRole('region', { name: 'Entities', exact: true })
      .getByRole('button', { name, exact: true });
  }

  async function quickCreate(page: Page, name: string): Promise<void> {
    await page.getByRole('button', { name: 'Add NPC', exact: true }).click();
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await expect(entity(page, name)).toBeVisible({ timeout: SYNC });
  }

  async function serverNames(user: User): Promise<string[]> {
    if (fixture === undefined) return [];
    const response = await fetch(`${API}/campaigns/${fixture.campaignId}/entities?limit=200`, {
      headers: { cookie: user.cookie },
    });
    const body = (await response.json()) as { items: { name: string }[] };
    return body.items.map((item) => item.name);
  }

  test('reopens offline at its replica, keeps writing, restarts again, and converges', async ({
    browser,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'Playwright Firefox and WebKit refuse offline navigations a service worker should answer when routes are installed',
    );
    if (fixture === undefined) return;
    test.setTimeout(240_000);
    const context = await browser.newContext();
    const network = await device(context, fixture.gm);
    const page = await context.newPage();

    // First run online: sign in through the real form, which installs the service worker.
    await page.goto(APP);
    await page.getByLabel('Username').fill(fixture.gm.username);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Campaign content' })).toBeVisible({
      timeout: SYNC,
    });
    await controlled(page);
    await synced(page);
    await quickCreate(page, 'Written online');
    await synced(page);

    const reopen = async (current: Page): Promise<Page> => {
      await current.close();
      const next = await context.newPage();
      await next.goto(APP);
      return next;
    };

    // The device loses its network, and the app is closed and opened cold.
    network.down = true;
    await context.setOffline(true);
    const started = Date.now();
    const offline = await reopen(page);
    await expect(entity(offline, 'Written online')).toBeVisible({ timeout: SYNC });
    const usableMs = Date.now() - started;
    console.info(`installed app, offline cold start to replica content: ${usableMs} ms`);
    expect(usableMs).toBeLessThan(2_000);
    await expect(offline.getByRole('heading', { name: 'Log in' })).toHaveCount(0);
    await expect(offline.locator('[data-sync-state]')).toHaveAttribute(
      'data-sync-state',
      'offline',
      { timeout: SYNC },
    );

    // It writes offline, closes, and the queue survives a second offline restart.
    await quickCreate(offline, 'Written offline');
    await expect(offline.locator('[data-sync-state]')).not.toHaveAttribute(
      'data-pending-count',
      '0',
      { timeout: SYNC },
    );
    const again = await reopen(offline);
    await expect(entity(again, 'Written offline')).toBeVisible({ timeout: SYNC });
    await expect(again.locator('[data-sync-state]')).not.toHaveAttribute(
      'data-pending-count',
      '0',
      { timeout: SYNC },
    );
    expect(await serverNames(fixture.gm)).not.toContain('Written offline');

    // The network returns: the queue drains to the authority.
    network.down = false;
    await context.setOffline(false);
    await synced(again);
    await expect
      .poll(() => serverNames(fixture?.gm as User), { timeout: SYNC })
      .toContain('Written offline');

    // Signing out forgets the device: the next open is the login form, offline or not.
    await again.getByRole('button', { name: 'Log out' }).click();
    await expect(again.getByRole('heading', { name: 'Log in' })).toBeVisible({ timeout: SYNC });
    await again.close();
    const signedOut = await context.newPage();
    await signedOut.goto(APP);
    await expect(signedOut.getByRole('heading', { name: 'Log in' })).toBeVisible();
    await context.close();
  });

  async function signIn(page: Page, user: User): Promise<void> {
    await page.goto(APP);
    await page.getByLabel('Username').fill(user.username);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Campaign content' })).toBeVisible({
      timeout: SYNC,
    });
    await controlled(page);
    await synced(page);
  }

  /** Runs the mounted export to a file on disk. */
  async function exportFrom(page: Page, name: string): Promise<string> {
    await openExport(page);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export campaign' }).click();
    const path = test.info().outputPath(name);
    await (await download).saveAs(path);
    return path;
  }

  async function openExport(page: Page): Promise<void> {
    const panel = page.locator('details', { has: page.getByText('Export', { exact: true }) });
    if ((await panel.getAttribute('open')) === null) {
      await panel.getByText('Export', { exact: true }).click();
    }
    const warning = page.getByLabel('I understand this file reveals GM secrets');
    if (!(await warning.isChecked())) await warning.check();
  }

  function chunks(path: string): { systemLock: unknown; chunks: Record<string, unknown> } {
    return JSON.parse(execFileSync('bun', [PACKAGES, 'chunks', path], { encoding: 'utf8' }));
  }

  test('a synchronized campaign exports offline with exactly the online chunks, again after a restart', async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'needs the offline restart, proven on Chromium');
    if (fixture === undefined) return;
    test.setTimeout(120_000);
    const context = await browser.newContext();
    const network = await device(context, fixture.gm);
    // The bucket's CORS allows the dev server's origin, not this build's, so the signed upload goes
    // through the test. Nothing about the upload is what this test proves.
    await context.route(
      (url) => url.port === STORAGE_PORT,
      async (route) => {
        const cors = {
          'access-control-allow-origin': APP,
          'access-control-allow-methods': 'PUT, GET, HEAD',
          'access-control-allow-headers': '*',
          'access-control-expose-headers': '*',
          'cross-origin-resource-policy': 'cross-origin',
        };
        if (route.request().method() === 'OPTIONS') {
          return route.fulfill({ status: 204, headers: cors });
        }
        const response = await route.fetch();
        return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      },
    );
    const page = await context.newPage();
    await signIn(page, fixture.gm);

    await quickCreate(page, 'Exported Merchant');
    await synced(page);
    await entity(page, 'Exported Merchant').click();
    const section = page
      .getByRole('article', { name: 'Exported Merchant details' })
      .getByRole('region', { name: 'Entity attachments' });
    await section.getByLabel('File', { exact: true }).setInputFiles({
      name: 'ledger.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    await section.getByRole('button', { name: 'Attach' }).click();
    await expect(section.getByRole('status').last()).toHaveText('Attached ledger.png.', {
      timeout: SYNC,
    });
    await synced(page);
    // The metadata stream has no user-visible signal; give the provider its checkpoint.
    await page.waitForTimeout(3_000);

    const online = chunks(await exportFrom(page, 'online.rpgpack'));
    expect(online.chunks.attachments).toMatchObject({
      entries: [expect.objectContaining({ filename: 'ledger.png' })],
    });
    expect(JSON.stringify(online.chunks.content)).toContain('Exported Merchant');

    network.down = true;
    await context.setOffline(true);
    const offlinePath = await exportFrom(page, 'offline.rpgpack');
    expect(offlinePath).toContain('offline');
    await expect(page.locator('[data-export-source="offline"]')).toBeVisible();
    expect(chunks(offlinePath)).toEqual(online);

    // An interrupted download needs nothing kept: the restart regenerates the same chunks.
    await page.close();
    const restarted = await context.newPage();
    await restarted.goto(APP);
    await expect(entity(restarted, 'Exported Merchant')).toBeVisible({ timeout: SYNC });
    expect(chunks(await exportFrom(restarted, 'restarted.rpgpack'))).toEqual(online);

    // A write the authority has not accepted makes the copy incomplete: an explicit refusal.
    await quickCreate(restarted, 'Unsynchronized Rumor');
    let downloads = 0;
    restarted.on('download', () => {
      downloads += 1;
    });
    await restarted.getByRole('button', { name: 'Export campaign' }).click();
    const refusal = restarted.getByRole('region', { name: 'Export campaign' }).getByRole('alert');
    await expect(refusal).toContainText('No partial file was created');
    await expect(refusal).toHaveAttribute('data-incomplete-modules', /campaign.*content/);
    expect(downloads).toBe(0);

    network.down = false;
    await context.setOffline(false);
    await synced(restarted);
    await context.close();
  });

  test('offline, a player is refused before any file exists', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'needs the offline restart, proven on Chromium');
    if (fixture === undefined) return;
    test.setTimeout(120_000);
    const context = await browser.newContext();
    const network = await device(context, fixture.casey);
    const page = await context.newPage();
    await signIn(page, fixture.casey);
    network.down = true;
    await context.setOffline(true);
    await openExport(page);
    let downloads = 0;
    page.on('download', () => {
      downloads += 1;
    });
    await page.getByRole('button', { name: 'Export campaign' }).click();
    await expect(
      page.getByRole('region', { name: 'Export campaign' }).getByRole('alert'),
    ).toContainText('Only the campaign owner or a game master');
    expect(downloads).toBe(0);
    await context.setOffline(false);
    await context.close();
  });

  test('a rejected session goes back to the login form', async ({ browser }) => {
    if (fixture === undefined) return;
    const context = await browser.newContext();
    await context.route(
      (url) => url.origin === APP && url.pathname === '/campaigns',
      (route) =>
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'unauthenticated', message: 'Authentication required.' }),
        }),
    );
    const page = await context.newPage();
    await page.goto(APP);
    await page.evaluate(() => {
      localStorage.setItem(
        'rpg.device-session',
        JSON.stringify({ userId: crypto.randomUUID(), campaignId: crypto.randomUUID() }),
      );
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible({ timeout: SYNC });
    expect(await page.evaluate(() => localStorage.getItem('rpg.device-session'))).toBeNull();
    await context.close();
  });
});
