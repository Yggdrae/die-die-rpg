import { describe, expect, test } from 'bun:test';
import {
  check,
  type ExportChunk,
  type ImportContext,
  type ImportTransaction,
  type Visibility,
} from '@rpg/contracts';
import {
  ContentChunk,
  ContentExporter,
  type ContentExportSource,
  type ContentRestorePlan,
  ContentSearchIndexer,
  countContentRecords,
} from './contributors.ts';
import type { EntityRecord, RelationshipRecord } from './schemas.ts';

/**
 * Task 15 unit checks without a database: order independence (byte-identical reads), tombstone
 * selection, chunk schema, and search bodies. The PostgreSQL run over the sandbox campaign is
 * `apps/api/src/modules/portability/content-contributor.integration.test.ts`.
 */

const CAMPAIGN = '00000000-0000-4000-8000-0000000015c1';
const GM = '00000000-0000-4000-8000-0000000015a1';
const AT = '2026-10-30T10:00:00.000Z';
const id = (suffix: string) => `00000000-0000-4000-8000-0000000015${suffix}`;

function entity(suffix: string, overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: id(suffix),
    campaignId: CAMPAIGN,
    type: 'npc',
    name: `Entity ${suffix}`,
    tags: [],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: AT,
    createdBy: GM,
    updatedAt: AT,
    updatedBy: GM,
    summary: '',
    description: '',
    fields: {},
    ...overrides,
  };
}

function link(suffix: string, source: string, target: string, deleted = false): RelationshipRecord {
  return {
    id: id(suffix),
    campaignId: CAMPAIGN,
    type: 'relationship',
    name: 'knows',
    tags: [],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: AT,
    createdBy: GM,
    updatedAt: AT,
    updatedBy: GM,
    sourceEntityId: id(source),
    targetEntityId: id(target),
    kind: 'knows',
    ...(deleted ? { deletedAt: AT } : {}),
  };
}

function source(
  entities: readonly EntityRecord[],
  links: readonly RelationshipRecord[],
): ContentExportSource {
  return {
    entities: {
      list: async (_campaign, filter) =>
        filter?.includeDeleted === true
          ? entities
          : entities.filter((row) => row.deletedAt === undefined),
    },
    relationships: { list: async () => links.filter((row) => row.deletedAt === undefined) },
  };
}

const ENTITIES = [
  entity('e2', { fields: { b: '2', a: '1' } }),
  entity('e1', { summary: 'One line', description: '# Heading' }),
  entity('e3', { deletedAt: AT, version: 2 }),
  entity('e4', { deletedAt: AT, version: 2 }),
];
const LINKS = [link('f2', 'e1', 'e3'), link('f1', 'e1', 'e2'), link('f3', 'e2', 'e4', true)];

describe('ContentExporter (task 15)', () => {
  test('input order never changes the bytes; only referenced tombstones are kept', async () => {
    const forward = await new ContentExporter(source(ENTITIES, LINKS)).export(CAMPAIGN);
    const reversed = await new ContentExporter(
      source([...ENTITIES].reverse(), [...LINKS].reverse()),
    ).export(CAMPAIGN);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(check(ContentChunk, forward.payload)).toBe(true);
    const payload = forward.payload as ContentChunk;
    expect(payload.entities.map((row) => [row.id, row.deleted])).toEqual([
      [id('e1'), false],
      [id('e2'), false],
      [id('e3'), true],
    ]);
    expect(payload.relationships.map((row) => row.id)).toEqual([id('f1'), id('f2')]);
    expect(payload.entities[1]?.fields).toEqual([
      { label: 'a', value: '1' },
      { label: 'b', value: '2' },
    ]);
    expect(countContentRecords(payload)).toBe(5);
    expect(JSON.stringify(payload)).not.toContain(GM);
  });

  test('the frozen import answers with safe codes and never restores', async () => {
    const exporter = new ContentExporter(source(ENTITIES, LINKS));
    const own = await exporter.export(CAMPAIGN);
    expect(await exporter.import(CAMPAIGN, own)).toEqual({
      ok: false,
      error: 'content_import_unsupported',
    });
    expect(await exporter.import(CAMPAIGN, { ...own, payload: { x: 1 } })).toEqual({
      ok: false,
      error: 'content_chunk_invalid',
    });
  });
});

