import type { RandomSource } from './model.ts';

/**
 * Injectable randomness (FR-010). Both sources draw 32-bit words and discard any word past the
 * largest whole multiple of the bound, because a plain modulo favours low faces.
 */

const WORD_RANGE = 2 ** 32;

function fromWords(nextWord: () => number): RandomSource {
  return {
    nextInt(bound) {
      const usable = WORD_RANGE - (WORD_RANGE % bound);
      for (;;) {
        const word = nextWord();
        if (word < usable) return word % bound;
      }
    },
  };
}

/**
 * Deterministic for tests and vectors: mulberry32, whose state and output are 32-bit integer
 * arithmetic, so the same seed gives the same sequence on every engine. Not for real rolls.
 */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return fromWords(() => {
    state = (state + 0x6d2b79f5) >>> 0;
    let word = Math.imul(state ^ (state >>> 15), 1 | state);
    word = (word + Math.imul(word ^ (word >>> 7), 61 | word)) ^ word;
    return (word ^ (word >>> 14)) >>> 0;
  });
}

/** Production: the platform's cryptographic generator. Takes it as a parameter for tests. */
export function cryptoRandom(
  source: { getRandomValues(values: Uint32Array<ArrayBuffer>): unknown } = crypto,
): RandomSource {
  const word = new Uint32Array(1);
  return fromWords(() => {
    source.getRandomValues(word);
    return word[0] as number;
  });
}
