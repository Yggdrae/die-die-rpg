import { describe, expect, test } from 'bun:test';
import {
  CONTENT_CONFIGURATION,
  defineContentConfiguration,
  ENTITY_TYPES,
  type EntityRecord,
  type PersonalNoteRecord,
  QUICK_CREATE_ENTRY_POINTS,
  RELATIONSHIP_KINDS,
} from '@rpg/content';
import { renderToStaticMarkup } from 'react-dom/server';
import { relationshipViews } from './content-model.ts';
import type { ContentSource } from './content-source.ts';
import { EntityEditor } from './EntityEditor.tsx';
import {
  EntityDetailView,
  EntityFiltersView,
  EntityListView,
  PersonalNoteView,
  QuickCreateForm,
  RelationshipListView,
} from './EntityViews.tsx';

/** Feature 16 tasks 11–13 static markup (react-dom/server; no DOM library in this repo). */

const CAMPAIGN = '00000000-0000-4000-8000-0000000016c1';
const GM = '00000000-0000-4000-8000-0000000016a1';

function entity(overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: '00000000-0000-4000-8000-0000000016d1',
    campaignId: CAMPAIGN,
    type: 'npc',
    name: 'Smuggler',
    tags: ['antagonist'],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: '2026-10-29T10:00:00Z',
    createdBy: GM,
    updatedAt: '2026-10-29T10:00:00Z',
    updatedBy: GM,
    summary: 'Runs the night ferry',
    description: '',
    fields: {},
    ...overrides,
  };
}

const noop = () => {};

describe('a test-local extra type renders with no component change (ADR-001)', () => {
  const config = defineContentConfiguration({
    types: [
      ...ENTITY_TYPES,
      {
        id: 'vehicle',
        label: 'Vehicle',
        pluralLabel: 'Vehicles',
        quickCreate: { secondField: 'summary' },
        enabled: true,
      },
    ],
    kinds: RELATIONSHIP_KINDS,
  });
  const cart = entity({ type: 'vehicle', name: 'Supply Cart', tags: ['caravan'] });

  test('list, filter, and detail use the configured labels', () => {
    const list = renderToStaticMarkup(
      <EntityListView records={[cart]} total={1} onSelect={noop} config={config} />,
    );
    expect(list).toContain('Supply Cart');
    expect(list).toContain('Vehicle · GM only');
    const filters = renderToStaticMarkup(
      <EntityFiltersView
        filter={{ type: 'vehicle' }}
        tags={['caravan']}
        visibilityModes={['gm_only']}
        onChange={noop}
        config={config}
      />,
    );
    expect(filters).toContain('<option value="vehicle" selected="">Vehicles</option>');
    const detail = renderToStaticMarkup(<EntityDetailView record={cart} config={config} />);
    expect(detail).toContain('<span data-testid="entity-type">Vehicle</span>');
    // Without the configuration entry the stored id is shown, still on the same screen.
    expect(renderToStaticMarkup(<EntityDetailView record={cart} />)).toContain(
      '<span data-testid="entity-type">vehicle</span>',
    );
  });
});

describe('detail (D-10: description is escaped plain text)', () => {
  test('a description with <script> or Markdown renders as literal text with line breaks', () => {
    const description = '# Secrets\n<script>alert("x")</script>\n**bold** [link](javascript:x)';
    const html = renderToStaticMarkup(
      <EntityDetailView record={entity({ description, fields: { 'True name': '<b>V</b>' } })} />,
    );
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<h1>');
    expect(html).not.toContain('href=');
    expect(html).toContain('# Secrets\n&lt;script&gt;');
    expect(html).toContain('white-space:pre-wrap');
    expect(html).toContain('&lt;b&gt;V&lt;/b&gt;');
  });

  test('summary, tags, custom fields, and audience are shown', () => {
    const html = renderToStaticMarkup(
      <EntityDetailView
        record={entity({
          fields: { Price: '20 gp' },
          visibility: { mode: 'players', playerIds: [GM] },
        })}
      />,
    );
    expect(html).toContain('Runs the night ferry');
    expect(html).toContain('<li>antagonist</li>');
    expect(html).toContain('<dt>Price</dt><dd>20 gp</dd>');
    expect(html).toContain('Selected players');
    expect(html).toContain('No description.');
  });

  test('custom fields are listed sorted by label', () => {
    const html = renderToStaticMarkup(
      <EntityDetailView record={entity({ fields: { price: '20 gp', Allegiance: 'Guild' } })} />,
    );
    expect(html.indexOf('<dt>Allegiance</dt>')).toBeLessThan(html.indexOf('<dt>price</dt>'));
  });
});

