/**
 * The table every platform must reproduce exactly (FR-007): `formula.test.ts` runs it in Bun and
 * `apps/web/e2e/determinism.e2e.ts` runs it in the browser. Written by hand, not generated from the
 * implementation, so a wrong rounding rule fails here.
 */
export const FORMULA_VECTORS: readonly {
  readonly source: string;
  readonly context: Readonly<Record<string, number | boolean>>;
  readonly result: number | boolean;
}[] = [
  { source: '10 + ATTRIBUTE_A', context: { ATTRIBUTE_A: 12 }, result: 22 },
  { source: 'level * 2', context: { level: 3 }, result: 6 },
  { source: 'min(armor, 3)', context: { armor: 5 }, result: 3 },
  { source: 'ATTRIBUTE_A > 10', context: { ATTRIBUTE_A: 12 }, result: true },
  { source: 'RESOURCE_A <= 0', context: { RESOURCE_A: 0 }, result: true },
  { source: 'roll <= attribute', context: { roll: 11, attribute: 11 }, result: true },
  { source: 'roll - armor <= guard', context: { roll: 6, armor: 1, guard: 4 }, result: false },
  { source: 'armor - roll', context: { armor: 1, roll: 6 }, result: -5 },
  { source: 'margin > 0', context: { margin: 0 }, result: false },
  { source: '7 / 2', context: {}, result: 3 },
  { source: '-7 / 2', context: {}, result: -4 },
  { source: '7 / -2', context: {}, result: -4 },
  { source: '-7 / -2', context: {}, result: 3 },
  { source: '6 / -2', context: {}, result: -3 },
  { source: '9007199254740991 / 2', context: {}, result: 4503599627370495 },
  { source: '-9007199254740991 / 2', context: {}, result: -4503599627370496 },
  { source: '9007199254740991 / 9007199254740990', context: {}, result: 1 },
  { source: '0 * -1', context: {}, result: 0 },
  { source: '-(0)', context: {}, result: 0 },
  { source: '1 + 2 * 3 - 4', context: {}, result: 3 },
  { source: '(1 + 2) * (3 - 4)', context: {}, result: -3 },
  { source: 'min(3, -2, 5)', context: {}, result: -2 },
  { source: 'flag == true', context: { flag: true }, result: true },
  { source: 'a != b', context: { a: 1, b: 1 }, result: false },
];
