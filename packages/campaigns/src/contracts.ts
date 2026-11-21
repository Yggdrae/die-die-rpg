import { Id, SystemRef, Timestamp, Version } from '@rpg/contracts';
import {
  GameModeDeclaration,
  IntegrationStatus,
  ModuleDeclaration,
  SystemDefinition,
  SystemOptionDeclaration,
  SystemSummary,
} from '@rpg/systems';
import { type Static, type TSchema, Type } from '@sinclair/typebox';

const Identifier = Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z0-9][a-z0-9._-]*$' });

// Feature 08 owns these; re-exported so feature 02's consumers keep one import.
export {
  GameModeDeclaration,
  IntegrationStatus,
  ModuleDeclaration,
  SystemDefinition,
  SystemOptionDeclaration,
  SystemSummary,
};

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