describe('custom fields editor (D-01): the same rows for every type', () => {
  const source = {} as ContentSource;

  test('every configured type gets the same field rows with no type configuration read', () => {
    const markups = ENTITY_TYPES.map((definition) =>
      renderToStaticMarkup(
        <EntityEditor
          source={source}
          record={entity({ type: definition.id, fields: { price: '1', Allegiance: 'Guild' } })}
          visibleRecords={[]}
          onDone={noop}
        />,
      ),
    );
    const fieldset = (html: string) =>
      html.slice(html.indexOf('<fieldset'), html.indexOf('</fieldset>'));
    for (const html of markups) {
      expect(fieldset(html)).toBe(fieldset(markups[0] ?? ''));
      expect(html).toContain('<legend>Custom fields</legend>');
      expect(html).toContain('Add field</button>');
    }
    const first = fieldset(markups[0] ?? '');
    expect(first.indexOf('value="Allegiance"')).toBeLessThan(first.indexOf('value="price"'));
    expect(first).toContain('value="Guild"');
    expect(first).toContain('aria-label="Remove field 2"');
    // A type outside the configuration (removed, or added later) renders the same rows.
    const unknown = renderToStaticMarkup(
      <EntityEditor
        source={source}
        record={entity({ type: 'vehicle', fields: { price: '1', Allegiance: 'Guild' } })}
        visibleRecords={[]}
        onDone={noop}
      />,
    );
    expect(fieldset(unknown)).toBe(first);
  });
});

describe('quick create (FR-005, D-09)', () => {
  test('one focused name input; the summary is optional; type comes from the entry point', () => {
    const npc = QUICK_CREATE_ENTRY_POINTS[0];
    const html = renderToStaticMarkup(
      <QuickCreateForm
        {...(npc === undefined ? {} : { entry: npc })}
        onSave={async () => undefined}
        onCancel={noop}
      />,
    );
    expect(html).toContain('aria-label="Add NPC"');
    expect(html).toContain('data-quick-create-type="npc"');
    expect(html.match(/autofocus/gi)).toHaveLength(1);
    expect(html).not.toContain('required');
    expect(html).not.toContain('<select');
    expect(html).toContain('Summary (optional)');
  });

  test('a generic entry point creates the default type', () => {
    const html = renderToStaticMarkup(
      <QuickCreateForm onSave={async () => undefined} onCancel={noop} />,
    );
    expect(html).toContain(
      `data-quick-create-type="${CONTENT_CONFIGURATION.defaultQuickCreateType}"`,
    );
    expect(html).toContain('New Note');
  });
});

describe('personal notes (D-15): no Visibility controls, no attachments, no links', () => {
  test('the note view renders title and body only', () => {
    const note: PersonalNoteRecord = {
      ...entity({ type: 'note', name: 'My suspicions' }),
      authorUserId: GM,
      body: 'The ferryman <lies>',
      visibility: { mode: 'players', playerIds: [GM] },
    } as PersonalNoteRecord;
    const html = renderToStaticMarkup(<PersonalNoteView note={note} />);
    expect(html).toContain('My suspicions');
    expect(html).toContain('The ferryman &lt;lies&gt;');
    for (const absent of ['Visibility', 'Reveal', 'Attach', 'Links', 'Hide']) {
      expect(html).not.toContain(absent);
    }
  });
});

describe('links (task 13)', () => {
  test('a deleted endpoint renders as a deleted entity and the link remains', () => {
    const source = entity({ id: '00000000-0000-4000-8000-0000000016e1', name: 'Village' });
    const guard = entity({
      id: '00000000-0000-4000-8000-0000000016e2',
      name: 'Guard',
      deletedAt: '2026-10-29T12:00:00Z',
    });
    const rows = relationshipViews(
      [
        {
          id: '00000000-0000-4000-8000-0000000016f1',
          campaignId: CAMPAIGN,
          type: 'relationship',
          name: 'lives at',
          tags: [],
          metadata: {},
          visibility: { mode: 'gm_only' },
          version: 1,
          createdAt: source.createdAt,
          createdBy: GM,
          updatedAt: source.updatedAt,
          updatedBy: GM,
          sourceEntityId: guard.id,
          targetEntityId: source.id,
          kind: 'lives_at',
        },
      ],
      source.id,
      new Map([
        [source.id, source],
        [guard.id, guard],
      ]),
    );
    const html = renderToStaticMarkup(<RelationshipListView rows={rows} />);
    expect(html).toContain('has resident');
    expect(html).toContain('Deleted entity');
    expect(html).not.toContain('Guard');
    expect(renderToStaticMarkup(<RelationshipListView rows={[]} />)).toContain('No links.');
  });
});
