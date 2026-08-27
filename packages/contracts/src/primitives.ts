import { type Static, Type } from '@sinclair/typebox';

/**
 * Identifier for every persisted record in the platform.
 *
 * Pattern-validated rather than `format: 'uuid'` so validation works with no format
 * registry configured. Lowercase only, so an identifier has exactly one representation.
 */
export const Id = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  $id: 'Id',
});
export type Id = Static<typeof Id>;

/**
 * UTC instant, ISO 8601, always with a `Z` suffix.
 *
 * Offsets and local times are rejected on purpose. Clients compute independently while
 * offline (`PRD.md` s.52) and clock representation must not vary between them.
 */
export const Timestamp = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$',
  $id: 'Timestamp',
});
export type Timestamp = Static<typeof Timestamp>;

/**
 * Optimistic concurrency version.
 *
 * Starts at 1 and increments on every successful write. Feature 03 detects conflicts with
 * it; a record that never carried one cannot gain conflict detection without a migration,
 * which is why it is required on every persisted entity from the first commit
 * (`PRD.md` s.57, s.80).
 */
export const Version = Type.Integer({ minimum: 1, $id: 'Version' });
export type Version = Static<typeof Version>;

/** Free-form, campaign-scoped label. */
export const Tag = Type.String({ minLength: 1, maxLength: 64, $id: 'Tag' });
export type Tag = Static<typeof Tag>;

/**
 * Open metadata bag.
 *
 * Deliberately unconstrained. A feature that needs structure declares its own schema for
 * its own namespace rather than widening this one.
 */
export const Metadata = Type.Record(Type.String(), Type.Unknown(), { $id: 'Metadata' });
export type Metadata = Static<typeof Metadata>;
