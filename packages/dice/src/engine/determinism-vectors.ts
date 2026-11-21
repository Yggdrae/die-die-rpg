/**
 * The table every platform must reproduce (FR-010, success signal): `engine.test.ts` runs it in Bun
 * and `apps/web/e2e/determinism.e2e.ts` runs it in the browser. Faces are pinned from the published
 * mulberry32 algorithm; totals were worked out by hand from those faces.
 */
export const ROLL_VECTORS: readonly {
  readonly seed: number;
  readonly source: string;
  readonly inputs: Readonly<Record<string, number>>;
  readonly faces: readonly number[];
  readonly natural: number;
  readonly modified: number;
}[] = [
  { seed: 1, source: '1d20', inputs: {}, faces: [8], natural: 8, modified: 8 },
  { seed: 2, source: '2d6+3', inputs: {}, faces: [6, 5], natural: 11, modified: 14 },
  { seed: 3, source: '4d6kh3', inputs: {}, faces: [5, 4, 3, 4], natural: 13, modified: 13 },
  { seed: 4, source: '4d6kl1', inputs: {}, faces: [3, 5, 2, 1], natural: 1, modified: 1 },
  {
    seed: 5,
    source: '1d20+ATTRIBUTE_A',
    inputs: { ATTRIBUTE_A: 2 },
    faces: [5],
    natural: 5,
    modified: 7,
  },
  { seed: 6, source: '4dF', inputs: {}, faces: [-1, -1, -1, 0], natural: -3, modified: -3 },
  {
    seed: 7,
    source: '4dF + skill',
    inputs: { skill: 3 },
    faces: [0, 1, 1, 1],
    natural: 3,
    modified: 6,
  },
  {
    seed: 8,
    source: '6d6 success>=6',
    inputs: {},
    faces: [4, 4, 2, 6, 2, 1],
    natural: 1,
    modified: 1,
  },
  { seed: 9, source: '1d100', inputs: {}, faces: [5], natural: 5, modified: 5 },
];
