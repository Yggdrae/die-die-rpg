import { createHash } from 'node:crypto';
import { AuditEvent, check, GM_ONLY, Id, Metadata, Timestamp, Visibility } from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import type { SQLWrapper } from 'drizzle-orm';

/** Serialized before/after bound per event. Larger values are a contributor defect. */
export const MAX_AUDIT_VALUE_BYTES = 16_384;

/**
 * Target visibility captured at mutation time, in the shape feature 04 `ResourceFacts`
 * evaluates. Read and sync rules filter on it; a missing declaration fails closed.
 */
export const TargetVisibilitySnapshot = Type.Object(
  {
    visibility: Visibility,
    authorUserId: Type.Optional(Id),
    partyIds: Type.Optional(Type.Array(Id, { minItems: 1 })),
  },
  { additionalProperties: false },
);
export type TargetVisibilitySnapshot = Static<typeof TargetVisibilitySnapshot>;

/**
 * Narrowest default when neither the caller, the action's declaration, nor the target class's
 * feature 04 declaration justifies a snapshot: an undeclared target is GM-only.
 */
export const FAIL_CLOSED_VISIBILITY: TargetVisibilitySnapshot = { visibility: GM_ONLY };

/**
 * Feature 04 Resource Policy lookup for an event's target class, supplied by composition so this
 * package never imports authorization (which already depends on audit). It answers only for a
 * class whose declaration fixes every record's visibility (a static default, no reveal, no
 * ownership on read); `undefined` means facts are required, and the event fails closed.
 */
export interface AuditTargetDeclarations {
  snapshotFor(targetType: string): TargetVisibilitySnapshot | undefined;
}

/**
 * Account-scoped fact with no campaign (for example operator-issued password recovery).
 * Not part of the frozen `AuditEvent`; see the 2026-10-24 account audit store note.
 */
export const AccountAuditEvent = Type.Object(
  {
    subjectUserId: Id,
    actor: Type.Union([
      Type.Object(
        {
          kind: Type.Literal('operator'),
          reference: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        },
        { additionalProperties: false },
      ),
      Type.Object({ kind: Type.Literal('user'), userId: Id }, { additionalProperties: false }),
    ]),
    action: Type.String({ minLength: 1, maxLength: 128 }),
    targetType: Type.String({ minLength: 1, maxLength: 128 }),
    targetId: Id,
    before: Type.Optional(Metadata),
    after: Type.Optional(Metadata),
    at: Timestamp,
  },
  { additionalProperties: false },
);
export type AccountAuditEvent = Static<typeof AccountAuditEvent>;

export type CampaignAuditStoreName = 'campaign' | 'private';
export type AuditStoreName = CampaignAuditStoreName | 'account';

export interface CampaignAuditEnvelope {
  readonly store: CampaignAuditStoreName;
  readonly eventId: string;
  readonly originMutationId: string;
  /** Validated event; `event.id === eventId`. */
  readonly event: AuditEvent;
  readonly targetVisibility: TargetVisibilitySnapshot;
  readonly rendererVersion: number;
}

export interface AccountAuditEnvelope {
  readonly store: 'account';
  readonly eventId: string;
  readonly originMutationId: string;
  readonly event: AccountAuditEvent;
  readonly rendererVersion: number;
}

export type AuditEnvelope = CampaignAuditEnvelope | AccountAuditEnvelope;

export interface AuditAppendResult {
  readonly status: 'inserted' | 'duplicate';
  readonly eventId: string;
  readonly sequence: number;
}

/**
 * Any PostgreSQL executor (database or open transaction). `transaction` on an open
 * transaction opens a savepoint, which is how audit isolates its own failure.
 */
export interface AuditSqlExecutor {
  execute(query: SQLWrapper): PromiseLike<unknown>;
  transaction<T>(work: (nested: AuditSqlExecutor) => Promise<T>): Promise<T>;
}

/** The only write surface of a physical store. Reads stay on each concrete repository. */
export interface AuditAppender<TEnvelope extends AuditEnvelope> {
  append(envelope: TEnvelope): Promise<AuditAppendResult>;
  /**
   * Append inside the caller's open transaction. Implementations isolate their own failure
   * (savepoint) so a failed audit insert never aborts the caller's transaction.
   */
  appendWithin(executor: AuditSqlExecutor, envelope: TEnvelope): Promise<AuditAppendResult>;
}

/** `private` alone decides the physical store, once, at the write boundary. */
export function routeCampaignEvent(event: Pick<AuditEvent, 'private'>): CampaignAuditStoreName {
  return event.private === true ? 'private' : 'campaign';
}

const EVENT_ID_NAMESPACE = 'rpg.audit.event:';

/**
 * Stable event identifier derived from the origin mutation, so every retry from any process
 * submits the same identifier (feature 06 TechSpec, Recording Contract Adaptation).
 */
export function deriveAuditEventId(originMutationId: string): string {
  const hex = createHash('sha256')
    .update(`${EVENT_ID_NAMESPACE}${originMutationId}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '8';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function isAuditId(value: unknown): value is string {
  return check(Id, value);
}

export function isValidCampaignEvent(event: unknown): event is AuditEvent {
  return check(AuditEvent, event) && valuesWithinBound(event as AuditEvent);
}

export function isValidAccountEvent(event: unknown): event is AccountAuditEvent {
  return check(AccountAuditEvent, event) && valuesWithinBound(event as AccountAuditEvent);
}

export function isValidVisibilitySnapshot(value: unknown): value is TargetVisibilitySnapshot {
  return check(TargetVisibilitySnapshot, value);
}

function valuesWithinBound(event: {
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
}): boolean {
  try {
    const size =
      (event.before === undefined ? 0 : JSON.stringify(event.before).length) +
      (event.after === undefined ? 0 : JSON.stringify(event.after).length);
    return size <= MAX_AUDIT_VALUE_BYTES;
  } catch {
    return false;
  }
}
