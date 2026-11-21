import { VISIBILITY_NARROWED_ON_IMPORT, visibilityForImport } from '@rpg/authorization';
import {
  check,
  type ExportableModule,
  type ExportChunk,
  err,
  Id,
  type Id as IdValue,
  type ImportableModule,
  type ImportContext,
  type ImportPlanContribution,
  type ImportResult,
  type ImportTransaction,
  type ImportWarning,
  Metadata,
  ok,
  type Result,
  type SearchDoc,
  type SearchIndexer,
  Timestamp,
  Version,
  Visibility,
} from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import {
  checkEntityType,
  checkLongText,
  checkRelationshipKind,
  checkSummary,
  intersectVisibility,
  normalizeCustomFields,
  normalizeName,
  normalizeTags,
} from './domain.ts';
import { CAMPAIGN_ENTITY_CLASS, ENTITY_RELATIONSHIP_CLASS } from './policies.ts';
import type { EntityRecord, RelationshipRecord } from './schemas.ts';
import { CONTENT_CONFIGURATION, type ContentConfiguration } from './types.ts';

/**
 * Feature 16 registry contributors (FR-015, `_techspec.md` D-10/D-12/D-13, task 15).
 *
 * `ContentExporter` writes one `entities/content.json` chunk for feature 07: every live entity,
 * the tombstoned entities a live relationship still references (flagged `deleted`, so broken
 * links keep resolving), and every live relationship, each with its frozen Visibility exactly as
 * stored. Rows are ordered by id and carry no actor ids, so two reads of unchanged data are
 * byte-identical (feature 07 online export compares two canonical checksums). Personal notes are
 * never read (D-12). Custom fields travel as `{ label, value }` pairs: a free-form label is a
 * value in the package, never an object key, so a label can never collide with the package
 * forbidden-key scan.
 *
 * Import (task 17, contract note 2026-10-27 ratified): `ContentExporter` is also the module's
 * `ImportableModule`. `validate` applies the same rules as a write (D-01, D-11, D-18, configured
 * relationship kinds, endpoints present, no self or duplicate live link) and writes nothing.
 * `restore` remaps every id with `mapId` (kinds `campaign_entity` / `entity_relationship`, the
 * Resource Class names feature 05 uses for attachment owners), restores Visibility through feature
 * 04 `visibilityForImport` (an unmapped `players` target narrows to `gm_only` with a warning, never
 * widens), clamps each relationship to its imported endpoints (D-07 bound), keeps tombstoned
 * endpoints as broken links, and writes only through `context.transaction` via the writer the
 * composition root supplies. It records nothing else.
 *
 * `ContentSearchIndexer` produces one `SearchDoc` per live entity for feature 20 (absent today):
 * title = name, body = summary and description Markdown source (D-10), the entity type, and the
 * stored Visibility so the host filters at query time. No personal notes (D-13), no relationships.
 */

export const CONTENT_MODULE_ID = 'content';
export const CONTENT_CHUNK_VERSION = '1';
export const CONTENT_IMPORT_UNSUPPORTED = 'content_import_unsupported';
export const CONTENT_CHUNK_INVALID = 'content_chunk_invalid';
export const CONTENT_ENTITY_INVALID = 'content_entity_invalid';
export const CONTENT_RELATIONSHIP_INVALID = 'content_relationship_invalid';
export const CONTENT_ID_UNMAPPED = 'content_id_unmapped';
export const CONTENT_IMPORT_UNAVAILABLE = 'content_import_unavailable';

const ContentToken = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' });

export const ContentChunkField = Type.Object(
  { label: Type.String({ minLength: 1 }), value: Type.String() },
  { additionalProperties: false },
);

export const ContentChunkEntity = Type.Object(
  {
    id: Id,
    type: ContentToken,
    name: Type.String({ minLength: 1 }),
    summary: Type.String(),
    description: Type.String(),
    tags: Type.Array(Type.String()),
    fields: Type.Array(ContentChunkField),
    metadata: Type.Record(Type.String(), Type.Unknown()),
    visibility: Visibility,
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    /** True only for a tombstone kept because a live relationship references it. */
    deleted: Type.Boolean(),
    deletedAt: Type.Optional(Timestamp),
  },
  { additionalProperties: false },
);
export type ContentChunkEntity = Static<typeof ContentChunkEntity>;

