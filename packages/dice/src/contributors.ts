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
  ok,
  type Result,
  Timestamp,
  Visibility,
} from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import { replayRoll } from './engine/evaluator.ts';
import { DICE_ROLL_CLASS } from './policies.ts';
import {
  ROLL_VISIBILITIES,
  type RollRecord,
  RollResultSchema,
  type RollVisibility,
} from './records.ts';

/**
 * Feature 09 registry contributor (D-16). Roll history is campaign content, so it travels with the
 * campaign. Rows are ordered by id, so two reads of unchanged data are byte-identical. Input names are
 * values in `{ name, value }` pairs, because a free-form key could hit the package's forbidden-key scan.
 *
 * Actor ids, session ids, and caller refs are not exported in version 1: memberships are not imported,
 * and the features that own those refs do not exist yet. A restored roll therefore belongs to the
 * importer, and a targeted one narrows to GM-only with a warning, because no member is ever mapped
 * into a new campaign. It never widens.
 */

export const DICE_MODULE_ID = 'dice_rolls';
export const DICE_CHUNK_VERSION = '1';
export const DICE_CHUNK_INVALID = 'dice_chunk_invalid';
export const DICE_ROLL_INVALID = 'dice_roll_invalid';
export const DICE_ID_UNMAPPED = 'dice_id_unmapped';
export const DICE_IMPORT_UNAVAILABLE = 'dice_import_unavailable';
export const DICE_IMPORT_UNSUPPORTED = 'dice_import_unsupported';

