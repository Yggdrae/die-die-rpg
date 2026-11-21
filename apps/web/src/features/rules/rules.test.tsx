import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryRepository } from '@rpg/contracts/testing';
import { FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import { INSTALLED_SYSTEM_PACKAGES } from '@rpg/installed-systems';
import {
  REFERENCE_REASON_TEXT,
  RulesMarkLocalRepository,
  type RulesMarkRecord,
  rulesLibrary,
} from '@rpg/rules';
import type { SystemPackage } from '@rpg/systems';
import { renderToStaticMarkup } from 'react-dom/server';
import { RulesLibrary, RulesPreview, RulesView } from './RulesLibrary.tsx';
import type { RulesSource } from './rules-source.ts';
import { RULES_ROUTE, rulesSearchContribution } from './search-contribution.ts';

/** Feature 14 static markup (react-dom/server; no DOM library in this repo) and the search contribution. */

const CAMPAIGN = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const ALL: readonly SystemPackage[] = [
  FIXTURE_SYSTEM_PACKAGE,
  ...(INSTALLED_SYSTEM_PACKAGES as readonly SystemPackage[]),
];
// Packages are picked by what they declare, never by id (guard `no-system-identity`).
const INTEGRATED = ALL.find((system) =>
  system.capabilities.includes('integrated_rules'),
) as SystemPackage;
const REFERENCE = ALL.find(
  (system) => system.rules.sections.length > 0 && !system.capabilities.includes('integrated_rules'),
) as SystemPackage;

function decode(html: string): string {
  return html
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

const render = (node: Parameters<typeof renderToStaticMarkup>[0]) =>
  decode(renderToStaticMarkup(node));

describe('rules view', () => {
  test('search first, scope stated, the declared tree, attribution always (FR-001, FR-002, FR-013)', () => {
    const library = rulesLibrary(INTEGRATED);
    const html = render(<RulesView library={library} label="Rules library" onSelect={() => {}} />);
    expect(html.indexOf('type="search"')).toBeGreaterThan(-1);
    expect(html.indexOf('type="search"')).toBeLessThan(html.indexOf('<button'));
    expect(html).toContain(
      `Searching ${library.sections.length} sections of ${library.name} ${library.ref.version}, on this device.`,
    );
    expect(html).toContain('data-rules-state="integrated"');
    let at = 0;
    for (const group of library.groups) {
      const next = html.indexOf(`<h3>${group.label}</h3>`, at);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(html).toContain('data-testid="rules-attribution"');
    expect(html).toContain(INTEGRATED.manifest.license.attribution);
    expect(html).toContain(`href="${INTEGRATED.manifest.license.source}"`);
  });

  test('a section opens with its quick rule above its text and its references (FR-004, FR-007)', () => {
    const library = rulesLibrary(INTEGRATED);
    const section = library.sections.find(
      (item) => item.summary !== undefined && item.references.length > 0,
    );
    if (section === undefined) throw new Error('the integrated package declares a quick rule');
    const html = render(
      <RulesView
        library={library}
        label="Rules library"
        selected={section.id}
        onSelect={() => {}}
        marks={{ bookmarks: [section.id], recent: [section.id], onBookmark: () => {} }}
      />,
    );
    expect(html).toContain(`aria-label="Rule: ${section.title}"`);
    expect(html.indexOf('aria-label="Quick rule"')).toBeLessThan(
      html.indexOf('data-testid="rule-text"'),
    );
    expect(html).toContain(section.summary as string);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Remove bookmark');
    expect(html).toContain('aria-label="See also"');
    for (const reference of section.references) expect(html).toContain(reference.title);
    expect(html).toContain('aria-label="Bookmarks"');
    expect(html).toContain('aria-label="Recently viewed"');
  });

  test('results list the quick rule first, with their category (D-05, D-06)', () => {
    const library = rulesLibrary(INTEGRATED);
    const quick = library.sections.find((item) => item.summary !== undefined);
    if (quick === undefined) throw new Error('quick rule');
    const query = quick.title.slice(0, 4);
    const html = render(
      <RulesView
        library={library}
        label="Rules library"
        onSelect={() => {}}
        initialQuery={query}
      />,
    );
    const list = html.slice(html.indexOf('aria-label="Rules results"'));
    expect(list.indexOf(quick.title)).toBeLessThan(list.indexOf('</li>'));
    expect(list).toContain(`<strong>Quick rule:</strong> ${quick.summary}`);
    expect(list).toContain(quick.categoryLabel);
    expect(html).toContain('data-testid="rules-result-count"');
  });

  test('a package with no text says why and links the external documentation (FR-010)', () => {
    const library = rulesLibrary(REFERENCE);
    const first = library.sections[0];
    const html = render(
      <RulesView
        library={library}
        label="Rules library"
        onSelect={() => {}}
        {...(first === undefined ? {} : { selected: first.id })}
      />,
    );
    expect(html).toContain('data-rules-state="reference"');
    expect(html).toContain(REFERENCE_REASON_TEXT[library.reason ?? 'not_integrated']);
    expect(html).toContain(`href="${REFERENCE.manifest.integration.externalDocumentation}"`);
    expect(html).toContain("This section's text is not included in the app.");
    expect(html).not.toContain('data-testid="rule-text"');
    for (const section of library.sections) expect(html).toContain(section.title);
  });

  test('forbidden text present in a package is never rendered (D-04)', () => {
    const forbidden = structuredClone(INTEGRATED) as SystemPackage & {
      manifest: { license: { assets: { rulesText: string } } };
    };
    forbidden.manifest.license.assets.rulesText = 'forbidden';
    const library = rulesLibrary(forbidden as SystemPackage);
    const html = render(
      <RulesView
        library={library}
        label="Rules library"
        onSelect={() => {}}
        selected={library.sections[0]?.id as string}
        initialQuery={library.sections[0]?.title.slice(0, 3) as string}
      />,
    );
    expect(html).toContain(REFERENCE_REASON_TEXT.forbidden);
    for (const section of INTEGRATED.rules.sections) {
      if (section.body !== undefined) expect(html).not.toContain(section.body);
      if (section.summary !== undefined) expect(html).not.toContain(section.summary);
    }
  });

  test('an empty declaration is stated, not blank', () => {
    const empty = { ...INTEGRATED, rules: { sections: [] } };
    const html = render(
      <RulesView library={rulesLibrary(empty)} label="Rules library" onSelect={() => {}} />,
    );
    expect(html).toContain('data-rules-state="empty"');
    expect(html).toContain('declares no rules sections');
  });

  test('the preview has no marks (FR-008); the campaign library waits for the pin', () => {
    const preview = render(<RulesPreview system={REFERENCE} onClose={() => {}} />);
    expect(preview).toContain(`aria-label="Rules preview: ${REFERENCE.manifest.name}"`);
    expect(preview).not.toContain('aria-label="Bookmarks"');
    expect(preview).toContain('Close rules preview');
    const source: RulesSource = {
      userId: USER,
      campaignId: CAMPAIGN,
      pinned: async () => ({ status: 'waiting' }),
      marks: new RulesMarkLocalRepository(new InMemoryRepository<RulesMarkRecord>(), {
        userId: USER,
        campaignId: CAMPAIGN,
      }),
      subscribe: () => () => undefined,
    };
    const waiting = render(<RulesLibrary source={source} />);
    expect(waiting).toContain('data-rules-loaded="false"');
    expect(waiting).toContain("Waiting for the campaign's pinned system");
  });
});

describe('search contribution (D-15)', () => {
  test('one Rule document per pinned section, routed to the library', async () => {
    const library = rulesLibrary(INTEGRATED);
    const contribution = rulesSearchContribution({
      pinned: async () => ({ status: 'ready', library }),
      subscribe: () => () => undefined,
    });
    const docs = await contribution.indexer.index(CAMPAIGN);
    expect(docs.map((doc) => doc.title)).toEqual(library.sections.map((section) => section.title));
    expect(contribution.typeLabel()).toBe('Rule');
    const [first] = docs;
    if (first === undefined) throw new Error('docs');
    expect(contribution.route(first)).toBe(`#/${RULES_ROUTE}/${first.id}`);
    const waiting = rulesSearchContribution({
      pinned: async () => ({ status: 'waiting' }),
      subscribe: () => () => undefined,
    });
    expect(await waiting.indexer.index(CAMPAIGN)).toEqual([]);
  });
});

describe('architecture', () => {
  test('imports no other web feature and names no system (PRD.md s.89)', () => {
    const dir = import.meta.dir;
    for (const file of readdirSync(dir).filter(
      (name) => /\.tsx?$/.test(name) && !name.includes('.test.') && !name.includes('e2e-harness'),
    )) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect([file, /from '\.\.\/(?!\.\.\/)[a-z-]+\//.test(text)]).toEqual([file, false]);
      expect([file, /cairn|fate/i.test(text)]).toEqual([file, false]);
    }
  });
});