describe('ContentSearchIndexer (task 15, D-13)', () => {
  test('live entities only; body joins summary and description source', async () => {
    const docs = await new ContentSearchIndexer(source(ENTITIES, LINKS)).index(CAMPAIGN);
    expect(docs.map((doc) => [doc.id, doc.title, doc.body])).toEqual([
      [id('e1'), 'Entity e1', 'One line\n\n# Heading'],
      [id('e2'), 'Entity e2', ''],
    ]);
  });
});

describe('ContentExporter as ImportableModule (task 17, B-5)', () => {
  const A = '00000000-0000-4000-8000-00000000a0a1';
  const B = '00000000-0000-4000-8000-00000000a0b2';
  const IMPORTER = '00000000-0000-4000-8000-00000000a0ff';
  const NEW_CAMPAIGN = '00000000-0000-4000-8000-00000000c0c1';
  const transaction = { brand: 'ImportTransaction' } as ImportTransaction;

  function harness(failWith?: string) {
    const plans: { handle: unknown; plan: ContentRestorePlan }[] = [];
    const exporter = new ContentExporter(source([], []), {
      writer: {
        restoreWithin: async (handle, plan) => {
          plans.push({ handle, plan });
          return failWith === undefined
            ? { ok: true, value: undefined }
            : { ok: false, error: failWith };
        },
      },
      unwrap: (tx) => ({ unwrapped: tx }),
    });
    return { exporter, plans };
  }

  /** `new-<kind>-<id>` as a UUID-shaped id; only member A is mapped (to the importer). */
  const context: ImportContext = {
    campaignId: NEW_CAMPAIGN,
    importerUserId: IMPORTER,
    transaction,
    mapId: (kind, sourceId) => {
      if (kind === 'member') return sourceId === A ? IMPORTER : undefined;
      if (kind !== 'campaign_entity' && kind !== 'entity_relationship') return undefined;
      return `${kind === 'campaign_entity' ? '1' : '2'}${sourceId.slice(1)}`;
    },
  };

  async function chunkOf(
    entities: EntityRecord[],
    links: RelationshipRecord[],
  ): Promise<ExportChunk> {
    return new ContentExporter(source(entities, links)).export(CAMPAIGN);
  }

  test('validate defines Resource Class kinds, writes nothing; invalid chunks get safe codes', async () => {
    const { exporter, plans } = harness();
    const own = await chunkOf(ENTITIES, LINKS);
    const validated = await exporter.validate(own);
    expect(validated).toEqual({
      ok: true,
      value: {
        defines: [
          { kind: 'campaign_entity', sourceId: id('e1') },
          { kind: 'campaign_entity', sourceId: id('e2') },
          { kind: 'campaign_entity', sourceId: id('e3') },
          { kind: 'entity_relationship', sourceId: id('f1') },
          { kind: 'entity_relationship', sourceId: id('f2') },
        ],
        warnings: [],
      },
    });
    const payload = own.payload as ContentChunk;
    const first = payload.entities[0] as ContentChunk['entities'][number];
    const link = payload.relationships[0] as ContentChunk['relationships'][number];
    const variants: [unknown, string][] = [
      [{ ...payload, entities: [{ ...first, name: '  ' }] }, 'content_entity_invalid'],
      [
        {
          ...payload,
          entities: [
            {
              ...first,
              fields: [
                { label: 'Price', value: '1' },
                { label: 'price', value: '2' },
              ],
            },
          ],
          relationships: [],
        },
        'content_entity_invalid',
      ],
      [{ ...payload, entities: [{ ...first, tags: ['t'.repeat(65)] }] }, 'content_entity_invalid'],
      [{ ...payload, entities: [{ ...first, deleted: true }] }, 'content_entity_invalid'],
      [{ ...payload, entities: [first, first] }, 'content_chunk_invalid'],
      [{ ...payload, relationships: [{ ...link, kind: 'loves' }] }, 'content_relationship_invalid'],
      [
        { ...payload, relationships: [{ ...link, targetEntityId: link.sourceEntityId }] },
        'content_relationship_invalid',
      ],
      [
        { ...payload, relationships: [{ ...link, targetEntityId: id('e9') }] },
        'content_relationship_invalid',
      ],
      [
        { ...payload, relationships: [link, { ...link, id: id('f9') }] },
        'content_relationship_invalid',
      ],
      [{ ...payload, extra: true }, 'content_chunk_invalid'],
    ];
    for (const [variant, code] of variants) {
      expect(await exporter.validate({ ...own, payload: variant })).toEqual({
        ok: false,
        error: code,
      });
    }
    expect(await exporter.validate({ ...own, chunkVersion: '2' })).toEqual({
      ok: false,
      error: 'content_chunk_invalid',
    });
    expect(plans).toHaveLength(0);
  });

  test('restore remaps ids, narrows unmapped targets, clamps links to endpoints, never widens', async () => {
    const { exporter, plans } = harness();
    const both: Visibility = { mode: 'players', playerIds: [A, B] };
    const onlyA: Visibility = { mode: 'players', playerIds: [A] };
    const chunk = await chunkOf(
      [
        entity('e1', { visibility: both }),
        entity('e2', { visibility: { mode: 'everyone' } }),
        entity('e3', { visibility: onlyA, deletedAt: AT, version: 2 }),
      ],
      [
        { ...link('f1', 'e1', 'e2'), visibility: onlyA },
        { ...link('f2', 'e3', 'e2'), visibility: onlyA },
        { ...link('f3', 'e2', 'e3'), visibility: { mode: 'gm_only' }, kind: 'owns' },
      ],
    );
    const restored = await exporter.restore(chunk, context);
    expect(restored).toEqual({
      ok: true,
      value: {
        restoredCount: 6,
        warnings: [
          { code: 'visibility_narrowed_to_gm_only', sourceId: id('e1') },
          // Its own target is mapped, but endpoint e1 narrowed: the D-07 bound clamps it.
          { code: 'visibility_narrowed_to_gm_only', sourceId: id('f1') },
        ],
      },
    });
    const [{ handle, plan } = { handle: undefined, plan: undefined }] = plans;
    expect(handle).toEqual({ unwrapped: transaction });
    expect(plan?.campaignId).toBe(NEW_CAMPAIGN);
    expect(plan?.actorUserId).toBe(IMPORTER);
    const mapped = (kind: string, suffix: string) => context.mapId(kind, id(suffix));
    expect(plan?.entities.map((row) => [row.id, row.visibility, row.deleted])).toEqual([
      [mapped('campaign_entity', 'e1'), { mode: 'gm_only' }, false],
      [mapped('campaign_entity', 'e2'), { mode: 'everyone' }, false],
      [mapped('campaign_entity', 'e3'), { mode: 'players', playerIds: [IMPORTER] }, true],
    ] as never);
    expect(
      plan?.relationships.map((row) => [
        row.id,
        row.sourceEntityId,
        row.targetEntityId,
        row.visibility,
      ]),
    ).toEqual([
      [
        mapped('entity_relationship', 'f1'),
        mapped('campaign_entity', 'e1'),
        mapped('campaign_entity', 'e2'),
        { mode: 'gm_only' },
      ],
      [
        mapped('entity_relationship', 'f2'),
        mapped('campaign_entity', 'e3'),
        mapped('campaign_entity', 'e2'),
        { mode: 'players', playerIds: [IMPORTER] },
      ],
      [
        mapped('entity_relationship', 'f3'),
        mapped('campaign_entity', 'e2'),
        mapped('campaign_entity', 'e3'),
        { mode: 'gm_only' },
      ],
    ] as never);
    // No `everyone` produced from a `players` target.
    for (const row of [...(plan?.entities ?? []), ...(plan?.relationships ?? [])]) {
      if (row.visibility.mode === 'everyone') {
        expect(row.id).toBe(mapped('campaign_entity', 'e2') ?? '');
      }
    }
  });

  test('a writer failure, an unmapped id, or a missing writer are safe errors', async () => {
    const chunk = await chunkOf(ENTITIES, LINKS);
    expect(await harness('content_restore_conflict').exporter.restore(chunk, context)).toEqual({
      ok: false,
      error: 'content_restore_conflict',
    });
    const { exporter, plans } = harness();
    expect(await exporter.restore(chunk, { ...context, mapId: () => undefined })).toEqual({
      ok: false,
      error: 'content_id_unmapped',
    });
    expect(plans).toHaveLength(0);
    expect(await new ContentExporter(source([], [])).restore(chunk, context)).toEqual({
      ok: false,
      error: 'content_import_unavailable',
    });
  });
});
