import { visibilityFromColumns, visibilityToColumns } from '@rpg/authorization';
import { check, Id, type Visibility } from '@rpg/contracts';
import { type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { EntityRecord, PersonalNoteRecord, RelationshipRecord } from '../../schemas.ts';
import {
  CONTENT_CONFIGURATION,
  PERSONAL_NOTE_RECORD_TYPE,
  RELATIONSHIP_RECORD_TYPE,
} from '../../types.ts';
import { contentSchema } from './schema.ts';

/**
 * Feature 16 persistence (`_db.md`). Reads are campaign-scoped and carry no authorization: callers
 * decide through feature 04 (`ContentAccess`, `AuthorizationService.decide`) and filter/page the
 * permitted set. Writes are compare-and-set on `version` and take the executor (a transaction or
 * the database) so appliers and Visibility adapters write, lock, and audit in one transaction.
 *
 * Callers pass already-validated values (`domain.ts`); the CHECKs are the last line, not the rule.
 */

export type ContentDatabase = PostgresJsDatabase<typeof contentSchema>;

/** A drizzle transaction on the content database (also a feature 06 `AuditSqlExecutor`). */
export type ContentTransaction = Parameters<Parameters<ContentDatabase['transaction']>[0]>[0];

/** A drizzle database or transaction. */
export interface ContentSqlExecutor {
  execute(query: SQLWrapper): PromiseLike<unknown>;
}

export function connectContentDatabase(connectionString: string, options: { max?: number } = {}) {
  const client = postgres(connectionString, {
    max: options.max ?? 5,
    prepare: false,
    onnotice: () => undefined,
  });
  return {
    db: drizzle(client, { schema: contentSchema, logger: false }),
    close: async () => client.end(),
  };
}

/** Outcome of a versioned write. `deleted` and `version_conflict` carry the authority record. */
export type CompareAndSetResult<T> =
  | { readonly ok: true; readonly record: T }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'deleted'; readonly current: T }
  | { readonly ok: false; readonly reason: 'version_conflict'; readonly current: T };

/** Insert outcome: a client-generated id that already exists is never overwritten. */
export type InsertResult<T> =
  | { readonly ok: true; readonly record: T }
  | { readonly ok: false; readonly reason: 'exists' };

export interface LoadOptions {
  /** Tombstones are excluded unless asked for. */
  readonly includeDeleted?: boolean;
  /** Row lock inside the caller's transaction (lock order: entities by ascending id first). */
  readonly lock?: 'update' | 'share';
  readonly executor?: ContentSqlExecutor;
}

type VisibilityMode = Visibility['mode'];

export interface EntityListFilter {
  readonly type?: string;
  /** Already normalized (D-18). */
  readonly tag?: string;
  readonly visibilityModes?: readonly VisibilityMode[];
  /** Case-insensitive name fragment. */
  readonly nameFragment?: string;
  readonly includeDeleted?: boolean;
}

export interface NewEntity {
  readonly id: string;
  readonly campaignId: string;
  readonly type: string;
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly fields: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly visibility: Visibility;
  readonly actorUserId: string;
}

