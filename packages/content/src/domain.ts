import { err, ok, type Result, type Visibility } from '@rpg/contracts';
import {
  CONTENT_CONFIGURATION,
  CONTENT_TOKEN_PATTERN,
  type ContentConfiguration,
  type EntityTypeDefinition,
  type RelationshipKindDefinition,
} from './types.ts';

/**
 * Pure content rules shared by the authority (appliers, services) and the device (local
 * repository): D-01 custom fields, D-11 limits, D-18 tag form, type and kind membership, and the
 * relationship Visibility bound (D-07). No rule branches on a specific type identifier; every rule
 * reads the configuration it is given.
 *
 * Lengths count Unicode code points, the unit PostgreSQL `char_length` uses in the CHECKs, so the
 * device and the database agree on every boundary.
 */

export const CONTENT_LIMITS = {
  nameMax: 200,
  summaryMax: 280,
  /** Entity `description` and personal-note `body` (Markdown source as plain text, D-10). */
  longTextMax: 50_000,
  tagMax: 64,
  tagsMax: 32,
  fieldsMax: 32,
  fieldLabelMax: 64,
  fieldValueMax: 1_000,
} as const;

export type ContentRuleError =
  | 'name_required'
  | 'name_too_long'
  | 'invalid_text'
  | 'summary_too_long'
  | 'long_text_too_long'
  | 'invalid_tags'
  | 'tag_empty'
  | 'tag_too_long'
  | 'too_many_tags'
  | 'invalid_fields'
  | 'too_many_fields'
  | 'field_label_empty'
  | 'field_label_too_long'
  | 'duplicate_field_label'
  | 'invalid_field_value'
  | 'field_value_too_long'
  | 'invalid_type'
  | 'unknown_type'
  | 'unknown_kind';

/** Length in code points (PostgreSQL `char_length`). */
export function textLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** Name trimmed and required, 1..200 (D-11). */
export function normalizeName(value: unknown): Result<string, ContentRuleError> {
  if (typeof value !== 'string') return err('invalid_text');
  const name = value.trim();
  if (name === '') return err('name_required');
  if (textLength(name) > CONTENT_LIMITS.nameMax) return err('name_too_long');
  return ok(name);
}

/** The quick-create "one line", 0..280 (D-11). Stored as given. */
export function checkSummary(value: unknown): Result<string, ContentRuleError> {
  if (typeof value !== 'string') return err('invalid_text');
  if (textLength(value) > CONTENT_LIMITS.summaryMax) return err('summary_too_long');
  return ok(value);
}

/** Entity description or personal-note body, 0..50,000 (D-10, D-11). Stored as given. */
export function checkLongText(value: unknown): Result<string, ContentRuleError> {
  if (typeof value !== 'string') return err('invalid_text');
  if (textLength(value) > CONTENT_LIMITS.longTextMax) return err('long_text_too_long');
  return ok(value);
}

/**
 * Canonical tag (D-18): trim, Unicode NFC, collapse internal whitespace to one space, lowercase.
 * Does not validate length; `normalizeTags` does.
 */
