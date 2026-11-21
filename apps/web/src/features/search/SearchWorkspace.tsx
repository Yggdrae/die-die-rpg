import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { followRoute } from '../../routes.ts';
import {
  createSearchService,
  type SearchActor,
  type SearchAnswer,
  type SearchContribution,
  type SearchService,
  type SearchStatus,
} from './search-service.ts';

/**
 * Feature 20 web screen (FR-003, FR-006, D-08, D-15): the campaign search over the device index. Results are links to
 * the owning views, labelled by the owning feature; the count never includes what the actor may not see. `/` focuses
 * it from anywhere outside a text field.
 */

export const SCREEN_LIMIT = 20;

/** One service per open campaign, started after mount and disposed with it. */
export function useSearchService(input: {
  readonly campaignId: string | undefined;
  readonly contributions: readonly SearchContribution[] | undefined;
  readonly actor: () => Promise<SearchActor | undefined>;
}): SearchService | undefined {
  const { campaignId, contributions, actor } = input;
  const service = useMemo(
    () =>
      campaignId === undefined || contributions === undefined
        ? undefined
        : createSearchService({ campaignId, contributions, actor }),
    [campaignId, contributions, actor],
  );
  useEffect(() => {
    service?.start();
    return () => service?.dispose();
  }, [service]);
  return service;
}

/** Re-renders on every index, status, or actor change. */
export function useSearchVersion(service: SearchService | undefined): number {
  return useSyncExternalStore(
    (listener) => service?.subscribe(listener) ?? (() => undefined),
    () => service?.version ?? 0,
    () => 0,
  );
}

export function SearchWorkspace(props: { readonly service: SearchService }) {
  const { service } = props;
  useSearchVersion(service);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const status = service.status();
  const answer = service.query(text, { limit: SCREEN_LIMIT });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <section aria-label="Campaign search" data-search-ready={status.ready}>
      <h2>Search</h2>
      <search>
        <label>
          Search campaign{' '}
          <input
            ref={input}
            type="search"
            aria-keyshortcuts="/"
            placeholder="A name, a place, a word…"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
      </search>
      <SearchResultsView query={text} status={status} answer={answer} onOpen={followRoute} />
    </section>
  );
}

/** The status line, the count, and the results; pure, so it renders in tests. */
export function SearchResultsView(props: {
  readonly query: string;
  readonly status: SearchStatus;
  readonly answer: SearchAnswer;
  readonly onOpen: (href: string) => void;
}) {
  const { status, answer } = props;
  const asked = props.query.trim() !== '';
  return (
    <>
      {!status.ready && <p role="status">Indexing…</p>}
      {status.failed.length > 0 && (
        <p role="alert">Could not index: {status.failed.join(', ')}. Other results are shown.</p>
      )}
      {asked && (
        <p data-testid="search-count" aria-live="polite">
          {answer.total} {answer.total === 1 ? 'result' : 'results'}
        </p>
      )}
      <ul aria-label="Search results">
        {answer.results.map((result) => (
          <li key={result.key} data-result-id={result.id}>
            {result.href === undefined ? (
              <strong>{result.title}</strong>
            ) : (
              <a
                href={result.href}
                onClick={(event) => {
                  event.preventDefault();
                  props.onOpen(result.href as string);
                }}
              >
                {result.title}
              </a>
            )}{' '}
            <small>{result.typeLabel}</small>
            {result.snippet !== undefined && <p>{result.snippet}</p>}
          </li>
        ))}
      </ul>
      {asked && answer.total === 0 && <p>No results.</p>}
    </>
  );
}