/** Structured and long-text fields an update may set. Visibility changes go through feature 04. */
export interface EntityChanges {
  readonly type?: string;
  readonly name?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly fields?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface NewPersonalNote {
  readonly id: string;
  readonly campaignId: string;
  readonly authorUserId: string;
  readonly name: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PersonalNoteChanges {
  readonly name?: string;
  readonly body?: string;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface EnvelopeRow extends Record<string, unknown> {
  id: string;
  campaign_id: string;
  name: string;
  tags: unknown;
  metadata: unknown;
  visibility_mode: string;
  visibility_targets: unknown;
  version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  created_by: string;
  updated_by: string;
  deleted_at: Date | string | null;
}

interface EntityRow extends EnvelopeRow {
  type: string;
  summary: string;
  description: string;
  fields: unknown;
}

interface NoteRow extends EnvelopeRow {
  author_user_id: string;
  body: string;
}

function json(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function jsonb(value: unknown): SQL {
  return sql`${JSON.stringify(value)}::jsonb`;
}

function envelope(row: EnvelopeRow) {
  const visibility = visibilityFromColumns(row.visibility_mode, json(row.visibility_targets));
  // The CHECKs make this unreachable; never guess an audience.
  if (visibility === undefined) throw new Error('non-canonical stored visibility');
  return {
    id: row.id,
    campaignId: row.campaign_id,
    name: row.name,
    tags: json(row.tags) as string[],
    metadata: json(row.metadata) as Record<string, unknown>,
    visibility,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    createdBy: row.created_by,
    updatedAt: iso(row.updated_at),
    updatedBy: row.updated_by,
    ...(row.deleted_at === null ? {} : { deletedAt: iso(row.deleted_at) }),
  };
}

function entityRecord(row: EntityRow): EntityRecord {
  return {
    ...envelope(row),
    type: row.type,
    summary: row.summary,
    description: row.description,
    fields: json(row.fields) as Record<string, string>,
  };
}

function noteRecord(row: NoteRow): PersonalNoteRecord {
  return {
    ...envelope(row),
    type: PERSONAL_NOTE_RECORD_TYPE,
    authorUserId: row.author_user_id,
    body: row.body,
  };
}

const LOCKS = { update: sql.raw(' FOR UPDATE'), share: sql.raw(' FOR SHARE') } as const;

/** `LIKE` pattern matching `fragment` literally. */
function containsPattern(fragment: string): string {
  return `%${fragment.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/** One table's versioned-write mechanics, shared by entities and personal notes. */
interface VersionedRow extends Record<string, unknown> {
  deleted_at: Date | string | null;
}

class VersionedTable<TRow extends VersionedRow, TRecord> {
  constructor(
    private readonly db: ContentDatabase,
    private readonly table: SQL,
    private readonly map: (row: TRow) => TRecord,
  ) {}

  async rows(query: SQL, executor: ContentSqlExecutor = this.db): Promise<TRow[]> {
    return [...((await executor.execute(query)) as Iterable<TRow>)];
  }

  async get(
    campaignId: string,
    id: string,
    options: LoadOptions = {},
  ): Promise<TRecord | undefined> {
    // A malformed identifier names no record (and must not reach a uuid cast).
    if (!check(Id, id) || !check(Id, campaignId)) return undefined;
    const [row] = await this.rows(
      sql`SELECT * FROM ${this.table} WHERE id = ${id} AND campaign_id = ${campaignId}
        ${options.includeDeleted === true ? sql`` : sql`AND deleted_at IS NULL`}
        ${options.lock === undefined ? sql`` : LOCKS[options.lock]}`,
      options.executor,
    );
    return row === undefined ? undefined : this.map(row);
  }

  async insert(executor: ContentSqlExecutor, insert: SQL): Promise<InsertResult<TRecord>> {
    const [row] = await this.rows(insert, executor);
    return row === undefined
      ? { ok: false, reason: 'exists' }
      : { ok: true, record: this.map(row) };
  }

  /** Conditional on the live row at `expectedVersion`; classifies a miss from the current row. */
  async compareAndSet(
    executor: ContentSqlExecutor,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly set: SQL;
    },
  ): Promise<CompareAndSetResult<TRecord>> {
    if (!check(Id, input.id) || !check(Id, input.campaignId))
      return { ok: false, reason: 'not_found' };
    const [row] = await this.rows(
      sql`UPDATE ${this.table} SET ${input.set}, version = version + 1
        WHERE id = ${input.id} AND campaign_id = ${input.campaignId}
          AND deleted_at IS NULL AND version = ${input.expectedVersion}
        RETURNING *`,
      executor,
    );
    if (row !== undefined) return { ok: true, record: this.map(row) };
    const [current] = await this.rows(
      sql`SELECT * FROM ${this.table} WHERE id = ${input.id} AND campaign_id = ${input.campaignId}`,
      executor,
    );
    if (current === undefined) return { ok: false, reason: 'not_found' };
    const record = this.map(current);
    return current.deleted_at !== null
      ? { ok: false, reason: 'deleted', current: record }
      : { ok: false, reason: 'version_conflict', current: record };
  }
}

function assignments(entries: readonly (readonly [string, SQL | undefined])[]): SQL[] {
  return entries.flatMap(([column, value]) =>
    value === undefined ? [] : [sql`${sql.identifier(column)} = ${value}`],
  );
}

function textValue(value: string | undefined): SQL | undefined {
  return value === undefined ? undefined : sql`${value}`;
}

function jsonValue(value: unknown): SQL | undefined {
  return value === undefined ? undefined : jsonb(value);
}

export class PostgresEntityRepository {
  readonly #table: VersionedTable<EntityRow, EntityRecord>;

  constructor(private readonly db: ContentDatabase) {
    this.#table = new VersionedTable(db, sql.raw('content_entities'), entityRecord);
  }

  transaction<T>(work: (executor: ContentTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction((transaction) => work(transaction));
  }

  get(campaignId: string, id: string, options?: LoadOptions): Promise<EntityRecord | undefined> {
    return this.#table.get(campaignId, id, options);
  }

  /** Campaign entities matching `filter`, newest update first. No authorization applied. */
  async list(campaignId: string, filter: EntityListFilter = {}): Promise<EntityRecord[]> {
    const conditions: SQL[] = [sql`campaign_id = ${campaignId}`];
    if (filter.includeDeleted !== true) conditions.push(sql`deleted_at IS NULL`);
    if (filter.type !== undefined) conditions.push(sql`type = ${filter.type}`);
    if (filter.tag !== undefined) conditions.push(sql`tags @> ${jsonb([filter.tag])}`);
    if (filter.visibilityModes !== undefined) {
      if (filter.visibilityModes.length === 0) return [];
      conditions.push(
        sql`visibility_mode IN (${sql.join(
          filter.visibilityModes.map((mode) => sql`${mode}`),
          sql`, `,
        )})`,
      );
    }
    if (filter.nameFragment !== undefined && filter.nameFragment !== '') {
      conditions.push(sql`name ILIKE ${containsPattern(filter.nameFragment)} ESCAPE '\\'`);
    }
    const rows = await this.#table.rows(
      sql`SELECT * FROM content_entities WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY updated_at DESC, id`,
    );
    return rows.map(entityRecord);
  }

  insert(executor: ContentSqlExecutor, input: NewEntity): Promise<InsertResult<EntityRecord>> {
    const visibility = visibilityToColumns(input.visibility);
    return this.#table.insert(
      executor,
      sql`INSERT INTO content_entities (
          id, campaign_id, type, name, summary, description, tags, fields, metadata,
          visibility_mode, visibility_targets, created_by, updated_by
        ) VALUES (
          ${input.id}, ${input.campaignId}, ${input.type}, ${input.name}, ${input.summary},
          ${input.description}, ${jsonb(input.tags)}, ${jsonb(input.fields)},
          ${jsonb(input.metadata)}, ${visibility.mode}, ${jsonb(visibility.targets)},
          ${input.actorUserId}, ${input.actorUserId}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING *`,
    );
  }

  update(
    executor: ContentSqlExecutor,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly actorUserId: string;
      readonly changes: EntityChanges;
    },
  ): Promise<CompareAndSetResult<EntityRecord>> {
    const { changes } = input;
    const set = assignments([
      ['type', textValue(changes.type)],
      ['name', textValue(changes.name)],
      ['summary', textValue(changes.summary)],
      ['description', textValue(changes.description)],
      ['tags', jsonValue(changes.tags)],
      ['fields', jsonValue(changes.fields)],
      ['metadata', jsonValue(changes.metadata)],
      ['updated_by', sql`${input.actorUserId}`],
      ['updated_at', sql`now()`],
    ]);
    return this.#table.compareAndSet(executor, { ...input, set: sql.join(set, sql`, `) });
  }

  /** Soft delete: sets `deleted_at` and increments the version; relationships are untouched. */
  tombstone(
    executor: ContentSqlExecutor,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly actorUserId: string;
    },
  ): Promise<CompareAndSetResult<EntityRecord>> {
    return this.#table.compareAndSet(executor, {
      ...input,
      set: sql`deleted_at = now(), updated_at = now(), updated_by = ${input.actorUserId}`,
    });
  }

  /** Feature 04 Visibility write (the adapter's compare-and-set); the value is already normalized. */
  writeVisibility(
    executor: ContentSqlExecutor,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly visibility: Visibility;
    },
  ): Promise<CompareAndSetResult<EntityRecord>> {
    const columns = visibilityToColumns(input.visibility);
    return this.#table.compareAndSet(executor, {
      ...input,
      set: sql`visibility_mode = ${columns.mode},
        visibility_targets = ${jsonb(columns.targets)}, updated_at = now()`,
    });
  }
}

export class PostgresPersonalNoteRepository {
  readonly #table: VersionedTable<NoteRow, PersonalNoteRecord>;

  constructor(private readonly db: ContentDatabase) {
    this.#table = new VersionedTable(db, sql.raw('content_personal_notes'), noteRecord);
  }

  transaction<T>(work: (executor: ContentTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction((transaction) => work(transaction));
  }

  get(
    campaignId: string,
    id: string,
    options?: LoadOptions,
  ): Promise<PersonalNoteRecord | undefined> {
    return this.#table.get(campaignId, id, options);
  }

  /** The author's notes in the campaign, newest update first. */
  async listByAuthor(
    campaignId: string,
    authorUserId: string,
    options: { readonly includeDeleted?: boolean } = {},
  ): Promise<PersonalNoteRecord[]> {
    const rows = await this.#table.rows(
      sql`SELECT * FROM content_personal_notes
        WHERE campaign_id = ${campaignId} AND author_user_id = ${authorUserId}
          ${options.includeDeleted === true ? sql`` : sql`AND deleted_at IS NULL`}
        ORDER BY updated_at DESC, id`,
    );
    return rows.map(noteRecord);
  }

  /** Visibility is fixed to `players:[author]` (BR-007); the author is the creator. */
  insert(
    executor: ContentSqlExecutor,
    input: NewPersonalNote,
  ): Promise<InsertResult<PersonalNoteRecord>> {
    return this.#table.insert(
      executor,
      sql`INSERT INTO content_personal_notes (
          id, campaign_id, author_user_id, name, body, tags, metadata,
          visibility_mode, visibility_targets, created_by, updated_by
        ) VALUES (
          ${input.id}, ${input.campaignId}, ${input.authorUserId}, ${input.name}, ${input.body},
          ${jsonb(input.tags)}, ${jsonb(input.metadata)},
          'players', ${jsonb([input.authorUserId])}, ${input.authorUserId}, ${input.authorUserId}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING *`,
    );
  }

  update(
    executor: ContentSqlExecutor,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly actorUserId: string;
      readonly changes: PersonalNoteChanges;
    },
  ): Promise<CompareAndSetResult<PersonalNoteRecord>> {
    const { changes } = input;
    const set = assignments([
      ['name', textValue(changes.name)],
      ['body', textValue(changes.body)],
      ['tags', jsonValue(changes.tags)],
      ['metadata', jsonValue(changes.metadata)],
      ['updated_by', sql`${input.actorUserId}`],
      ['updated_at', sql`now()`],
    ]);
    return this.#table.compareAndSet(executor, { ...input, set: sql.join(set, sql`, `) });
  }

  tombstone(
    executor: ContentSqlExecutor,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly actorUserId: string;
    },
  ): Promise<CompareAndSetResult<PersonalNoteRecord>> {
    return this.#table.compareAndSet(executor, {
      ...input,
      set: sql`deleted_at = now(), updated_at = now(), updated_by = ${input.actorUserId}`,
    });
  }
}

interface RelationshipRow extends Record<string, unknown> {
  id: string;
  campaign_id: string;
  source_entity_id: string;
  target_entity_id: string;
  kind: string;
  visibility_mode: string;
  visibility_targets: unknown;
  version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  created_by: string;
  updated_by: string;
  deleted_at: Date | string | null;
}

/** Envelope mapping: `name` is the kind label (or the stored kind if no longer configured). */
function relationshipRecord(row: RelationshipRow): RelationshipRecord {
  const visibility = visibilityFromColumns(row.visibility_mode, json(row.visibility_targets));
  if (visibility === undefined) throw new Error('non-canonical stored visibility');
  return {
    id: row.id,
    campaignId: row.campaign_id,
    type: RELATIONSHIP_RECORD_TYPE,
    name: CONTENT_CONFIGURATION.kind(row.kind)?.label ?? row.kind,
    tags: [],
    metadata: {},
    visibility,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    createdBy: row.created_by,
    updatedAt: iso(row.updated_at),
    updatedBy: row.updated_by,
    ...(row.deleted_at === null ? {} : { deletedAt: iso(row.deleted_at) }),
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    kind: row.kind,
  };
}

export interface NewRelationship {
  readonly id: string;
  readonly campaignId: string;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly kind: string;
  readonly visibility: Visibility;
  readonly actorUserId: string;
}

/** Insert outcome: an existing id or a live duplicate (source, target, kind) is never written. */
export type RelationshipInsertResult =
  | { readonly ok: true; readonly record: RelationshipRecord }
  | { readonly ok: false; readonly reason: 'exists' | 'duplicate' };

/**
 * `content_entity_relationships` (task 08). Endpoints are composite foreign keys to
 * `content_entities (campaign_id, id)`, so both live in the relationship's campaign. Lock order in
 * every writer (`_db.md` "Visibility Invariant for Relationships"): entity rows first (ascending
 * id), then relationship rows `FOR UPDATE`.
 */
export class PostgresRelationshipRepository {
  readonly #table: VersionedTable<RelationshipRow, RelationshipRecord>;

  constructor(private readonly db: ContentDatabase) {
    this.#table = new VersionedTable(
      db,
      sql.raw('content_entity_relationships'),
      relationshipRecord,
    );
  }

  transaction<T>(work: (executor: ContentTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction((transaction) => work(transaction));
  }

  get(
    campaignId: string,
    id: string,
    options?: LoadOptions,
  ): Promise<RelationshipRecord | undefined> {
    return this.#table.get(campaignId, id, options);
  }

  /** Relationships where the entity is the source or the target, ordered by id. */
  async listTouching(
    campaignId: string,
    entityId: string,
    options: LoadOptions = {},
  ): Promise<RelationshipRecord[]> {
    if (!check(Id, campaignId) || !check(Id, entityId)) return [];
    const rows = await this.#table.rows(
      sql`SELECT * FROM content_entity_relationships
        WHERE campaign_id = ${campaignId}
          AND (source_entity_id = ${entityId} OR target_entity_id = ${entityId})
          ${options.includeDeleted === true ? sql`` : sql`AND deleted_at IS NULL`}
        ORDER BY id
        ${options.lock === undefined ? sql`` : LOCKS[options.lock]}`,
      options.executor,
    );
    return rows.map(relationshipRecord);
  }

  /** Every relationship of the campaign (live unless asked), ordered by id. */
  async list(
    campaignId: string,
    options: { readonly includeDeleted?: boolean } = {},
  ): Promise<RelationshipRecord[]> {
    if (!check(Id, campaignId)) return [];
    const rows = await this.#table.rows(
      sql`SELECT * FROM content_entity_relationships WHERE campaign_id = ${campaignId}
        ${options.includeDeleted === true ? sql`` : sql`AND deleted_at IS NULL`}
        ORDER BY id`,
    );
    return rows.map(relationshipRecord);
  }

  /**
   * Inserts unless the id exists or a live (source, target, kind) link exists (the partial unique
   * index; `ON CONFLICT DO NOTHING` covers both without aborting the transaction).
   */
  async insert(
    executor: ContentSqlExecutor,
    input: NewRelationship,
  ): Promise<RelationshipInsertResult> {
    const visibility = visibilityToColumns(input.visibility);
    const [row] = await this.#table.rows(
      sql`INSERT INTO content_entity_relationships (
          id, campaign_id, source_entity_id, target_entity_id, kind,
          visibility_mode, visibility_targets, created_by, updated_by
        ) VALUES (
          ${input.id}, ${input.campaignId}, ${input.sourceEntityId}, ${input.targetEntityId},
          ${input.kind}, ${visibility.mode}, ${jsonb(visibility.targets)},
          ${input.actorUserId}, ${input.actorUserId}
        )
        ON CONFLICT DO NOTHING
        RETURNING *`,
      executor,
    );
    if (row !== undefined) return { ok: true, record: relationshipRecord(row) };
    const [existing] = await this.#table.rows(
      sql`SELECT id, deleted_at FROM content_entity_relationships WHERE id = ${input.id}`,
      executor,
    );
    return { ok: false, reason: existing === undefined ? 'duplicate' : 'exists' };
  }

  /** Soft delete; the endpoints are untouched. */
  tombstone(
    executor: ContentSqlExecutor,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly actorUserId: string;
    },
  ): Promise<CompareAndSetResult<RelationshipRecord>> {
    return this.#table.compareAndSet(executor, {
      ...input,
      set: sql`deleted_at = now(), updated_at = now(), updated_by = ${input.actorUserId}`,
    });
  }

  /** Feature 04 Visibility write (relationship adapter); the bound is checked by the caller. */
  writeVisibility(
    executor: ContentSqlExecutor,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly visibility: Visibility;
    },
  ): Promise<CompareAndSetResult<RelationshipRecord>> {
    const columns = visibilityToColumns(input.visibility);
    return this.#table.compareAndSet(executor, {
      ...input,
      set: sql`visibility_mode = ${columns.mode},
        visibility_targets = ${jsonb(columns.targets)}, updated_at = now()`,
    });
  }

  /**
   * D-07 option A: narrows a live relationship already locked `FOR UPDATE` by the caller to
   * `visibility` (version + 1). Used only inside an endpoint's Visibility transaction.
   */
  async narrow(
    executor: ContentSqlExecutor,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly visibility: Visibility;
      readonly actorUserId: string;
    },
  ): Promise<RelationshipRecord | undefined> {
    const columns = visibilityToColumns(input.visibility);
    const [row] = await this.#table.rows(
      sql`UPDATE content_entity_relationships
        SET visibility_mode = ${columns.mode}, visibility_targets = ${jsonb(columns.targets)},
          version = version + 1, updated_at = now(), updated_by = ${input.actorUserId}
        WHERE id = ${input.id} AND campaign_id = ${input.campaignId} AND deleted_at IS NULL
        RETURNING *`,
      executor,
    );
    return row === undefined ? undefined : relationshipRecord(row);
  }
}

/** One live relationship with its endpoints' stored Visibility (bound check input). */
export interface RelationshipBoundRow {
  readonly relationshipId: string;
  readonly visibility: Visibility;
  readonly source: Visibility;
  readonly target: Visibility;
}

/**
 * Invariant assertion (`_db.md` "Visibility Invariant for Relationships", data test): every live
 * relationship of the campaign with its endpoints' stored Visibility (tombstoned endpoints
 * included); the caller applies the bound (`isWithin`). Read-only.
 */
export async function relationshipBoundRows(
  executor: ContentSqlExecutor,
  campaignId: string,
): Promise<RelationshipBoundRow[]> {
  if (!check(Id, campaignId)) return [];
  const rows = [
    ...((await executor.execute(
      sql`SELECT r.id, r.visibility_mode, r.visibility_targets,
          s.visibility_mode AS source_mode, s.visibility_targets AS source_targets,
          t.visibility_mode AS target_mode, t.visibility_targets AS target_targets
        FROM content_entity_relationships r
        JOIN content_entities s ON s.campaign_id = r.campaign_id AND s.id = r.source_entity_id
        JOIN content_entities t ON t.campaign_id = r.campaign_id AND t.id = r.target_entity_id
        WHERE r.campaign_id = ${campaignId} AND r.deleted_at IS NULL
        ORDER BY r.id`,
    )) as Iterable<Record<string, unknown>>),
  ];
  const visibilityOf = (mode: unknown, targets: unknown): Visibility => {
    const value = visibilityFromColumns(mode, json(targets));
    if (value === undefined) throw new Error('non-canonical stored visibility');
    return value;
  };
  return rows.map((row) => ({
    relationshipId: String(row.id),
    visibility: visibilityOf(row.visibility_mode, row.visibility_targets),
    source: visibilityOf(row.source_mode, row.source_targets),
    target: visibilityOf(row.target_mode, row.target_targets),
  }));
}