export const ContentChunkRelationship = Type.Object(
  {
    id: Id,
    sourceEntityId: Id,
    targetEntityId: Id,
    kind: ContentToken,
    visibility: Visibility,
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  },
  { additionalProperties: false },
);
export type ContentChunkRelationship = Static<typeof ContentChunkRelationship>;

export const ContentChunk = Type.Object(
  {
    campaignId: Id,
    entities: Type.Array(ContentChunkEntity),
    relationships: Type.Array(ContentChunkRelationship),
  },
  { additionalProperties: false },
);
export type ContentChunk = Static<typeof ContentChunk>;

/** Campaign-scoped reads the contributors need (`PostgresEntityRepository` and relationships). */
export interface ContentExportSource {
  readonly entities: {
    list(
      campaignId: string,
      filter?: { readonly includeDeleted?: boolean },
    ): Promise<readonly EntityRecord[]>;
  };
  readonly relationships: {
    list(
      campaignId: string,
      options?: { readonly includeDeleted?: boolean },
    ): Promise<readonly RelationshipRecord[]>;
  };
}

/** Code-point order of ids: stable across runtimes and locales. */
function byId<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function chunkEntity(record: EntityRecord): ContentChunkEntity {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    summary: record.summary,
    description: record.description,
    tags: [...record.tags],
    fields: Object.entries(record.fields)
      .map(([label, value]) => ({ label, value }))
      .sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0)),
    metadata: { ...record.metadata },
    visibility: record.visibility,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deleted: record.deletedAt !== undefined,
    ...(record.deletedAt === undefined ? {} : { deletedAt: record.deletedAt }),
  };
}

