import type { Visibility } from '@rpg/contracts';

/**
 * Feature 16 type and relationship-kind configuration (`_techspec.md` "Proposed Architecture",
 * D-01, D-02, D-08, D-09; ADR-001 generic entity model).
 *
 * Data only. Adding an entity type or a relationship kind is an entry here and nothing else: no
 * screen, route, table, migration, or sync rule changes (`_bdd.md` "A new type needs configuration
 * only"). This is the only production file that may name a type identifier; the architecture guard
 * (`no-entity-type-branch`) rejects type literals and branches on a type anywhere else.
 */

/** Token shape of a type or relationship-kind identifier (`_db.md` CHECK). */
export const CONTENT_TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export interface EntityTypeDefinition {
  readonly id: string;
  readonly label: string;
  readonly pluralLabel: string;
  /** Quick create asks for the name plus this one field (FR-005, D-09). */
  readonly quickCreate: { readonly secondField: 'summary' };
  /** A disabled type keeps its existing records readable and deletable; it cannot be created. */
  readonly enabled: boolean;
  /**
   * Feature 17 D-06: attachments are uploaded with their own Visibility `everyone`, so feature 05's
   * intersection follows the entity as it is revealed and hidden. Otherwise an upload copies the
   * entity's Visibility at that moment (feature 16 task 13).
   */
  readonly attachmentsFollowEntity?: boolean;
}

export interface RelationshipKindDefinition {
  readonly id: string;
  /** Label read from the source entity (`Smuggler` member of `River Guild`). */
  readonly label: string;
  /** Label read from the target entity (`River Guild` has member `Smuggler`). */
  readonly inverseLabel: string;
}

/** MVP entity types (FR-002, D-02: `scene` is an enabled feature 16 type; feature 17 adds `handout`). */
export const ENTITY_TYPES: readonly EntityTypeDefinition[] = [
  {
    id: 'npc',
    label: 'NPC',
    pluralLabel: 'NPCs',
    quickCreate: { secondField: 'summary' },
    enabled: true,
  },
  {
    id: 'creature',
    label: 'Creature',
    pluralLabel: 'Creatures',
    quickCreate: { secondField: 'summary' },
    enabled: true,
  },
  {
    id: 'location',
    label: 'Location',
    pluralLabel: 'Locations',
    quickCreate: { secondField: 'summary' },
    enabled: true,
  },
  {
    id: 'item',
    label: 'Item',
    pluralLabel: 'Items',
    quickCreate: { secondField: 'summary' },
    enabled: true,
  },
  {
    id: 'faction',
    label: 'Faction',
    pluralLabel: 'Factions',
    quickCreate: { secondField: 'summary' },
    enabled: true,
  },
  {
    id: 'note',
    label: 'Note',
    pluralLabel: 'Notes',
    quickCreate: { secondField: 'summary' },
    enabled: true,
  },
  {
    id: 'scene',
    label: 'Scene',
    pluralLabel: 'Scenes',
    quickCreate: { secondField: 'summary' },
    enabled: true,
  },
  // Feature 17 D-01: a handout is an entity type; its body is the description.
  {
    id: 'handout',
    label: 'Handout',
    pluralLabel: 'Handouts',
    quickCreate: { secondField: 'summary' },
    enabled: true,
    attachmentsFollowEntity: true,
  },
];

/** Feature 17: the handout type's id, for the handout screen's filter. */
export const HANDOUT_ENTITY_TYPE = 'handout';

/** Feature 18 D-02: the type Session Mode sets as the current scene, and the kinds that place it. */
export const SCENE_ENTITY_TYPE = 'scene';
export const LOCATED_AT_KIND = 'located_at';
export const APPEARS_IN_KIND = 'appears_in';

/**
 * Feature 19 D-02, D-03: the types an encounter draws participants from, the type an improvised enemy is created
 * as, and the type an encounter's location names.
 */
export const ENCOUNTER_SOURCE_TYPES: readonly string[] = ['creature', 'npc'];
export const AD_HOC_PARTICIPANT_TYPE = 'creature';
export const LOCATION_ENTITY_TYPE = 'location';

/** Relationship kinds (D-08). No source/target type restrictions in P0. */
export const RELATIONSHIP_KINDS: readonly RelationshipKindDefinition[] = [
  { id: 'member_of', label: 'member of', inverseLabel: 'has member' },
  { id: 'lives_at', label: 'lives at', inverseLabel: 'has resident' },
  { id: 'located_at', label: 'located at', inverseLabel: 'location of' },
  { id: 'knows', label: 'knows', inverseLabel: 'known by' },
  { id: 'owns', label: 'owns', inverseLabel: 'owned by' },
  { id: 'appears_in', label: 'appears in', inverseLabel: 'features' },
  { id: 'related_to', label: 'related to', inverseLabel: 'related to' },
];

/** Quick create from an entry point that implies no type (D-09). */
export const DEFAULT_QUICK_CREATE_TYPE = 'note';

/** A quick-create entry point: its label and the type it creates (FR-005, D-09). */
export interface QuickCreateEntryPoint {
  readonly id: string;
  readonly label: string;
  readonly type: string;
}

