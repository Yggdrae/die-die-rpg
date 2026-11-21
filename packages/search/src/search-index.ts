import { check, SearchDoc, type Visibility } from '@rpg/contracts';
import { normalizeText, words } from './text.ts';

/**
 * Feature 20's in-memory index over `SearchDoc`s (D-02 to D-06, D-14). It knows no feature: documents arrive per
 * contributing module, keep their stored Visibility, and are filtered at query time by the caller's `admits`, before
 * ranking, counting, and limiting, so a hidden document never shows in a count or a snippet.
 */

/** Feature 04's answer for one Visibility, for the actor asking (D-05). */
export type Admits = (visibility: Visibility) => boolean;

export interface SearchHit {
  readonly moduleId: string;
  readonly doc: SearchDoc;
  readonly score: number;
  /** Up to 120 characters of the document's own body around the first body match (D-14). */
  readonly snippet?: string;
}

export interface SearchResults {
  readonly hits: readonly SearchHit[];
  /** Every admitted match, before the limit. Never counts a refused document. */
  readonly total: number;
}

export interface ReplaceOutcome {
  readonly indexed: number;
  /** Invalid documents and documents of another campaign, dropped (D-06). */
  readonly rejected: number;
}

interface Entry {
  readonly key: string;
  readonly moduleId: string;
  readonly doc: SearchDoc;
  readonly title: string;
  readonly titleWords: readonly string[];
  readonly titleSet: ReadonlySet<string>;
  readonly terms: ReadonlySet<string>;
}

const EXACT_TITLE = 8;
const TITLE_PREFIX = 4;
const BODY_PREFIX = 1;
const TITLE_STARTS = 4;
const SNIPPET_LENGTH = 120;
const SNIPPET_LEAD = 40;
const WORD = /[\p{L}\p{N}]+/gu;

export const DEFAULT_SEARCH_LIMIT = 20;

export class SearchIndex {
  readonly #entries = new Map<string, Entry>();
  readonly #byModule = new Map<string, Set<string>>();
  readonly #postings = new Map<string, Set<string>>();
  #vocabulary: string[] | undefined;

  constructor(readonly campaignId: string) {}

  get size(): number {
    return this.#entries.size;
  }

  moduleSize(moduleId: string): number {
    return this.#byModule.get(moduleId)?.size ?? 0;
  }

  /** Replaces every document of one module with `docs`, diffed by ID (D-07). */
  replaceModule(moduleId: string, docs: readonly unknown[]): ReplaceOutcome {
    const next = new Map<string, SearchDoc>();
    let rejected = 0;
    for (const doc of docs) {
      if (!check(SearchDoc, doc) || doc.campaignId !== this.campaignId) {
        rejected += 1;
        continue;
      }
      next.set(keyOf(moduleId, doc.id), doc);
    }
    const current = this.#byModule.get(moduleId) ?? new Set<string>();
    for (const key of [...current]) {
      if (!next.has(key)) this.#remove(key);
    }
    for (const [key, doc] of next) {
      const existing = this.#entries.get(key);
      if (
        existing !== undefined &&
        existing.doc.title === doc.title &&
        existing.doc.body === doc.body
      ) {
        // Same text: only the stored fields (Visibility, type) change; the postings stay.
        this.#entries.set(key, { ...existing, doc });
        continue;
      }
      if (existing !== undefined) this.#remove(key);
      this.#add(key, moduleId, doc);
    }
    return { indexed: next.size, rejected };
  }

