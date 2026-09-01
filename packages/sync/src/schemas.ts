import { type Static, Type } from '@sinclair/typebox';

const Id = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
const Timestamp = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$',
});
const Version = Type.Integer({ minimum: 1 });

export const MutationOperationSchema = Type.Union([
  Type.Literal('insert'),
  Type.Literal('update'),
  Type.Literal('tombstone'),
  Type.Literal('semantic'),
  Type.Literal('resolution'),
]);

export const PendingMutationSchema = Type.Object(
  {
    mutationId: Id,
    campaignId: Id,
    featureId: Type.String({ minLength: 1, maxLength: 100 }),
    tableName: Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z][a-z0-9_]*$' }),
    recordId: Id,
    operation: MutationOperationSchema,
    expectedVersion: Type.Union([Version, Type.Null()]),
    payload: Type.Unknown(),
    causalSequence: Type.Integer({ minimum: 1 }),
    state: Type.Union([Type.Literal('pending'), Type.Literal('uploading')]),
    attemptCount: Type.Integer({ minimum: 0 }),
    recordedAt: Timestamp,
  },
  { additionalProperties: false },
);

export const MutationBatchSchema = Type.Object(
  {
    campaignId: Id,
    replicaId: Id,
    mutations: Type.Array(PendingMutationSchema, { minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type MutationBatchInput = Static<typeof MutationBatchSchema>;

export const MutationOutcomeSchema = Type.Union([
  Type.Object(
    {
      mutationId: Id,
      status: Type.Literal('accepted'),
      acceptedVersion: Version,
      serverCursor: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mutationId: Id,
      status: Type.Literal('conflict'),
      expectedVersion: Version,
      actualVersion: Version,
      currentValue: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mutationId: Id,
      status: Type.Literal('error'),
      code: Type.String({ minLength: 1 }),
      retryable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);

export const MutationBatchResponse = Type.Object(
  { outcomes: Type.Array(MutationOutcomeSchema) },
  { additionalProperties: false },
);

export const CampaignParams = Type.Object({ campaignId: Id }, { additionalProperties: false });

export const SyncBootstrapResponse = Type.Object(
  {
    campaignId: Id,
    replicaId: Id,
    endpoint: Type.String({ minLength: 1 }),
    token: Type.String({ minLength: 1 }),
    expiresAt: Timestamp,
  },
  { additionalProperties: false },
);

export const WatermarkAcknowledgement = Type.Object(
  {
    replicaId: Id,
    tableName: Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z][a-z0-9_]*$' }),
    sequence: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const LongTextFieldSchema = Type.Object(
  {
    resourceClass: Type.String({ minLength: 1, maxLength: 100 }),
    recordId: Id,
    fieldPath: Type.String({ minLength: 1, maxLength: 300 }),
  },
  { additionalProperties: false },
);

export const HoldFieldBody = Type.Object(LongTextFieldSchema.properties, {
  additionalProperties: false,
});

export const HoldMutationBody = Type.Object(
  {
    ...LongTextFieldSchema.properties,
    expectedVersion: Version,
  },
  { additionalProperties: false },
);

export const LongTextHoldSchema = Type.Object(
  {
    campaignId: Id,
    ...LongTextFieldSchema.properties,
    holderUserId: Id,
    holderSessionId: Id,
    acquiredAt: Timestamp,
    renewedAt: Timestamp,
    expiresAt: Timestamp,
    version: Version,
  },
  { additionalProperties: false },
);

export const HoldAcquireResponse = Type.Union([
  Type.Object({ acquired: Type.Literal(true), hold: LongTextHoldSchema }),
  Type.Object({ acquired: Type.Literal(false), heldBy: Id, expiresAt: Timestamp }),
]);