function chunkRelationship(record: RelationshipRecord): ContentChunkRelationship {
  return {
    id: record.id,
    sourceEntityId: record.sourceEntityId,
    targetEntityId: record.targetEntityId,
    kind: record.kind,
    visibility: record.visibility,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Logical record count of a content chunk (feature 07 job summary). */
export function countContentRecords(payload: unknown): number {
  const chunk = payload as Partial<ContentChunk> | undefined;
  return (chunk?.entities?.length ?? 0) + (chunk?.relationships?.length ?? 0);
}

/** One entity to restore: already validated, normalized, and remapped. */
export interface RestoredEntity {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly fields: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly visibility: Visibility;
  readonly deleted: boolean;
}

/** One relationship to restore: endpoints remapped, Visibility within its endpoints. */
export interface RestoredRelationship {
  readonly id: string;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly kind: string;
  readonly visibility: Visibility;
}

export interface ContentRestorePlan {
  readonly campaignId: string;
  readonly actorUserId: string;
  /** Endpoints before the relationships that reference them. */
  readonly entities: readonly RestoredEntity[];
  readonly relationships: readonly RestoredRelationship[];
}

/** Feature 16 persistence on the import transaction handle (`restoreContentWithin`). */
export interface ContentImportWriter {
  restoreWithin(handle: unknown, plan: ContentRestorePlan): Promise<Result<void, string>>;
}

export interface ContentImportDependencies {
  readonly writer: ContentImportWriter;
  /** Composition-root resolver of the opaque import transaction. */
  readonly unwrap: (transaction: ImportTransaction) => unknown;
  readonly config?: ContentConfiguration;
}

type ParsedEntity = Omit<RestoredEntity, 'visibility'> & { readonly stored: Visibility };
type ParsedRelationship = Omit<RestoredRelationship, 'visibility'> & {
  readonly stored: Visibility;
};

/** The write rules over a whole chunk; source ids, nothing remapped. */
function parseContentChunk(
  chunk: ExportChunk,
  config: ContentConfiguration,
): Result<{ entities: ParsedEntity[]; relationships: ParsedRelationship[] }, string> {
  if (
    chunk.moduleId !== CONTENT_MODULE_ID ||
    chunk.chunkVersion !== CONTENT_CHUNK_VERSION ||
    !check(ContentChunk, chunk.payload)
  ) {
    return err(CONTENT_CHUNK_INVALID);
  }
  const entities: ParsedEntity[] = [];
  const ids = new Set<string>();
  for (const row of chunk.payload.entities) {
    if (ids.has(row.id)) return err(CONTENT_CHUNK_INVALID);
    ids.add(row.id);
    // A type removed from configuration keeps its records (existing-type rule).
    const type = checkEntityType(row.type, 'existing', config);
    const name = normalizeName(row.name);
    const summary = checkSummary(row.summary);
    const description = checkLongText(row.description);
    const tags = normalizeTags(row.tags);
    const labels = new Set(row.fields.map((field) => field.label));
    const fields = normalizeCustomFields(
      Object.fromEntries(row.fields.map((field) => [field.label, field.value])),
    );
    if (
      !type.ok ||
      !name.ok ||
      !summary.ok ||
      !description.ok ||
      !tags.ok ||
      !fields.ok ||
      labels.size !== row.fields.length ||
      !check(Metadata, row.metadata) ||
      row.deleted !== (row.deletedAt !== undefined)
    ) {
      return err(CONTENT_ENTITY_INVALID);
    }
    entities.push({
      id: row.id,
      type: row.type,
      name: name.value,
      summary: summary.value,
      description: description.value,
      tags: tags.value,
      fields: fields.value,
      metadata: row.metadata,
      stored: row.visibility,
      deleted: row.deleted,
    });
  }
  const relationships: ParsedRelationship[] = [];
  const links = new Set<string>();
  const live = new Set<string>();
  for (const row of chunk.payload.relationships) {
    const key = `${row.sourceEntityId}\u0000${row.targetEntityId}\u0000${row.kind}`;
    if (
      links.has(row.id) ||
      ids.has(row.id) ||
      live.has(key) ||
      row.sourceEntityId === row.targetEntityId ||
      !ids.has(row.sourceEntityId) ||
      !ids.has(row.targetEntityId) ||
      !checkRelationshipKind(row.kind, config).ok
    ) {
      return err(CONTENT_RELATIONSHIP_INVALID);
    }
    links.add(row.id);
    live.add(key);
    relationships.push({
      id: row.id,
      sourceEntityId: row.sourceEntityId,
      targetEntityId: row.targetEntityId,
      kind: row.kind,
      stored: row.visibility,
    });
  }
  return ok({ entities, relationships });
}

export class ContentExporter implements ExportableModule, ImportableModule {
  readonly moduleId = CONTENT_MODULE_ID;
  readonly importChunkVersions = [CONTENT_CHUNK_VERSION] as const;

  constructor(
    protected readonly source: ContentExportSource,
    private readonly importer?: ContentImportDependencies,
  ) {}

  async export(campaignId: IdValue): Promise<ExportChunk> {
    const [entities, relationships] = await Promise.all([
      this.source.entities.list(campaignId, { includeDeleted: true }),
      this.source.relationships.list(campaignId),
    ]);
    const live = relationships.filter((link) => link.deletedAt === undefined);
    const referenced = new Set(live.flatMap((link) => [link.sourceEntityId, link.targetEntityId]));
    const payload: ContentChunk = {
      campaignId,
      entities: entities
        .filter((record) => record.deletedAt === undefined || referenced.has(record.id))
        .map(chunkEntity)
        .sort(byId),
      relationships: live.map(chunkRelationship).sort(byId),
    };
    return { moduleId: this.moduleId, chunkVersion: CONTENT_CHUNK_VERSION, payload };
  }

  /** Write-free: every rule a restore applies, and the source ids this chunk defines. */
  async validate(chunk: ExportChunk): Promise<Result<ImportPlanContribution, string>> {
    const parsed = parseContentChunk(chunk, this.importer?.config ?? CONTENT_CONFIGURATION);
    if (!parsed.ok) return parsed;
    return ok({
      defines: [
        ...parsed.value.entities.map((row) => ({ kind: CAMPAIGN_ENTITY_CLASS, sourceId: row.id })),
        ...parsed.value.relationships.map((row) => ({
          kind: ENTITY_RELATIONSHIP_CLASS,
          sourceId: row.id,
        })),
      ],
      warnings: [],
    });
  }

  async restore(chunk: ExportChunk, context: ImportContext): Promise<Result<ImportResult, string>> {
    if (this.importer === undefined) return err(CONTENT_IMPORT_UNAVAILABLE);
    const parsed = parseContentChunk(chunk, this.importer.config ?? CONTENT_CONFIGURATION);
    if (!parsed.ok) return parsed;
    const warnings: ImportWarning[] = [];
    const entities: RestoredEntity[] = [];
    const imported = new Map<string, { readonly id: string; readonly visibility: Visibility }>();
    for (const row of parsed.value.entities) {
      const id = context.mapId(CAMPAIGN_ENTITY_CLASS, row.id);
      if (id === undefined) return err(CONTENT_ID_UNMAPPED);
      const restored = visibilityForImport(row.stored, context.mapId, row.id);
      if (restored.warning !== undefined) warnings.push(restored.warning);
      const { stored: _stored, ...rest } = row;
      entities.push({ ...rest, id, visibility: restored.visibility });
      imported.set(row.id, { id, visibility: restored.visibility });
    }
    const relationships: RestoredRelationship[] = [];
    for (const row of parsed.value.relationships) {
      const id = context.mapId(ENTITY_RELATIONSHIP_CLASS, row.id);
      const source = imported.get(row.sourceEntityId);
      const target = imported.get(row.targetEntityId);
      if (id === undefined || source === undefined || target === undefined) {
        return err(CONTENT_ID_UNMAPPED);
      }
      const restored = visibilityForImport(row.stored, context.mapId, row.id);
      // D-07 bound on the imported endpoints: a link never outruns a narrowed endpoint.
      const bounded = intersectVisibility(
        restored.visibility,
        intersectVisibility(source.visibility, target.visibility),
      );
      if (restored.warning !== undefined) warnings.push(restored.warning);
      else if (JSON.stringify(bounded) !== JSON.stringify(restored.visibility)) {
        warnings.push({ code: VISIBILITY_NARROWED_ON_IMPORT, sourceId: row.id });
      }
      relationships.push({
        id,
        sourceEntityId: source.id,
        targetEntityId: target.id,
        kind: row.kind,
        visibility: bounded,
      });
    }
    const written = await this.importer.writer.restoreWithin(
      this.importer.unwrap(context.transaction),
      {
        campaignId: context.campaignId,
        actorUserId: context.importerUserId,
        entities,
        relationships,
      },
    );
    if (!written.ok) return written;
    return ok({ restoredCount: entities.length + relationships.length, warnings });
  }

  /** Frozen surface: feature 07 never calls it; a chunk is never restored through it. */
  async import(_campaignId: IdValue, chunk: ExportChunk): Promise<Result<void, string>> {
    if (
      chunk.moduleId !== this.moduleId ||
      chunk.chunkVersion !== CONTENT_CHUNK_VERSION ||
      !check(ContentChunk, chunk.payload)
    ) {
      return err(CONTENT_CHUNK_INVALID);
    }
    return err(CONTENT_IMPORT_UNSUPPORTED);
  }
}

export class ContentSearchIndexer implements SearchIndexer {
  readonly moduleId = CONTENT_MODULE_ID;

  constructor(private readonly source: Pick<ContentExportSource, 'entities'>) {}

  async index(campaignId: IdValue): Promise<SearchDoc[]> {
    const entities = await this.source.entities.list(campaignId);
    return entities
      .filter((record) => record.deletedAt === undefined)
      .map((record) => ({
        id: record.id,
        type: record.type,
        title: record.name,
        body: [record.summary, record.description].filter((text) => text !== '').join('\n\n'),
        campaignId: record.campaignId,
        visibility: record.visibility,
      }))
      .sort(byId);
  }
}
