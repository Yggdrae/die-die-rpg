import {
  REFERENCE_REASON_TEXT,
  type RulesLibraryModel,
  type RulesMarkRecord,
  RulesSearch,
  type RulesSection,
  rulesLibrary,
} from '@rpg/rules';
import type { SystemPackage } from '@rpg/systems';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouteTarget } from '../../routes.ts';
import type { PinnedRules, RulesSource } from './rules-source.ts';
import { RULES_ROUTE } from './search-contribution.ts';

/**
 * Feature 14 screens (`_techspec.md` D-03 to D-07, D-11, D-13, D-14). Search-first: the search box is the first
 * control, results carry their category and their quick rule or a snippet, and a section opens with its quick rule
 * above its text, its references one tap away, and the attribution beside it. Everything renders from the pinned
 * package's declaration; no system is named (`PRD.md` s.89).
 */

export interface RulesMarksView {
  readonly bookmarks: readonly string[];
  readonly recent: readonly string[];
  onBookmark(sectionId: string, on: boolean): void;
}

function paragraphs(text: string) {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => <p key={part}>{part}</p>);
}

function ExternalLink(props: { readonly href: string; readonly name: string }) {
  return (
    <a href={props.href} target="_blank" rel="noreferrer">
      Read the rules of {props.name} in the external documentation
    </a>
  );
}

