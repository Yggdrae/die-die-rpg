import {
  CAMPAIGN_ENTITY_POLICY,
  CONTENT_CONFIGURATION,
  type ContentConfiguration,
  type ContentRuleError,
  ENTITY_RELATIONSHIP_POLICY,
  type EntityRecord,
  type LocalContentError,
  type LocalRelationshipError,
  normalizeCustomFields,
  normalizeTag,
  PERSONAL_NOTE_POLICY,
  type RelationshipRecord,
} from '@rpg/content';
import { err, type Result, type Role, type Visibility } from '@rpg/contracts';

/**
 * Pure model of the feature 16 screens. Labels come from the type configuration only; nothing
 * here branches on a type identifier (ADR-001) or compares a role to a literal (feature 04):
 * affordances are read from the registered Resource Policies for the cached role, as hints. The
 * authority re-decides every write.
 */

export function typeLabel(type: string, config: ContentConfiguration = CONTENT_CONFIGURATION) {
  return config.type(type)?.label ?? type;
}

/** Filter options: every configured type (a disabled type's records stay listable). */
export function typeOptions(config: ContentConfiguration = CONTENT_CONFIGURATION) {
  return config.types.map((definition) => ({ id: definition.id, label: definition.pluralLabel }));
}

/** Types a new entity or a type change may use (enabled only). */
export function creatableTypes(config: ContentConfiguration = CONTENT_CONFIGURATION) {
  return config.types.filter((definition) => definition.enabled);
}

export function tagOptions(records: readonly EntityRecord[]): string[] {
  return [...new Set(records.flatMap((record) => record.tags))].sort();
}

/** Visibility modes present among the permitted rows (a filter narrows, never widens). */
export function visibilityOptions(records: readonly EntityRecord[]): Visibility['mode'][] {
  const order: Visibility['mode'][] = ['gm_only', 'players', 'everyone', 'party'];
  const present = new Set(records.map((record) => record.visibility.mode));
  return order.filter((mode) => present.has(mode));
}

