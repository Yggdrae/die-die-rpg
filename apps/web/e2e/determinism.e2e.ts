import { expect, test } from '@playwright/test';

/**
 * Features 09 and 10: the published vector tables, in the browser's own JavaScript engine (test-only host
 * `features/dice/determinism.e2e-harness.ts`). Bun runs the same tables in `engine.test.ts` and
 * `formula.test.ts`; both answer to the table, written once.
 */

test('the formula table gives the same results in the browser', async ({ page }) => {
  await page.goto('/');
  const { count, wrong } = await page.evaluate(async () => {
    const harness = await import('/src/features/dice/determinism.e2e-harness.ts');
    return harness.formulaFailures();
  });
  expect(wrong).toEqual([]);
  expect(count).toBeGreaterThan(20);
});

test('the seeded roll table gives the same results in the browser', async ({ page }) => {
  await page.goto('/');
  const { count, wrong } = await page.evaluate(async () => {
    const harness = await import('/src/features/dice/determinism.e2e-harness.ts');
    return harness.rollFailures();
  });
  expect(wrong).toEqual([]);
  expect(count).toBeGreaterThan(8);
});
