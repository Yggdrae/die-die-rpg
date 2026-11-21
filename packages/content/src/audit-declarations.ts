import { type TSchema, Type } from '@sinclair/typebox';
import { CONTENT_AUDIT_ACTIONS } from './audit-actions.ts';
import { CONTENT_CONFIGURATION } from './types.ts';

/**
 * Feature 16 audit contributions (feature 06 FR-005, FR-006; `_techspec.md` "Mutation Appliers").
 * Structural shape of feature 06's `AuditEventDeclaration` (this package does not depend on
 * `@rpg/audit`); `createAuditRendererRegistry()` in the API registers them.
 *
 * `before`/`after` carry only changed structured fields (type, name, summary, tags, kind,
 * endpoints). Long text, custom fields, and metadata are recorded as `{ changed: [...] }`, never
 * their text, labels, or values; the payload schemas reject anything else. Renderers read only
 * those already-authorized display values, truncate them, and never echo raw JSON.
 */
export interface ContentAuditDeclaration {
  readonly action: string;
  readonly version: number;
  readonly payload?: TSchema;
  render(event: {
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly before?: Record<string, unknown>;
    readonly after?: Record<string, unknown>;
    readonly at: string;
  }): { readonly text: string };
}

/** Fields whose content is never recorded, only that they changed. */
export const ENTITY_UNRECORDED_FIELDS = ['description', 'fields', 'metadata'] as const;
export const PERSONAL_NOTE_UNRECORDED_FIELDS = ['body', 'metadata'] as const;

const Changed = (fields: readonly string[]) =>
  Type.Array(Type.Union(fields.map((field) => Type.Literal(field))), { maxItems: fields.length });

const Tags = Type.Array(Type.String(), { maxItems: 32 });

export const EntityAuditValue = Type.Object(
  {
    type: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    tags: Type.Optional(Tags),
    changed: Type.Optional(Changed(ENTITY_UNRECORDED_FIELDS)),
  },
  { additionalProperties: false },
);

export const PersonalNoteAuditValue = Type.Object(
  {
    name: Type.Optional(Type.String()),
    tags: Type.Optional(Tags),
    changed: Type.Optional(Changed(PERSONAL_NOTE_UNRECORDED_FIELDS)),
  },
  { additionalProperties: false },
);

export const RelationshipAuditValue = Type.Object(
  {
    kind: Type.Optional(Type.String()),
    sourceEntityId: Type.Optional(Type.String()),
    targetEntityId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

function text(value: unknown, limit = 60): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function typeLabel(value: unknown): string {
  const definition = typeof value === 'string' ? CONTENT_CONFIGURATION.type(value) : undefined;
  return definition?.label ?? 'entity';
}

function kindLabel(value: unknown): string | undefined {
  return typeof value === 'string' ? CONTENT_CONFIGURATION.kind(value)?.label : undefined;
}

function named(prefix: string, name: string | undefined): string {
  return name === undefined ? `${prefix}.` : `${prefix} "${name}".`;
}

const FIELD_WORDS: Readonly<Record<string, string>> = {
  type: 'type',
  name: 'name',
  summary: 'summary',
  tags: 'tags',
  description: 'description',
  fields: 'custom fields',
  metadata: 'metadata',
  body: 'text',
};

/**
 * Changed field names in a fixed order, as words; never values. An update's `before` holds
 * exactly the changed structured fields; `after.changed` names the unrecorded ones.
 */
function changes(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  structured: readonly string[],
): string[] {
  const words: string[] = [];
  for (const field of structured) {
    if (before !== undefined && field in before) {
      const word = FIELD_WORDS[field];
      if (word !== undefined) words.push(word);
    }
  }
  const changed = Array.isArray(after?.changed) ? after.changed : [];
  for (const field of Object.keys(FIELD_WORDS)) {
    if (changed.includes(field)) words.push(FIELD_WORDS[field] as string);
  }
  return [...new Set(words)];
}

function renamed(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): { readonly from: string; readonly to: string } | undefined {
  const from = text(before?.name);
  const to = text(after?.name);
  return from !== undefined && to !== undefined && from !== to ? { from, to } : undefined;
}

export const CONTENT_AUDIT_DECLARATIONS: readonly ContentAuditDeclaration[] = [
  {
    action: CONTENT_AUDIT_ACTIONS.created,
    version: 1,
    payload: EntityAuditValue,
    render: ({ after }) => ({
      text: named(`Created ${typeLabel(after?.type)}`, text(after?.name)),
    }),
  },
  {
    action: CONTENT_AUDIT_ACTIONS.updated,
    version: 1,
    payload: EntityAuditValue,
    render: ({ before, after }) => {
      const label = typeLabel(after?.type ?? before?.type);
      const rename = renamed(before, after);
      const others = changes(before, after, ['type', 'summary', 'tags']);
      const head =
        rename === undefined
          ? `Updated ${label}.`
          : `Renamed ${label} "${rename.from}" to "${rename.to}".`;
      return { text: others.length === 0 ? head : `${head} Changed: ${others.join(', ')}.` };
    },
  },
  {
    action: CONTENT_AUDIT_ACTIONS.deleted,
    version: 1,
    payload: EntityAuditValue,
    render: ({ before }) => ({
      text: named(`Deleted ${typeLabel(before?.type)}`, text(before?.name)),
    }),
  },
  {
    action: CONTENT_AUDIT_ACTIONS.relationshipCreated,
    version: 1,
    payload: RelationshipAuditValue,
    render: ({ after }) => {
      const kind = kindLabel(after?.kind);
      return {
        text: kind === undefined ? 'Linked two entities.' : `Linked two entities (${kind}).`,
      };
    },
  },
  {
    action: CONTENT_AUDIT_ACTIONS.relationshipDeleted,
    version: 1,
    payload: RelationshipAuditValue,
    render: ({ before }) => {
      const kind = kindLabel(before?.kind);
      return {
        text: kind === undefined ? 'Removed a link.' : `Removed a link (${kind}).`,
      };
    },
  },
  {
    action: CONTENT_AUDIT_ACTIONS.personalNoteCreated,
    version: 1,
    payload: PersonalNoteAuditValue,
    render: ({ after }) => ({ text: named('Created a personal note', text(after?.name)) }),
  },
  {
    action: CONTENT_AUDIT_ACTIONS.personalNoteUpdated,
    version: 1,
    payload: PersonalNoteAuditValue,
    render: ({ before, after }) => {
      const rename = renamed(before, after);
      const others = changes(before, after, ['tags']);
      const head =
        rename === undefined
          ? 'Updated a personal note.'
          : `Renamed a personal note "${rename.from}" to "${rename.to}".`;
      return { text: others.length === 0 ? head : `${head} Changed: ${others.join(', ')}.` };
    },
  },
  {
    action: CONTENT_AUDIT_ACTIONS.personalNoteDeleted,
    version: 1,
    payload: PersonalNoteAuditValue,
    render: ({ before }) => ({ text: named('Deleted a personal note', text(before?.name)) }),
  },
];
