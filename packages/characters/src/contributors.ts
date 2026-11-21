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
  ok,
  type Result,
  type SearchDoc,
  type SearchIndexer,
  SystemRef,
  Timestamp,
} from '@rpg/contracts';
import type { SystemPackage } from '@rpg/systems';
import { type Static, Type } from '@sinclair/typebox';
import { CHARACTER_CLASS } from './policies.ts';
import { type CharacterRecord, type CharacterSecretRecord, isStateShape } from './records.ts';
import { displayName, mergeState } from './sheet.ts';

/**
 * Feature 15 registry contributors (FR-014). The export carries each live character's state and its GM-only
 * state, ordered by id; only export roles produce it, and they read both. Owners are members, whom no new
 * campaign has, so restored characters belong to the importer.
 */

export const CHARACTER_MODULE_ID = 'characters';
export const CHARACTER_CHUNK_VERSION = '1';
export const CHARACTER_CHUNK_INVALID = 'character_chunk_invalid';
export const CHARACTER_ID_UNMAPPED = 'character_id_unmapped';
export const CHARACTER_IMPORT_UNAVAILABLE = 'character_import_unavailable';
export const CHARACTER_IMPORT_UNSUPPORTED = 'character_import_unsupported';

export const CharacterChunkEntry = Type.Object(
  {
    id: Id,
    system: SystemRef,
    state: Type.Unknown(),
    secretState: Type.Unknown(),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);
export const CharacterChunk = Type.Object(
  { campaignId: Id, characters: Type.Array(CharacterChunkEntry) },
  { additionalProperties: false },
);
export type CharacterChunk = Static<typeof CharacterChunk>;

export interface CharacterExportSource {
  list(campaignId: string): Promise<readonly CharacterRecord[]>;
  listSecrets(campaignId: string): Promise<readonly CharacterSecretRecord[]>;
}

export interface CharacterRestorePlan {
  readonly campaignId: IdValue;
  readonly actorUserId: IdValue;
  readonly characters: readonly Static<typeof CharacterChunkEntry>[];
}

export interface CharacterImportDependencies {
  readonly writer: {
    restoreWithin(handle: unknown, plan: CharacterRestorePlan): Promise<Result<void, string>>;
  };
  readonly unwrap: (transaction: ImportTransaction) => unknown;
}

function parseChunk(chunk: ExportChunk): Result<CharacterChunk, string> {
  if (
    chunk.moduleId !== CHARACTER_MODULE_ID ||
    chunk.chunkVersion !== CHARACTER_CHUNK_VERSION ||
    !check(CharacterChunk, chunk.payload)
  ) {
    return err(CHARACTER_CHUNK_INVALID);
  }
  const payload = chunk.payload as CharacterChunk;
  if (
    !payload.characters.every((row) => isStateShape(row.state) && isStateShape(row.secretState))
  ) {
    return err(CHARACTER_CHUNK_INVALID);
  }
  return ok(payload);
}

export function countCharacterRecords(payload: unknown): number {
  return (payload as CharacterChunk).characters.length;
}

export class CharacterExporter implements ExportableModule, ImportableModule {
  readonly moduleId = CHARACTER_MODULE_ID;
  readonly importChunkVersions = [CHARACTER_CHUNK_VERSION] as const;

  constructor(
    private readonly source: CharacterExportSource,
    private readonly importer?: CharacterImportDependencies,
  ) {}

  async export(campaignId: IdValue): Promise<ExportChunk> {
    const [characters, secrets] = await Promise.all([
      this.source.list(campaignId),
      this.source.listSecrets(campaignId),
    ]);
    const secretOf = new Map(secrets.map((secret) => [secret.id, secret.state]));
    const empty = {
      fields: {},
      resources: {},
      tracks: {},
      conditions: {},
      inventory: {},
      slots: {},
    };
    const payload: CharacterChunk = {
      campaignId,
      characters: characters
        .filter((record) => record.deletedAt === undefined)
        .map((record) => ({
          id: record.id,
          system: record.system,
          state: record.state,
          secretState: secretOf.get(record.id) ?? empty,
          createdAt: record.createdAt,
        }))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    };
    return { moduleId: this.moduleId, chunkVersion: CHARACTER_CHUNK_VERSION, payload };
  }

  async validate(chunk: ExportChunk): Promise<Result<ImportPlanContribution, string>> {
    const parsed = parseChunk(chunk);
    if (!parsed.ok) return parsed;
    return ok({
      defines: parsed.value.characters.map((row) => ({ kind: CHARACTER_CLASS, sourceId: row.id })),
      warnings: [],
    });
  }

  async restore(chunk: ExportChunk, context: ImportContext): Promise<Result<ImportResult, string>> {
    if (this.importer === undefined) return err(CHARACTER_IMPORT_UNAVAILABLE);
    const parsed = parseChunk(chunk);
    if (!parsed.ok) return parsed;
    const characters: Static<typeof CharacterChunkEntry>[] = [];
    for (const row of parsed.value.characters) {
      const id = context.mapId(CHARACTER_CLASS, row.id);
      if (id === undefined) return err(CHARACTER_ID_UNMAPPED);
      characters.push({ ...row, id });
    }
    const written = await this.importer.writer.restoreWithin(
      this.importer.unwrap(context.transaction),
      { campaignId: context.campaignId, actorUserId: context.importerUserId, characters },
    );
    if (!written.ok) return written;
    return ok({ restoredCount: characters.length, warnings: [] });
  }

  async import(_campaignId: IdValue, chunk: ExportChunk): Promise<Result<void, string>> {
    const parsed = parseChunk(chunk);
    return parsed.ok ? err(CHARACTER_IMPORT_UNSUPPORTED) : parsed;
  }
}

/** One search document per live character: its name and visible summary text, never GM-only values. */
export class CharacterSearchIndexer implements SearchIndexer {
  readonly moduleId = CHARACTER_MODULE_ID;

  constructor(
    private readonly source: Pick<CharacterExportSource, 'list'>,
    private readonly systems: (ref: CharacterRecord['system']) => SystemPackage | undefined,
  ) {}

  async index(campaignId: IdValue): Promise<SearchDoc[]> {
    const characters = await this.source.list(campaignId);
    return characters
      .filter((record) => record.deletedAt === undefined)
      .flatMap((record) => {
        const system = this.systems(record.system);
        if (system === undefined) return [];
        const state = mergeState(record.state, undefined);
        const body = system.characterSchema.summaryFields
          .map((key) => state.fields[key])
          .filter((value): value is string => typeof value === 'string' && value !== '')
          .join('\n');
        return [
          {
            id: record.id,
            type: CHARACTER_CLASS,
            title: displayName(system, state),
            body,
            campaignId: record.campaignId,
            visibility: record.visibility,
          },
        ];
      })
      .sort((left, right) => (left.id < right.id ? -1 : 1));
  }
}
