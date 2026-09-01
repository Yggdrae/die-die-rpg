import { Id, SystemRef, Timestamp, Version } from '@rpg/contracts';
import { type Static, type TSchema, Type } from '@sinclair/typebox';

const Identifier = Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z0-9][a-z0-9._-]*$' });

export const IntegrationStatus = Type.Object(
  {
    mechanicsSupported: Type.Boolean(),
    characterSheetSupported: Type.Boolean(),
    rulesTextIntegrated: Type.Boolean(),
    compendiumIntegrated: Type.Boolean(),
    externalDocumentation: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);

export const SystemSummary = Type.Object(
  {
    ref: SystemRef,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    shortDescription: Type.String({ minLength: 1, maxLength: 500 }),
    complexity: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
    documentationStatus: Type.Union([
      Type.Literal('integrated'),
      Type.Literal('external'),
      Type.Literal('unavailable'),
    ]),
    rulesEntryPoint: Type.String({ minLength: 1, maxLength: 2048 }),
    integration: IntegrationStatus,
  },
  { additionalProperties: false, $id: 'CampaignSystemSummary' },
);
export type SystemSummary = Static<typeof SystemSummary>;

export const GameModeDeclaration = Type.Object(
  { id: Identifier, label: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false },
);
export type GameModeDeclaration = Static<typeof GameModeDeclaration>;

const StringOption = Type.Object(
  {
    key: Identifier,
    label: Type.String({ minLength: 1, maxLength: 120 }),
    type: Type.Literal('string'),
    default: Type.String(),
    minLength: Type.Optional(Type.Integer({ minimum: 0 })),
    maxLength: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
const BooleanOption = Type.Object(
  {
    key: Identifier,
    label: Type.String({ minLength: 1, maxLength: 120 }),
    type: Type.Literal('boolean'),
    default: Type.Boolean(),
  },
  { additionalProperties: false },
);
const SelectOption = Type.Object(
  {
    key: Identifier,
    label: Type.String({ minLength: 1, maxLength: 120 }),
    type: Type.Literal('select'),
    default: Type.String(),
    values: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false },
);
export const SystemOptionDeclaration = Type.Union([StringOption, BooleanOption, SelectOption]);
export type SystemOptionDeclaration = Static<typeof SystemOptionDeclaration>;

export const ModuleDeclaration = Type.Object(
  {
    id: Identifier,
    version: Type.String({ minLength: 1, pattern: '^\\d+\\.\\d+\\.\\d+$' }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
  },
  { additionalProperties: false },
);
export type ModuleDeclaration = Static<typeof ModuleDeclaration>;

export const SystemDefinition = Type.Object(
  {
    summary: SystemSummary,
    gameModes: Type.Array(GameModeDeclaration, { minItems: 1 }),
    options: Type.Array(SystemOptionDeclaration),
    compatibleModules: Type.Array(ModuleDeclaration),
  },
  { additionalProperties: false, $id: 'CampaignSystemDefinition' },
);
export type SystemDefinition = Static<typeof SystemDefinition>;

export const CampaignSettingValue = Type.Unknown();

export const CampaignView = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ maxLength: 10_000 }),
    system: SystemRef,
    gameMode: Identifier,
    modulePins: Type.Array(
      Type.Object({ moduleId: Identifier, version: Type.String({ minLength: 1 }) }),
    ),
    settings: Type.Record(Type.String(), CampaignSettingValue),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  },
  { additionalProperties: false, $id: 'CampaignView' },
);
export type CampaignView = Static<typeof CampaignView>;

export const CampaignContext = Type.Object(
  {
    campaignId: Id,
    system: SystemRef,
    gameMode: Identifier,
    modulePins: Type.Array(
      Type.Object({ moduleId: Identifier, version: Type.String({ minLength: 1 }) }),
    ),
    settings: Type.Record(Type.String(), CampaignSettingValue),
  },
  { additionalProperties: false, $id: 'CampaignContext' },
);
export type CampaignContext = Static<typeof CampaignContext>;

export const CampaignCreateInput = Type.Object(
  {
    id: Id,
    system: SystemRef,
    gameMode: Identifier,
    options: Type.Record(Type.String(), Type.Unknown()),
    moduleIds: Type.Array(Identifier, { uniqueItems: true }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ maxLength: 10_000 }),
  },
  { additionalProperties: false, $id: 'CampaignCreateInput' },
);
export type CampaignCreateInput = Static<typeof CampaignCreateInput>;

export const CampaignDetailsUpdateInput = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ maxLength: 10_000 }),
    expectedVersion: Version,
  },
  { additionalProperties: false, $id: 'CampaignDetailsUpdateInput' },
);
export type CampaignDetailsUpdateInput = Static<typeof CampaignDetailsUpdateInput>;

export const CampaignDeleteInput = Type.Object(
  { expectedVersion: Version },
  { additionalProperties: false, $id: 'CampaignDeleteInput' },
);

export const CampaignSystemUpdateInput = Type.Object(
  { targetVersion: Type.String({ minLength: 1 }), expectedVersion: Version },
  { additionalProperties: false, $id: 'CampaignSystemUpdateInput' },
);
export type CampaignSystemUpdateInput = Static<typeof CampaignSystemUpdateInput>;

export const CampaignSettingUpdateInput = Type.Object(
  { value: Type.Unknown(), expectedVersion: Type.Union([Version, Type.Null()]) },
  { additionalProperties: false, $id: 'CampaignSettingUpdateInput' },
);
export type CampaignSettingUpdateInput = Static<typeof CampaignSettingUpdateInput>;

export interface SystemCatalog {
  list(query?: string): Promise<readonly SystemSummary[]>;
  resolveExact(ref: Static<typeof SystemRef>): Promise<SystemDefinition | undefined>;
  resolveLatest(systemId: string): Promise<SystemDefinition | undefined>;
}

export interface CampaignContextResolver {
  resolve(userId: string, campaignId: string): Promise<CampaignContext | undefined>;
}

export interface CampaignSettingRegistration {
  readonly namespace: string;
  readonly schema: TSchema;
  readonly memberVisible: boolean;
  readonly writableRoles: readonly ('owner' | 'gm' | 'assistant_gm' | 'player')[];
}
