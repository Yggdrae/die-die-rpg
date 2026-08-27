import { chromium } from 'playwright';

/**
 * Runs the spike page in a real Chromium, not the embedded browser.
 *
 * The embedded browser could not spawn the nested worker the OPFS VFS depends on, which
 * would report a false NO-GO for features 03, 14 and 20. This is the control.
 */

const url = process.argv[2] ?? 'http://localhost:5199/';

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const console_ = [];
page.on('console', (message) => console_.push(`[${message.type()}] ${message.text()}`));
page.on('pageerror', (error) => console_.push(`[pageerror] ${error.message}`));

// Not networkidle: the sync client holds an open streaming connection, so the page
// never goes idle. Wait for the verdict line instead.
await page.goto(url, { waitUntil: 'domcontentloaded' });

// The page publishes progress on window.__spike; wait for the verdict line.
await page
  .waitForFunction(
    () => {
      const results = window.__spike;
      return Array.isArray(results) && results.some((r) => r.label === 'SYNC QUESTION');
    },
    { timeout: 240_000 },
  )
  .catch(() => {});

const results = await page.evaluate(() => window.__spike ?? []);

console.log(`\nchromium ${browser.version()}  ${url}\n`);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}\n      ${r.detail}`);
}

const relevant = console_.filter((line) => !/vite/i.test(line));
if (relevant.length > 0) {
  console.log('\n--- console ---');
  for (const line of [...new Set(relevant)]) {
    console.log(line);
  }
}

await browser.close();

const failed = results.filter((r) => !r.ok);
process.exit(failed.length === 0 ? 0 : 1);