export function normalizeTag(value: string): string {
  return value.trim().normalize('NFC').replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * The stored tag set (D-18, D-11): every tag normalized, empty and over-64 rejected, duplicates
 * removed, sorted, at most 32 distinct tags.
 */
export function normalizeTags(values: unknown): Result<string[], ContentRuleError> {
  if (!Array.isArray(values)) return err('invalid_tags');
  const tags = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') return err('invalid_tags');
    const tag = normalizeTag(value);
    if (tag === '') return err('tag_empty');
    if (textLength(tag) > CONTENT_LIMITS.tagMax) return err('tag_too_long');
    tags.add(tag);
  }
  if (tags.size > CONTENT_LIMITS.tagsMax) return err('too_many_tags');
  return ok([...tags].sort());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Case-insensitive identity of a custom-field label. */
function labelKey(label: string): string {
  return label.normalize('NFC').toLowerCase();
}

/**
 * Free-form custom fields (D-01): an object of at most 32 label -> string value pairs; labels are
 * trimmed, 1..64, unique case-insensitively; values are strings of 0..1,000. Returns the stored
 * form (trimmed labels, input order).
 */
export function normalizeCustomFields(
  value: unknown,
): Result<Record<string, string>, ContentRuleError> {
  if (!isPlainObject(value)) return err('invalid_fields');
  const entries = Object.entries(value);
  if (entries.length > CONTENT_LIMITS.fieldsMax) return err('too_many_fields');
  const seen = new Set<string>();
  const fields: Record<string, string> = {};
  for (const [rawLabel, rawValue] of entries) {
    const label = rawLabel.trim();
    if (label === '') return err('field_label_empty');
    if (textLength(label) > CONTENT_LIMITS.fieldLabelMax) return err('field_label_too_long');
    const key = labelKey(label);
    if (seen.has(key)) return err('duplicate_field_label');
    seen.add(key);
    if (typeof rawValue !== 'string') return err('invalid_field_value');
    if (textLength(rawValue) > CONTENT_LIMITS.fieldValueMax) return err('field_value_too_long');
    // A define, not an assignment: a free-form label such as `__proto__` stays a field.
    Object.defineProperty(fields, label, {
      value: rawValue,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return ok(fields);
}

/**
 * Type membership. `create` needs a configured, enabled type; an `existing` record keeps any
 * well-formed type, so removing or disabling a type never invalidates stored rows (`_bdd.md` "A
 * type removed from configuration does not lose data").
 */
export function checkEntityType(
  typeId: unknown,
  purpose: 'create' | 'existing',
  config: ContentConfiguration = CONTENT_CONFIGURATION,
): Result<EntityTypeDefinition | undefined, ContentRuleError> {
  if (typeof typeId !== 'string' || !CONTENT_TOKEN_PATTERN.test(typeId)) {
    return err('invalid_type');
  }
  const definition = config.type(typeId);
  if (purpose === 'existing') return ok(definition);
  if (definition === undefined || !definition.enabled) return err('unknown_type');
  return ok(definition);
}

/** Relationship kinds come from configuration (D-08). */
export function checkRelationshipKind(
  kind: unknown,
  config: ContentConfiguration = CONTENT_CONFIGURATION,
): Result<RelationshipKindDefinition, ContentRuleError> {
  const definition = typeof kind === 'string' ? config.kind(kind) : undefined;
  return definition === undefined ? err('unknown_kind') : ok(definition);
}

export interface QuickCreateDraft {
  readonly type: string;
  readonly name: string;
  readonly summary: string;
}

/**
 * Quick create (FR-005, BR-003): a name, optionally the one-line summary, and the type of the
 * entry point (else the configured default, D-09). Nothing else is asked for; Visibility is the
 * policy default.
 */
export function prepareQuickCreate(
  input: { readonly type?: string; readonly name: unknown; readonly summary?: unknown },
  config: ContentConfiguration = CONTENT_CONFIGURATION,
): Result<QuickCreateDraft, ContentRuleError> {
  const type = input.type ?? config.defaultQuickCreateType;
  const typeCheck = checkEntityType(type, 'create', config);
  if (!typeCheck.ok) return typeCheck;
  const name = normalizeName(input.name);
  if (!name.ok) return name;
  const summary = checkSummary(input.summary ?? '');
  if (!summary.ok) return summary;
  return ok({ type, name: name.value, summary: summary.value });
}

/* ------------------------------------------------------------------------------------------
 * Visibility intersection and the relationship bound (`_db.md` "Visibility Invariant for
 * Relationships", D-07 option A). In the feature 04 decision sense a Visibility is an audience:
 * `gm_only` is the GM roles (bottom), `everyone` every reader (top), `players(A)` the GM roles
 * plus A. `party` is unreachable in P0 and fails closed (treated as `gm_only`).
 * ---------------------------------------------------------------------------------------- */

const GM_ONLY_VISIBILITY: Visibility = { mode: 'gm_only' };

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** Narrowest audience readable under both `a` and `b`: `players(A) ∩ players(B) = players(A ∩ B)`. */
export function intersectVisibility(a: Visibility, b: Visibility): Visibility {
  if (a.mode === 'party' || b.mode === 'party') return GM_ONLY_VISIBILITY;
  if (a.mode === 'gm_only' || b.mode === 'gm_only') return GM_ONLY_VISIBILITY;
  if (a.mode === 'everyone') return normalize(b);
  if (b.mode === 'everyone') return normalize(a);
  const right = new Set(b.playerIds);
  const shared = sortedUnique(a.playerIds.filter((id) => right.has(id)));
  return shared.length === 0 ? GM_ONLY_VISIBILITY : { mode: 'players', playerIds: shared };
}

function normalize(visibility: Visibility): Visibility {
  if (visibility.mode === 'players') {
    return { mode: 'players', playerIds: sortedUnique(visibility.playerIds) };
  }
  return visibility.mode === 'party' ? GM_ONLY_VISIBILITY : visibility;
}

/** Every actor who may read under `inner` may also read under `outer`. */
export function visibilityWithin(inner: Visibility, outer: Visibility): boolean {
  if (inner.mode === 'gm_only') return true;
  if (inner.mode === 'party') return false;
  switch (outer.mode) {
    case 'everyone':
      return true;
    case 'players': {
      if (inner.mode !== 'players') return false;
      const allowed = new Set(outer.playerIds);
      return inner.playerIds.every((id) => allowed.has(id));
    }
    default:
      return false;
  }
}

/** Relationship bound: `rel ⊆ source ∩ target`. */
export function isWithin(rel: Visibility, source: Visibility, target: Visibility): boolean {
  return visibilityWithin(rel, intersectVisibility(source, target));
}

/** The live relationships among `rows` that break the bound (`_db.md` invariant assertion). */
export function relationshipBoundViolations<
  T extends {
    readonly visibility: Visibility;
    readonly source: Visibility;
    readonly target: Visibility;
  },
>(rows: readonly T[]): T[] {
  return rows.filter((row) => !isWithin(row.visibility, row.source, row.target));
}
