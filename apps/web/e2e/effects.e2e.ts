import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

/**
 * Feature 11 on the real stack: the production browser replica through the PowerSync web SDK and the running
 * PowerSync service, the real API composition root in a Bun helper (`fixtures/effects-api-server.ts`) with a
 * probe target standing in for feature 15 (D-13), and the published device API (test-only host
 * `features/actions/e2e-harness.tsx`). Nothing else is mocked.
 *
 * Skipped unless PostgreSQL and the PowerSync service are reachable.
 */

const HELPER = 'apps/web/e2e/fixtures/effects-api-server.ts';
const APP = 'http://127.0.0.1:4173';
const PORT = 4190;
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
  readonly shared: string;
  readonly hidden: string;
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
      const module = (await import('/src/features/actions/e2e-harness.tsx')) as unknown as Record<
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
  await harness(page, 'open', { userId: user.userId, campaignId: fixture?.campaignId });
  await expect.poll(() => harness(page, 'role'), { timeout: SYNC }).toBeTruthy();
  return { context, page, network };
}

async function drained(target: Device): Promise<void> {
  await expect.poll(() => harness<number>(target.page, 'pendingCount'), { timeout: SYNC }).toBe(0);
}

async function serverHp(targetId: string): Promise<number> {
  if (sql === undefined) throw new Error('database unavailable');
  const [row] = await sql<{ current: number }[]>`
    select (state->'resources'->'hp'->>'current')::int as current
    from effect_e2e_targets where id = ${targetId}`;
  return row?.current ?? Number.NaN;
}

async function serverRows(id: string): Promise<number> {
  if (sql === undefined) throw new Error('database unavailable');
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from effect_applications where id = ${id}`;
  return row?.count ?? 0;
}

test('an offline application displays at once, reaches the authority once, and stops overlaying', async ({
  browser,
}) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(120_000);
  const current = fixture as Fixture;
  const gm = await device(browser, current.gm);
  try {
    gm.network.down = true;
    await harness(gm.page, 'pauseSync');
    const applied = await harness<{ id?: string; error?: string }>(gm.page, 'applyDamage', {
      targetId: current.shared,
      amount: 3,
    });
    expect(applied.error).toBeUndefined();
    const id = applied.id ?? '';
    expect(await harness<number>(gm.page, 'pendingCount')).toBe(1);
    // The display includes it, the authority has not heard of it.
    expect(await harness(gm.page, 'displayedHp', { targetId: current.shared, base: 10 })).toBe(7);
    expect(await serverRows(id)).toBe(0);
    expect(await serverHp(current.shared)).toBe(10);

    gm.network.down = false;
    await harness(gm.page, 'resumeSync');
    await drained(gm);
    expect(await serverRows(id)).toBe(1);
    expect(await serverHp(current.shared)).toBe(7);
    // The accepted row replaces the optimistic one, carrying what the authority computed. The base now
    // includes the change, so the overlay must stop adding it.
    await expect
      .poll(
        async () =>
          (await harness<{ acceptedAt?: string; changes: unknown[] } | null>(gm.page, 'record', id))
            ?.changes,
        { timeout: SYNC },
      )
      .toEqual([{ path: 'resources.hp.current', before: 10, after: 7 }]);
    expect(await harness(gm.page, 'displayedHp', { targetId: current.shared, base: 7 })).toBe(7);

    // Reconnecting sends nothing new.
    await harness(gm.page, 'pauseSync');
    await harness(gm.page, 'resumeSync');
    await drained(gm);
    expect(await serverHp(current.shared)).toBe(7);
  } finally {
    await gm.context.close();
  }
});

test('a record on a hidden target never reaches a player replica', async ({ browser }) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(120_000);
  const current = fixture as Fixture;
  const gm = await device(browser, current.gm);
  const casey = await device(browser, current.casey);
  try {
    const hidden = await harness<{ id?: string }>(gm.page, 'applyDamage', {
      targetId: current.hidden,
      amount: 2,
    });
    await drained(gm);
    // The barrier: written last, so a replica holding it has passed the hidden one.
    const barrier = await harness<{ id?: string }>(gm.page, 'applyDamage', {
      targetId: current.shared,
      amount: 1,
    });
    await drained(gm);
    await expect
      .poll(() => harness<readonly string[]>(casey.page, 'storedIds'), { timeout: SYNC })
      .toContain(barrier.id);
    expect(await harness(casey.page, 'storedIds')).not.toContain(hidden.id);
    expect(await harness(casey.page, 'oplogHolds', hidden.id)).toBe(false);
    expect(await serverHp(current.hidden)).toBe(8);
    // A player's application on a target it may not update is refused by the authority, not applied.
    const refused = await harness<{ id?: string }>(casey.page, 'applyDamage', {
      targetId: current.shared,
      amount: 1,
    });
    await expect
      .poll(async () => (sql === undefined ? 1 : await serverRows(refused.id ?? '')), {
        timeout: 2_000,
      })
      .toBe(0);
    const before = await serverHp(current.shared);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await serverHp(current.shared)).toBe(before);
  } finally {
    await gm.context.close();
    await casey.context.close();
  }
});