export const DiceChunkRoll = Type.Object(
  {
    id: Id,
    action: Type.Optional(Type.String({ minLength: 1 })),
    expression: Type.String({ minLength: 1 }),
    inputs: Type.Array(
      Type.Object(
        { name: Type.String({ minLength: 1 }), value: Type.Integer() },
        {
          additionalProperties: false,
        },
      ),
    ),
    result: RollResultSchema,
    rollVisibility: Type.Union(ROLL_VISIBILITIES.map((value) => Type.Literal(value))),
    visibility: Visibility,
    rolledAt: Timestamp,
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);
export type DiceChunkRoll = Static<typeof DiceChunkRoll>;

export const DiceChunk = Type.Object(
  { campaignId: Id, rolls: Type.Array(DiceChunkRoll) },
  { additionalProperties: false },
);
export type DiceChunk = Static<typeof DiceChunk>;

export interface DiceExportSource {
  list(campaignId: string): Promise<readonly RollRecord[]>;
}

export interface RestoredRoll {
  readonly id: IdValue;
  readonly action?: string;
  readonly expression: string;
  readonly inputs: Readonly<Record<string, number>>;
  readonly result: RollRecord['result'];
  readonly rollVisibility: RollVisibility;
  readonly visibility: Visibility;
  readonly rolledAt: string;
}

export interface DiceRestorePlan {
  readonly campaignId: IdValue;
  readonly actorUserId: IdValue;
  readonly rolls: readonly RestoredRoll[];
}

export interface DiceImportWriter {
  restoreWithin(handle: unknown, plan: DiceRestorePlan): Promise<Result<void, string>>;
}

export interface DiceImportDependencies {
  readonly writer: DiceImportWriter;
  readonly unwrap: (transaction: ImportTransaction) => unknown;
}

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function chunkRoll(record: RollRecord): DiceChunkRoll {
  return {
    id: record.id,
    ...(record.action === undefined ? {} : { action: record.action }),
    expression: record.expression,
    inputs: Object.entries(record.inputs)
      .map(([name, value]) => ({ name, value }))
      .sort((left, right) => (left.name < right.name ? -1 : 1)),
    result: record.result as unknown as DiceChunkRoll['result'],
    rollVisibility: record.rollVisibility,
    visibility: record.visibility,
    rolledAt: record.rolledAt,
    createdAt: record.createdAt,
  };
}

function inputsOf(row: DiceChunkRoll): Readonly<Record<string, number>> {
  return Object.fromEntries(row.inputs.map(({ name, value }) => [name, value]));
}

function parseChunk(chunk: ExportChunk): Result<DiceChunk, string> {
  if (
    chunk.moduleId !== DICE_MODULE_ID ||
    chunk.chunkVersion !== DICE_CHUNK_VERSION ||
    !check(DiceChunk, chunk.payload)
  ) {
    return err(DICE_CHUNK_INVALID);
  }
  const payload = chunk.payload as DiceChunk;
  for (const row of payload.rolls) {
    const result = row.result as unknown as RollRecord['result'];
    if (!replayRoll(row.expression, inputsOf(row), result)) return err(DICE_ROLL_INVALID);
  }
  return ok(payload);
}

export function countDiceRecords(payload: unknown): number {
  return (payload as DiceChunk).rolls.length;
}

export class RollExporter implements ExportableModule, ImportableModule {
  readonly moduleId = DICE_MODULE_ID;
  readonly importChunkVersions = [DICE_CHUNK_VERSION] as const;

  constructor(
    private readonly source: DiceExportSource,
    private readonly importer?: DiceImportDependencies,
  ) {}

  async export(campaignId: IdValue): Promise<ExportChunk> {
    const rolls = await this.source.list(campaignId);
    const payload: DiceChunk = { campaignId, rolls: rolls.map(chunkRoll).sort(byId) };
    return { moduleId: this.moduleId, chunkVersion: DICE_CHUNK_VERSION, payload };
  }

  /** Write-free: every rule a restore applies, and the source ids this chunk defines. */
  async validate(chunk: ExportChunk): Promise<Result<ImportPlanContribution, string>> {
    const parsed = parseChunk(chunk);
    if (!parsed.ok) return parsed;
    return ok({
      defines: parsed.value.rolls.map((row) => ({ kind: DICE_ROLL_CLASS, sourceId: row.id })),
      warnings: [],
    });
  }

  async restore(chunk: ExportChunk, context: ImportContext): Promise<Result<ImportResult, string>> {
    if (this.importer === undefined) return err(DICE_IMPORT_UNAVAILABLE);
    const parsed = parseChunk(chunk);
    if (!parsed.ok) return parsed;
    const warnings: ImportWarning[] = [];
    const rolls: RestoredRoll[] = [];
    for (const row of parsed.value.rolls) {
      const id = context.mapId(DICE_ROLL_CLASS, row.id);
      if (id === undefined) return err(DICE_ID_UNMAPPED);
      const restored = visibilityForImport(row.visibility, context.mapId, row.id);
      // Hidden stays hidden and public stays public. Targets name source members, whom no new
      // campaign has, and the importer is not among them: a targeted roll narrows either way.
      const narrowed = restored.visibility.mode === 'players' || restored.warning !== undefined;
      if (narrowed) warnings.push({ code: VISIBILITY_NARROWED_ON_IMPORT, sourceId: row.id });
      rolls.push({
        id,
        ...(row.action === undefined ? {} : { action: row.action }),
        expression: row.expression,
        inputs: inputsOf(row),
        result: row.result as unknown as RollRecord['result'],
        rollVisibility: narrowed ? 'gm_only' : row.rollVisibility,
        visibility: narrowed ? { mode: 'gm_only' } : restored.visibility,
        rolledAt: row.rolledAt,
      });
    }
    const written = await this.importer.writer.restoreWithin(
      this.importer.unwrap(context.transaction),
      { campaignId: context.campaignId, actorUserId: context.importerUserId, rolls },
    );
    if (!written.ok) return written;
    return ok({ restoredCount: rolls.length, warnings });
  }

  /** Frozen surface: feature 07 never calls it; a chunk is never restored through it. */
  async import(_campaignId: IdValue, chunk: ExportChunk): Promise<Result<void, string>> {
    const parsed = parseChunk(chunk);
    return parsed.ok ? err(DICE_IMPORT_UNSUPPORTED) : parsed;
  }
}
