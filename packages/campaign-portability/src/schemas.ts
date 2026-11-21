import { Id, Timestamp } from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import { CHUNK_VERSION_PATTERN, MODULE_ID_PATTERN } from './paths.ts';

/** `.rpgpack` format version written by this application. Internal, not a public promise. */
export const RPGPACK_FORMAT_VERSION = 1;

export const Sha256Hex = Type.String({ pattern: '^[0-9a-f]{64}$' });
export const ModuleId = Type.String({ pattern: MODULE_ID_PATTERN });
export const ChunkVersion = Type.String({ pattern: CHUNK_VERSION_PATTERN });
const EntryPathString = Type.String({ minLength: 1, maxLength: 255 });
/** Same shape as feature 02 system/module identifiers. */
const PinIdentifier = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: '^[a-z0-9][a-z0-9._-]*$',
});
const PinVersion = Type.String({ minLength: 1, maxLength: 64, pattern: '^[0-9A-Za-z.+_-]+$' });

export const ManifestEntry = Type.Object(
  {
    path: EntryPathString,
    sha256: Sha256Hex,
    size: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ManifestEntry = Static<typeof ManifestEntry>;

export const ContributorRecord = Type.Object(
  {
    moduleId: ModuleId,
    chunkVersion: ChunkVersion,
    path: EntryPathString,
    checksum: Sha256Hex,
  },
  { additionalProperties: false },
);
export type ContributorRecord = Static<typeof ContributorRecord>;

export const Manifest = Type.Object(
  {
    format: Type.Literal('rpgpack'),
    formatVersion: Type.Integer({ minimum: 1 }),
    applicationVersion: Type.String({ minLength: 1, maxLength: 64 }),
    exportedAt: Timestamp,
    /** Safe display identity only: never an email, credential or account identifier. */
    exportedBy: Type.Object(
      { displayName: Type.String({ minLength: 1, maxLength: 64 }) },
      { additionalProperties: false },
    ),
    /** Provenance only. Import always assigns new identifiers. */
    source: Type.Object({ campaignId: Id }, { additionalProperties: false }),
    content: Type.Object(
      {
        attachmentBinaries: Type.Literal('excluded'),
        audit: Type.Literal('excluded'),
      },
      { additionalProperties: false },
    ),
    /** Every entry except `manifest.json`, sorted by path. */
    entries: Type.Array(ManifestEntry, { maxItems: 10_000 }),
    /** Recognized contributors, sorted by module id. */
    contributors: Type.Array(ContributorRecord, { maxItems: 10_000 }),
    /** Opaque chunks preserved from an earlier import, sorted by module id then version. */
    preserved: Type.Array(ContributorRecord, { maxItems: 10_000 }),
  },
  { additionalProperties: false, $id: 'RpgpackManifest' },
);
export type Manifest = Static<typeof Manifest>;

export const SystemLock = Type.Object(
  { systemId: PinIdentifier, version: PinVersion },
  { additionalProperties: false, $id: 'RpgpackSystemLock' },
);
export type SystemLock = Static<typeof SystemLock>;

export const ModulesLock = Type.Object(
  {
    modules: Type.Array(
      Type.Object(
        { moduleId: PinIdentifier, version: PinVersion },
        { additionalProperties: false },
      ),
      { maxItems: 1_000 },
    ),
  },
  { additionalProperties: false, $id: 'RpgpackModulesLock' },
);
export type ModulesLock = Static<typeof ModulesLock>;

/** One chunk entry: the frozen `ExportChunk` shape serialized as canonical JSON. */
export const ChunkFile = Type.Object(
  {
    moduleId: ModuleId,
    chunkVersion: ChunkVersion,
    payload: Type.Unknown(),
  },
  { additionalProperties: false, $id: 'RpgpackChunk' },
);
export type ChunkFile = Static<typeof ChunkFile>;

/** Safe per-module summary for job status and reports. Never payload content. */
export const ContributorSummary = Type.Object(
  {
    moduleId: ModuleId,
    chunkVersion: ChunkVersion,
    records: Type.Optional(Type.Integer({ minimum: 0 })),
    bytes: Type.Integer({ minimum: 0 }),
    preserved: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
export type ContributorSummary = Static<typeof ContributorSummary>;