/** Comma-separated tag input → tags (normalized by the repository, D-18). */
export function parseTagInput(text: string): string[] {
  return text
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/** Suggestions for the fragment after the last comma, from tags on locally visible rows. */
export function tagSuggestions(records: readonly EntityRecord[], input: string, limit = 10) {
  const typed = parseTagInput(input).map(normalizeTag);
  const fragment = normalizeTag(input.split(',').at(-1) ?? '');
  return tagOptions(records)
    .filter((tag) => tag.startsWith(fragment) && !typed.includes(tag))
    .slice(0, limit);
}

/** One editable custom-field row (D-01); `key` is a stable local row id, never stored. */
export interface CustomFieldRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** Custom fields sorted by label (case-insensitive, then exact), for detail and editor rows. */
export function sortedFields(fields: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(fields).sort(
    ([left], [right]) =>
      left.toLowerCase().localeCompare(right.toLowerCase()) || (left < right ? -1 : 1),
  );
}

export function customFieldRows(fields: Readonly<Record<string, string>>): CustomFieldRow[] {
  return sortedFields(fields).map(([label, value], index) => ({ key: `f${index}`, label, value }));
}

/**
 * Editor rows -> the stored `fields` object, validated by the same D-01 rule the authority runs
 * (`normalizeCustomFields`). A row left completely blank is ignored; two rows with the same label
 * are a duplicate (an object would otherwise keep only one of them).
 */
export function fieldsFromRows(
  rows: readonly CustomFieldRow[],
): Result<Record<string, string>, ContentRuleError> {
  const filled = rows.filter((row) => row.label.trim() !== '' || row.value !== '');
  const fields: Record<string, string> = {};
  for (const row of filled) {
    if (Object.hasOwn(fields, row.label)) return err('duplicate_field_label');
    Object.defineProperty(fields, row.label, {
      value: row.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return normalizeCustomFields(fields);
}

export interface ContentAffordances {
  readonly readEntities: boolean;
  readonly createEntities: boolean;
  readonly editEntities: boolean;
  readonly deleteEntities: boolean;
  readonly linkEntities: boolean;
  readonly personalNotes: boolean;
}

function allows(
  policy: typeof CAMPAIGN_ENTITY_POLICY,
  role: string | undefined,
  capability: string,
): boolean {
  if (role === undefined || !(role in policy.roleCapabilities)) return false;
  return (policy.roleCapabilities[role as Role] as readonly string[]).includes(capability);
}

/** Which entry points and controls appear, from the declarations and the cached role (hints). */
export function contentAffordances(role: string | undefined): ContentAffordances {
  return {
    readEntities: allows(CAMPAIGN_ENTITY_POLICY, role, 'read'),
    createEntities: allows(CAMPAIGN_ENTITY_POLICY, role, 'create'),
    editEntities: allows(CAMPAIGN_ENTITY_POLICY, role, 'update'),
    deleteEntities: allows(CAMPAIGN_ENTITY_POLICY, role, 'delete'),
    linkEntities: allows(ENTITY_RELATIONSHIP_POLICY, role, 'create'),
    personalNotes: allows(PERSONAL_NOTE_POLICY, role, 'create'),
  };
}

export interface RelationshipView {
  readonly link: RelationshipRecord;
  /** Read from this entity: `member of` (source) or `has member` (target). */
  readonly label: string;
  readonly otherId: string;
  /** Undefined when the other endpoint is not in the replica (only possible while syncing). */
  readonly otherName?: string;
  readonly otherType?: string;
  readonly otherDeleted: boolean;
}

/** Both directions of an entity's live links; a tombstoned endpoint renders as deleted (BR-004). */
export function relationshipViews(
  links: readonly RelationshipRecord[],
  entityId: string,
  entities: ReadonlyMap<string, EntityRecord>,
  config: ContentConfiguration = CONTENT_CONFIGURATION,
): RelationshipView[] {
  return links
    .filter((link) => link.deletedAt === undefined)
    .filter((link) => link.sourceEntityId === entityId || link.targetEntityId === entityId)
    .map((link) => {
      const outgoing = link.sourceEntityId === entityId;
      const otherId = outgoing ? link.targetEntityId : link.sourceEntityId;
      const kind = config.kind(link.kind);
      const other = entities.get(otherId);
      return {
        link,
        label: (outgoing ? kind?.label : kind?.inverseLabel) ?? link.kind,
        otherId,
        ...(other === undefined ? {} : { otherName: other.name, otherType: other.type }),
        otherDeleted: other?.deletedAt !== undefined,
      };
    })
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        (left.otherName ?? '').localeCompare(right.otherName ?? '') ||
        left.link.id.localeCompare(right.link.id),
    );
}

const RULE_MESSAGES: Readonly<Record<string, string>> = {
  name_required: 'A name is required.',
  name_too_long: 'The name is too long (200 characters at most).',
  invalid_text: 'The text is not valid.',
  summary_too_long: 'The summary is too long (280 characters at most).',
  long_text_too_long: 'The text is too long (50,000 characters at most).',
  invalid_tags: 'The tags are not valid.',
  tag_empty: 'A tag cannot be empty.',
  tag_too_long: 'A tag is too long (64 characters at most).',
  too_many_tags: 'Too many tags (32 at most).',
  invalid_fields: 'The custom fields are not valid.',
  too_many_fields: 'Too many custom fields (32 at most).',
  field_label_empty: 'A custom field needs a label.',
  field_label_too_long: 'A custom field label is too long (64 characters at most).',
  duplicate_field_label: 'Two custom fields have the same label (labels ignore case).',
  invalid_field_value: 'A custom field value is not valid.',
  field_value_too_long: 'A custom field value is too long (1,000 characters at most).',
  invalid_type: 'That type is not available.',
  unknown_type: 'That type is not available.',
  unknown_kind: 'That relationship kind is not available.',
  self_link: 'An entity cannot be linked to itself.',
  invalid_endpoint: 'Both entities must exist and not be deleted.',
  incompatible_visibility: 'That link would be visible to more people than one of its entities.',
  duplicate_relationship: 'That link already exists.',
  not_found: 'This record is no longer available on this device.',
};

/** Safe, user-facing text for a local rule or repository failure. */
export function contentErrorMessage(error: LocalContentError | LocalRelationshipError): string {
  if (typeof error === 'string') return RULE_MESSAGES[error] ?? 'The change was not saved.';
  if ('kind' in error && error.kind === 'version_conflict') {
    return 'This record changed on this device since you opened it. Reopen it and try again.';
  }
  if ('kind' in error && error.kind === 'not_found') return RULE_MESSAGES.not_found ?? '';
  if ('message' in error) return error.message;
  return 'The change was not saved.';
}