  removeModule(moduleId: string): void {
    for (const key of [...(this.#byModule.get(moduleId) ?? [])]) this.#remove(key);
    this.#byModule.delete(moduleId);
  }

  clear(): void {
    this.#entries.clear();
    this.#byModule.clear();
    this.#postings.clear();
    this.#vocabulary = undefined;
  }

  /** Prefix AND matching (D-03), type-agnostic ranking (D-04), Visibility before everything else (D-05). */
  query(
    text: string,
    options: { readonly admits: Admits; readonly limit?: number },
  ): SearchResults {
    const queryWords = [...new Set(words(text))];
    if (queryWords.length === 0) return { hits: [], total: 0 };
    let candidates: Set<string> | undefined;
    for (const word of queryWords) {
      const matched = new Set<string>();
      for (const term of this.#prefixed(word)) {
        for (const key of this.#postings.get(term) ?? []) {
          if (candidates === undefined || candidates.has(key)) matched.add(key);
        }
      }
      candidates = matched;
      if (candidates.size === 0) return { hits: [], total: 0 };
    }
    const phrase = queryWords.join(' ');
    const scored: { entry: Entry; score: number }[] = [];
    for (const key of candidates ?? []) {
      const entry = this.#entries.get(key);
      if (entry === undefined || !options.admits(entry.doc.visibility)) continue;
      let score = entry.titleWords.join(' ').startsWith(phrase) ? TITLE_STARTS : 0;
      for (const word of queryWords) {
        if (entry.titleSet.has(word)) score += EXACT_TITLE;
        else if (entry.titleWords.some((title) => title.startsWith(word))) score += TITLE_PREFIX;
        else score += BODY_PREFIX;
      }
      scored.push({ entry, score });
    }
    scored.sort(
      (left, right) =>
        right.score - left.score ||
        left.entry.title.length - right.entry.title.length ||
        compare(left.entry.title, right.entry.title) ||
        compare(left.entry.doc.id, right.entry.doc.id),
    );
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    return {
      total: scored.length,
      hits: scored.slice(0, Math.max(0, limit)).map(({ entry, score }) => {
        const snippet = snippetOf(entry.doc.body, queryWords);
        return {
          moduleId: entry.moduleId,
          doc: entry.doc,
          score,
          ...(snippet === undefined ? {} : { snippet }),
        };
      }),
    };
  }

  #add(key: string, moduleId: string, doc: SearchDoc): void {
    const titleWords = words(doc.title);
    const terms = new Set([...titleWords, ...words(doc.body)]);
    this.#entries.set(key, {
      key,
      moduleId,
      doc,
      title: normalizeText(doc.title),
      titleWords,
      titleSet: new Set(titleWords),
      terms,
    });
    let keys = this.#byModule.get(moduleId);
    if (keys === undefined) {
      keys = new Set();
      this.#byModule.set(moduleId, keys);
    }
    keys.add(key);
    for (const term of terms) {
      let posting = this.#postings.get(term);
      if (posting === undefined) {
        posting = new Set();
        this.#postings.set(term, posting);
        this.#vocabulary = undefined;
      }
      posting.add(key);
    }
  }

  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    this.#byModule.get(entry.moduleId)?.delete(key);
    for (const term of entry.terms) {
      const posting = this.#postings.get(term);
      posting?.delete(key);
      if (posting !== undefined && posting.size === 0) {
        this.#postings.delete(term);
        this.#vocabulary = undefined;
      }
    }
  }

  /** Every indexed word starting with `prefix`: a binary search over the sorted vocabulary. */
  *#prefixed(prefix: string): Generator<string> {
    this.#vocabulary ??= [...this.#postings.keys()].sort(compare);
    const vocabulary = this.#vocabulary;
    let low = 0;
    let high = vocabulary.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((vocabulary[middle] as string) < prefix) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < vocabulary.length; index += 1) {
      const term = vocabulary[index] as string;
      if (!term.startsWith(prefix)) return;
      yield term;
    }
  }
}

function keyOf(moduleId: string, id: string): string {
  return `${moduleId}\u0000${id}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** D-14: the body around its first word matching a query word, cut on word bounds; none when the body never matched. */
export function snippetOf(body: string, queryWords: readonly string[]): string | undefined {
  for (const match of body.matchAll(WORD)) {
    const word = normalizeText(match[0]);
    if (!queryWords.some((query) => word.startsWith(query))) continue;
    const at = match.index;
    let start = Math.max(0, at - SNIPPET_LEAD);
    if (start > 0) {
      const space = body.indexOf(' ', start);
      start = space === -1 || space > at ? at : space + 1;
    }
    let end = Math.min(body.length, start + SNIPPET_LENGTH);
    if (end < body.length) {
      const space = body.lastIndexOf(' ', end);
      if (space > at) end = space;
    }
    const text = body.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${text}${end < body.length ? '…' : ''}`;
  }
  return undefined;
}