function SectionView(props: {
  readonly library: RulesLibraryModel;
  readonly section: RulesSection;
  readonly bookmarked?: boolean;
  readonly onBookmark?: (on: boolean) => void;
  readonly onSelect: (id: string) => void;
}) {
  const { library, section } = props;
  return (
    <article aria-label={`Rule: ${section.title}`} data-rule-section={section.id}>
      <h3>{section.title}</h3>
      <p>
        <small>{section.categoryLabel}</small>
      </p>
      {props.onBookmark !== undefined && (
        <button
          type="button"
          aria-pressed={props.bookmarked === true}
          onClick={() => props.onBookmark?.(props.bookmarked !== true)}
        >
          {props.bookmarked === true ? 'Remove bookmark' : 'Bookmark'}
        </button>
      )}
      {section.summary !== undefined && (
        <aside aria-label="Quick rule">
          <strong>Quick rule:</strong> {section.summary}
        </aside>
      )}
      {section.body !== undefined ? (
        <div data-testid="rule-text">{paragraphs(section.body)}</div>
      ) : (
        <p role="note">
          This section's text is not included in the app.{' '}
          {library.externalDocumentation !== undefined && (
            <ExternalLink href={library.externalDocumentation} name={library.name} />
          )}
        </p>
      )}
      {section.references.length > 0 && (
        <nav aria-label="See also">
          <ul>
            {section.references.map((reference) => (
              <li key={reference.id}>
                <button type="button" onClick={() => props.onSelect(reference.id)}>
                  {reference.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </article>
  );
}

function SectionList(props: {
  readonly label: string;
  readonly ids: readonly string[];
  readonly library: RulesLibraryModel;
  readonly onSelect: (id: string) => void;
  readonly empty: string;
}) {
  const sections = props.ids.flatMap((id) => {
    const section = props.library.section(id);
    return section === undefined ? [] : [section];
  });
  return (
    <nav aria-label={props.label}>
      <h3>{props.label}</h3>
      {sections.length === 0 ? (
        <p>{props.empty}</p>
      ) : (
        <ul>
          {sections.map((section) => (
            <li key={section.id}>
              <button type="button" onClick={() => props.onSelect(section.id)}>
                {section.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

/** The library of one package: search, tree, section, attribution, and (in a campaign) the user's marks. */
export function RulesView(props: {
  readonly library: RulesLibraryModel;
  readonly label: string;
  readonly selected?: string;
  readonly onSelect: (id: string) => void;
  readonly marks?: RulesMarksView;
  readonly initialQuery?: string;
}) {
  const { library, marks, onSelect } = props;
  const [query, setQuery] = useState(props.initialQuery ?? '');
  const search = useMemo(() => new RulesSearch(library), [library]);
  const answer = useMemo(() => search.query(query), [search, query]);
  const selected = props.selected === undefined ? undefined : library.section(props.selected);
  const title = `${library.name} ${library.ref.version}`;
  return (
    <section aria-label={props.label} data-rules-state={library.state}>
      <h2>Rules — {title}</h2>
      <search>
        <label>
          Search rules
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="healing, combat, checks…"
          />
        </label>
      </search>
      <p data-testid="rules-scope">
        <small>Searching {search.scope()}.</small>
      </p>
      {query.trim() !== '' && (
        <>
          <p data-testid="rules-result-count">
            {answer.total} {answer.total === 1 ? 'result' : 'results'}
          </p>
          <ul aria-label="Rules results">
            {answer.results.map((result) => (
              <li key={result.section.id}>
                <button type="button" onClick={() => onSelect(result.section.id)}>
                  {result.section.title}
                </button>{' '}
                <small>{result.section.categoryLabel}</small>
                {result.quick !== undefined ? (
                  <p>
                    <strong>Quick rule:</strong> {result.quick}
                  </p>
                ) : (
                  result.snippet !== undefined && <p>{result.snippet}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {library.state === 'reference' && library.reason !== undefined && (
        <p role="note" data-testid="rules-reference">
          {REFERENCE_REASON_TEXT[library.reason]}{' '}
          {library.externalDocumentation !== undefined && (
            <ExternalLink href={library.externalDocumentation} name={library.name} />
          )}
        </p>
      )}
      {library.state === 'empty' && (
        <p role="note" data-testid="rules-reference">
          {library.name} declares no rules sections.{' '}
          {library.externalDocumentation !== undefined && (
            <ExternalLink href={library.externalDocumentation} name={library.name} />
          )}
        </p>
      )}
      {selected !== undefined && (
        <SectionView
          library={library}
          section={selected}
          onSelect={onSelect}
          {...(marks === undefined
            ? {}
            : {
                bookmarked: marks.bookmarks.includes(selected.id),
                onBookmark: (on: boolean) => marks.onBookmark(selected.id, on),
              })}
        />
      )}
      {marks !== undefined && (
        <>
          <SectionList
            label="Bookmarks"
            ids={marks.bookmarks}
            library={library}
            onSelect={onSelect}
            empty="No bookmarks yet."
          />
          <SectionList
            label="Recently viewed"
            ids={marks.recent}
            library={library}
            onSelect={onSelect}
            empty="Nothing viewed yet."
          />
        </>
      )}
      {library.groups.length > 0 && (
        <nav aria-label="Rules contents">
          {library.groups.map((group) => (
            <div key={group.category}>
              <h3>{group.label}</h3>
              <ul>
                {group.sections.map((section) => (
                  <li key={section.id}>
                    <button
                      type="button"
                      aria-current={section.id === selected?.id ? 'true' : undefined}
                      onClick={() => onSelect(section.id)}
                    >
                      {section.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      )}
      <footer data-testid="rules-attribution">
        <small>
          {library.attribution.license}. {library.attribution.attribution}{' '}
          <a href={library.attribution.source} target="_blank" rel="noreferrer">
            Source
          </a>
        </small>
      </footer>
    </section>
  );
}

const WAITING: PinnedRules = { status: 'waiting' };

function sectionIds(records: readonly RulesMarkRecord[]): string[] {
  return records.map((record) => record.sectionId);
}

/** The campaign's library over the device replica (FR-003): the pinned rules and the user's own marks. */
export function RulesLibrary(props: { readonly source: RulesSource }) {
  const { source } = props;
  const [pinned, setPinned] = useState<PinnedRules>(WAITING);
  const [bookmarks, setBookmarks] = useState<readonly string[]>([]);
  const [recent, setRecent] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const region = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [next, marked, viewed] = await Promise.all([
        source.pinned(),
        source.marks.bookmarks(),
        source.marks.recent(),
      ]);
      if (cancelled) return;
      setPinned(next);
      setBookmarks(sectionIds(marked));
      setRecent(sectionIds(viewed));
    };
    void load();
    const unsubscribe = source.subscribe(() => void load());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source]);

  const select = useCallback(
    (id: string) => {
      setSelected(id);
      void source.marks.viewed(id).then((result) => {
        if (!result.ok) setError('The view could not be recorded on this device.');
      });
    },
    [source],
  );

  // Feature 20 D-10: a search result or palette entry naming a section opens it here.
  const target = useRouteTarget(RULES_ROUTE);
  useEffect(() => {
    if (target === undefined) return;
    select(target.id);
    region.current?.scrollIntoView?.({ block: 'start' });
  }, [target, select]);

  const marks: RulesMarksView = {
    bookmarks,
    recent,
    onBookmark: (sectionId, on) =>
      void source.marks.bookmark(sectionId, on).then((result) => {
        if (!result.ok) setError('The bookmark could not be saved on this device.');
      }),
  };

  return (
    <div ref={region} data-rules-loaded={pinned.status === 'waiting' ? 'false' : 'true'}>
      {pinned.status === 'waiting' && (
        <section aria-label="Rules library">
          <h2>Rules</h2>
          <p role="status">Waiting for the campaign's pinned system to reach this device.</p>
        </section>
      )}
      {pinned.status === 'not_installed' && (
        <section aria-label="Rules library">
          <h2>Rules</h2>
          <p role="note">
            The pinned rules, {pinned.ref.systemId} {pinned.ref.version}, are not installed in this
            version of the app.
          </p>
        </section>
      )}
      {pinned.status === 'ready' && (
        <RulesView
          library={pinned.library}
          label="Rules library"
          onSelect={select}
          marks={marks}
          {...(selected === undefined ? {} : { selected })}
        />
      )}
      {error !== undefined && <p role="alert">{error}</p>}
    </div>
  );
}

/** FR-008: an installed system's rules before a campaign exists; no marks, the selection unchanged. */
export function RulesPreview(props: {
  readonly system: SystemPackage;
  readonly onClose: () => void;
}) {
  const library = useMemo(() => rulesLibrary(props.system), [props.system]);
  const [selected, setSelected] = useState<string>();
  return (
    <div>
      <RulesView
        library={library}
        label={`Rules preview: ${library.name}`}
        onSelect={setSelected}
        {...(selected === undefined ? {} : { selected })}
      />
      <button type="button" onClick={props.onClose}>
        Close rules preview
      </button>
    </div>
  );
}