/**
 * Entity-screen quick-create entry points (`_techspec.md` "Web": Add NPC, Add location, Add
 * note). The generic "New entity" entry point has no type and creates the default (D-09).
 */
export const QUICK_CREATE_ENTRY_POINTS: readonly QuickCreateEntryPoint[] = [
  { id: 'add_npc', label: 'Add NPC', type: 'npc' },
  { id: 'add_location', label: 'Add location', type: 'location' },
  { id: 'add_note', label: 'Add note', type: 'note' },
];

/**
 * Session Mode quick actions (D-14): feature 16 ships them as frozen `SessionQuickAction`s whose
 * `invoke` opens its own quick-create overlay; feature 18 places them.
 */
export const SESSION_QUICK_CREATE_ENTRY_POINTS: readonly QuickCreateEntryPoint[] = [
  { id: 'content.add_npc', label: 'Add NPC', type: 'npc' },
  { id: 'content.add_note', label: 'Add note', type: 'note' },
];

/**
 * `type` value of a personal note in its replica record mapping (`_techspec.md`
 * `PersonalNoteRecord`). Personal notes live in their own table and class; this is a label for
 * the envelope, never a key into the entity type configuration.
 */
export const PERSONAL_NOTE_RECORD_TYPE = 'note';

/**
 * `type` value of a relationship in its replica record mapping (`RelationshipRecord`); its `name` is
 * the kind label. Not an entity type.
 */
export const RELATIONSHIP_RECORD_TYPE = 'relationship';

export type ContentConfigurationProblem =
  | 'invalid_type_id'
  | 'duplicate_type_id'
  | 'invalid_type_label'
  | 'invalid_kind_id'
  | 'duplicate_kind_id'
  | 'invalid_kind_label'
  | 'invalid_default_type';

export class ContentConfigurationError extends Error {
  constructor(
    readonly problem: ContentConfigurationProblem,
    readonly id: string,
  ) {
    super(`invalid_content_configuration: ${problem} (${id})`);
    this.name = 'ContentConfigurationError';
  }
}

/** Validated, indexed configuration. Every pure rule takes one, so tests can add a type. */
export interface ContentConfiguration {
  readonly types: readonly EntityTypeDefinition[];
  readonly kinds: readonly RelationshipKindDefinition[];
  readonly defaultQuickCreateType: string;
  type(id: string): EntityTypeDefinition | undefined;
  kind(id: string): RelationshipKindDefinition | undefined;
}

function label(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Validates a type/kind registry (unique IDs, token pattern, non-empty labels and inverse labels)
 * and indexes it. Throws `ContentConfigurationError`, so a broken configuration never starts.
 */
/** The Visibility an upload on an entity of this type carries (feature 17 D-06). */
export function attachmentVisibilityFor(
  type: string,
  entityVisibility: Visibility,
  configuration: ContentConfiguration = CONTENT_CONFIGURATION,
): Visibility {
  return configuration.types.find((definition) => definition.id === type)
    ?.attachmentsFollowEntity === true
    ? { mode: 'everyone' }
    : entityVisibility;
}

export function defineContentConfiguration(input: {
  readonly types: readonly EntityTypeDefinition[];
  readonly kinds: readonly RelationshipKindDefinition[];
  readonly defaultQuickCreateType?: string;
}): ContentConfiguration {
  const types = new Map<string, EntityTypeDefinition>();
  for (const definition of input.types) {
    const id = String(definition.id);
    if (!CONTENT_TOKEN_PATTERN.test(id)) throw new ContentConfigurationError('invalid_type_id', id);
    if (types.has(id)) throw new ContentConfigurationError('duplicate_type_id', id);
    if (
      !label(definition.label) ||
      !label(definition.pluralLabel) ||
      definition.quickCreate?.secondField !== 'summary' ||
      typeof definition.enabled !== 'boolean'
    ) {
      throw new ContentConfigurationError('invalid_type_label', id);
    }
    types.set(id, definition);
  }
  const kinds = new Map<string, RelationshipKindDefinition>();
  for (const definition of input.kinds) {
    const id = String(definition.id);
    if (!CONTENT_TOKEN_PATTERN.test(id)) throw new ContentConfigurationError('invalid_kind_id', id);
    if (kinds.has(id)) throw new ContentConfigurationError('duplicate_kind_id', id);
    if (!label(definition.label) || !label(definition.inverseLabel)) {
      throw new ContentConfigurationError('invalid_kind_label', id);
    }
    kinds.set(id, definition);
  }
  const defaultQuickCreateType = input.defaultQuickCreateType ?? DEFAULT_QUICK_CREATE_TYPE;
  if (types.get(defaultQuickCreateType)?.enabled !== true) {
    throw new ContentConfigurationError('invalid_default_type', defaultQuickCreateType);
  }
  return {
    types: [...types.values()],
    kinds: [...kinds.values()],
    defaultQuickCreateType,
    type: (id) => types.get(id),
    kind: (id) => kinds.get(id),
  };
}

/** The application's configuration. */
export const CONTENT_CONFIGURATION: ContentConfiguration = defineContentConfiguration({
  types: ENTITY_TYPES,
  kinds: RELATIONSHIP_KINDS,
});
