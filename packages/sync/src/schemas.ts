import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

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

/** Mirrors `@rpg/audit` MAX_AUDIT_VALUE_BYTES; pinned by an apps/api composition test. */
export const MUTATION_AUDIT_VALUE_LIMIT_BYTES = 16_384;

const AuditMetadata = Type.Record(Type.String(), Type.Unknown());

/**
 * Audit payload that travels with an uploaded mutation (feature 06 TechSpec, Recording Contract
 * Adaptation): the frozen `AuditEvent` without its identifier. The identifier is derived from the
 * mutation ID at the authority, and `actor` is advisory only: the authority replaces it with the
 * actor it resolved from the authenticated session (`ActorRef` is never client-supplied).
 */
export const MutationAuditSchema = Type.Object(
  {
    campaignId: Id,
    sessionId: Type.Optional(Id),
    actor: Type.Optional(
      Type.Object(
        {
          userId: Id,
          campaignId: Id,
          role: Type.Union([
            Type.Literal('owner'),
            Type.Literal('gm'),
            Type.Literal('assistant_gm'),
            Type.Literal('player'),
            Type.Literal('observer'),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
    action: Type.String({ minLength: 1, maxLength: 128 }),
    targetType: Type.String({ minLength: 1, maxLength: 128 }),
    targetId: Id,
    before: Type.Optional(AuditMetadata),
    after: Type.Optional(AuditMetadata),
    at: Timestamp,
    private: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type MutationAuditPayload = Static<typeof MutationAuditSchema>;

/** Schema plus the serialized before/after bound; the single local and wire validity rule. */
export function isValidMutationAudit(value: unknown): value is MutationAuditPayload {
  if (!Value.Check(MutationAuditSchema, value)) return false;
  try {
    const size =
      (value.before === undefined ? 0 : JSON.stringify(value.before).length) +
      (value.after === undefined ? 0 : JSON.stringify(value.after).length);
    return size <= MUTATION_AUDIT_VALUE_LIMIT_BYTES;
  } catch {
    return false;
  }
}

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
    /** Optional so older clients stay valid; without it the authority audits through the domain service. */
    audit: Type.Optional(MutationAuditSchema),
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

/**
 * A replica acknowledges a sequence it observed in `tableName`. Audit tables are excluded: their
 * replicas never see an authority sequence (gaps would count hidden events), so they acknowledge
 * through `AuditWatermarkAcknowledgement` instead.
 */
export const WatermarkAcknowledgement = Type.Object(
  {
    replicaId: Id,
    tableName: Type.String({
      minLength: 1,
      maxLength: 100,
      pattern: '^(?!audit_)[a-z][a-z0-9_]*$',
    }),
    sequence: Type.Integer({ minimum: 0 }),
    /** Records in `tableName` still referenced by this replica's unfinished local work. */
    pendingRecordIds: Type.Optional(Type.Array(Id, { maxItems: 1000, uniqueItems: true })),
  },
  { additionalProperties: false },
);
export type WatermarkAcknowledgement = Static<typeof WatermarkAcknowledgement>;

/** Watermark scopes of the two replicated audit stores (feature 06 streams). */
export const AUDIT_WATERMARK_SCOPES = ['audit_campaign_events', 'audit_private_events'] as const;
export type AuditWatermarkScope = (typeof AUDIT_WATERMARK_SCOPES)[number];

/**
 * Feature 06 audit acknowledgement: the replica names the newest accepted event it durably holds
 * in that store (or nothing it holds is older than what it dropped by compaction). The authority
 * resolves the event to its sequence only if this replica's user may read it; the sequence never
 * leaves the server.
 */
export const AuditWatermarkAcknowledgement = Type.Object(
  {
    replicaId: Id,
    tableName: Type.Union([
      Type.Literal('audit_campaign_events'),
      Type.Literal('audit_private_events'),
    ]),
    throughEventId: Id,
  },
  { additionalProperties: false },
);
export type AuditWatermarkAcknowledgement = Static<typeof AuditWatermarkAcknowledgement>;

export const ReplicaAcknowledgementBody = Type.Union([
  WatermarkAcknowledgement,
  AuditWatermarkAcknowledgement,
]);

export const SyncBootstrapQuery = Type.Object(
  { replicaId: Type.Optional(Id) },
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
