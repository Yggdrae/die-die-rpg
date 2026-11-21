/**
 * Feature 20 D-03: text is lowercased and stripped of diacritics; a word is a run of letters and digits. The same
 * normalization applies to documents and queries, so "Mérchant" and "merch" meet.
 */

const DIACRITICS = /\p{M}+/gu;
const WORD = /[\p{L}\p{N}]+/gu;

export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(DIACRITICS, '').toLowerCase();
}

/** The normalized words of a text, in order, duplicates kept. */
export function words(text: string): string[] {
  return normalizeText(text).match(WORD) ?? [];
}
