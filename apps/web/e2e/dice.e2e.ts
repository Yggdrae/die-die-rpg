import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

/**
 * Feature 09 on the real stack: the production browser replica through the PowerSync web SDK and the
 * running PowerSync service, the real API composition root in a Bun helper
 * (`fixtures/content-api-server.ts`), and the published device API (test-only host
 * `features/dice/e2e-harness.tsx`, since feature 09 has no screen of its own). Nothing is mocked.
 *
 * "Zero hidden rolls on a player replica" is asserted on what the browser's SQLite stores, including the
 * provider's raw oplog, with a later public roll as the barrier that proves synchronization reached past
 * the hidden ones.
 *
 * Skipped unless PostgreSQL and the PowerSync service are reachable.
 */

const HELPER = 'apps/web/e2e/fixtures/content-api-server.ts';
const APP = 'http://127.0.0.1:4173';
const PORT = 4189;
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
  readonly username: string;
}
interface Fixture {
  readonly campaignId: string;
  readonly gm: User;
  readonly assistant: User;
  readonly casey: User;
  readonly dana: User;
}
interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly user: User;
  network: { down: boolean };
}
interface Rolled {
  readonly record?: { readonly id: string; readonly result: { readonly modified: number } };
  readonly error?: string;
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
  return { context, page, user, network };
}

function harness<T>(page: Page, name: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    async (input) => {
      const module = (await import('/src/features/dice/e2e-harness.tsx')) as unknown as Record<
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

function roll(target: Device, input: Record<string, unknown>): Promise<Rolled> {
  return harness<Rolled>(target.page, 'roll', input);
}

/** Rolls and returns the id, failing the test on a refusal. */
async function rolled(target: Device, input: Record<string, unknown>): Promise<string> {
  const outcome = await roll(target, input);
  expect(outcome.error).toBeUndefined();
  return outcome.record?.id ?? '';
}

async function reaches(target: Device, id: string): Promise<void> {
  await expect
    .poll(() => harness<readonly string[]>(target.page, 'rollIds'), { timeout: SYNC })
    .toContain(id);
}

async function drained(target: Device): Promise<void> {
  await expect.poll(() => harness<number>(target.page, 'pendingCount'), { timeout: SYNC }).toBe(0);
}

async function serverRows(id: string): Promise<number> {
  if (sql === undefined) throw new Error('database unavailable');
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from dice_rolls where id = ${id}`;
  return row?.count ?? 0;
}

test('a roll works with no network, appears at once, and reaches the authority once', async ({
  browser,
}) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(120_000);
  const current = fixture as Fixture;
  const casey = await device(browser, current.casey);
  try {
    casey.network.down = true;
    await harness(casey.page, 'pauseSync');

    const started = Date.now();
    const outcome = await roll(casey, {
      expression: '1d20+ATTRIBUTE_A',
      inputs: { ATTRIBUTE_A: 2 },
      visibility: 'public',
      action: 'attack',
    });
    const elapsed = Date.now() - started;
    expect(outcome.error).toBeUndefined();
    const id = outcome.record?.id ?? '';
    // Includes the page round trip and SQLite; far below anything a player would notice.
    expect(elapsed).toBeLessThan(1_000);
    expect(await harness(casey.page, 'rollIds')).toContain(id);
    expect(await harness<number>(casey.page, 'pendingCount')).toBe(1);
    // Rolls queue no audit envelope (D-08).
    expect(await harness(casey.page, 'queuedAudit')).toEqual([false]);
    expect(await serverRows(id)).toBe(0);

    casey.network.down = false;
    await harness(casey.page, 'resumeSync');
    await drained(casey);
    expect(await serverRows(id)).toBe(1);
    // Reconnecting again sends nothing new, and the replica still holds one row.
    await harness(casey.page, 'pauseSync');
    await harness(casey.page, 'resumeSync');
    await reaches(casey, id);
    expect(await serverRows(id)).toBe(1);
    expect(
      (await harness<readonly { id: string }[]>(casey.page, 'storedRows')).filter(
        (row) => row.id === id,
      ).length,
    ).toBe(1);
  } finally {
    await casey.context.close();
  }
});

test('zero hidden rolls on a player replica; a player cannot create one', async ({ browser }) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(180_000);
  const current = fixture as Fixture;
  const gm = await device(browser, current.gm);
  const casey = await device(browser, current.casey);
  const dana = await device(browser, current.dana);
  const assistant = await device(browser, current.assistant);
  try {
    const hidden = await rolled(gm, { expression: '1d20', visibility: 'gm_only' });
    const blind = await rolled(gm, {
      expression: '4dF',
      visibility: 'blind',
      targetRef: current.casey.userId,
    });
    const gmPrivate = await rolled(gm, { expression: '1d6', visibility: 'player_only' });
    const whisper = await rolled(casey, {
      expression: '1d6',
      visibility: 'whisper',
      recipients: [current.dana.userId],
    });
    const casePrivate = await rolled(casey, { expression: '1d8', visibility: 'player_only' });
    // The barrier: written last, so a replica holding it has passed the hidden ones.
    await drained(gm);
    await drained(casey);
    const barrier = await rolled(gm, { expression: '2d6+3', visibility: 'public' });
    await drained(gm);

    await reaches(casey, barrier);
    await reaches(dana, barrier);
    await reaches(dana, whisper);
    await reaches(assistant, barrier);

    for (const [player, foreign] of [
      [casey, [] as string[]],
      [dana, [casePrivate]],
    ] as const) {
      const stored = await harness<
        readonly { id: string; roll_visibility: string; visibility_mode: string }[]
      >(player.page, 'storedRows');
      expect(stored.filter((row) => ['gm_only', 'blind'].includes(row.roll_visibility))).toEqual(
        [],
      );
      expect(stored.filter((row) => row.visibility_mode === 'gm_only')).toEqual([]);
      for (const absent of [hidden, blind, gmPrivate, ...foreign]) {
        expect(stored.map((row) => row.id)).not.toContain(absent);
        expect(await harness(player.page, 'oplogHolds', absent)).toBe(false);
      }
    }

    // GM roles receive everything, including a roll from another GM role's device.
    for (const id of [hidden, blind, gmPrivate, whisper, casePrivate]) {
      await reaches(assistant, id);
    }

    // On the device, a player's hidden roll is refused and queues nothing.
    for (const visibility of ['gm_only', 'blind']) {
      const refused = await roll(casey, { expression: '1d20', visibility });
      expect(refused.error).toBe('hidden_from_roller');
    }
    await drained(casey);
    const count = (await harness<readonly unknown[]>(casey.page, 'storedRows')).length;
    expect(await harness<number>(casey.page, 'pendingCount')).toBe(0);
    expect((await harness<readonly unknown[]>(casey.page, 'storedRows')).length).toBe(count);
  } finally {
    await gm.context.close();
    await casey.context.close();
    await dana.context.close();
    await assistant.context.close();
  }
});
