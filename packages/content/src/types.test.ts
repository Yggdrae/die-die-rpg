import { describe, expect, test } from 'bun:test';
import {
  CONTENT_CONFIGURATION,
  ContentConfigurationError,
  defineContentConfiguration,
  ENTITY_TYPES,
  type EntityTypeDefinition,
  QUICK_CREATE_ENTRY_POINTS,
  RELATIONSHIP_KINDS,
  type RelationshipKindDefinition,
  SESSION_QUICK_CREATE_ENTRY_POINTS,
} from './types.ts';

function type(id: string, overrides: Partial<EntityTypeDefinition> = {}): EntityTypeDefinition {
  return {
    id,
    label: id,
    pluralLabel: `${id}s`,
    quickCreate: { secondField: 'summary' },
    enabled: true,
    ...overrides,
  };
}

function problemOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    if (error instanceof ContentConfigurationError) return error.problem;
    throw error;
  }
  return undefined;
}

describe('type configuration (FR-002, FR-003, D-02)', () => {
  test('the MVP types are configured, all enabled, each quick-created with a summary', () => {
    expect(CONTENT_CONFIGURATION.types.map((item) => item.id)).toEqual([
      'npc',
      'creature',
      'location',
      'item',
      'faction',
      'note',
      'scene',
      'handout',
    ]);
    for (const definition of ENTITY_TYPES) {
      expect(definition.enabled).toBe(true);
      expect(definition.quickCreate.secondField).toBe('summary');
      expect(definition.label.trim()).not.toBe('');
      expect(definition.pluralLabel.trim()).not.toBe('');
    }
    // D-09: the default quick-create type is configured and enabled.
    expect(CONTENT_CONFIGURATION.type(CONTENT_CONFIGURATION.defaultQuickCreateType)?.enabled).toBe(
      true,
    );
  });

  test('registry validation rejects duplicate ids, bad tokens, and empty labels', () => {
    const kinds: RelationshipKindDefinition[] = [];
    expect(
      problemOf(() => defineContentConfiguration({ types: [type('a'), type('a')], kinds })),
    ).toBe('duplicate_type_id');
    for (const id of ['Villain', '1npc', 'npc-x', '', 'a'.repeat(65)]) {
      expect(problemOf(() => defineContentConfiguration({ types: [type(id)], kinds }))).toBe(
        'invalid_type_id',
      );
    }
    expect(
      problemOf(() => defineContentConfiguration({ types: [type('a', { label: ' ' })], kinds })),
    ).toBe('invalid_type_label');
    expect(problemOf(() => defineContentConfiguration({ types: [type('a')], kinds }))).toBe(
      'invalid_default_type',
    );
    expect(
      problemOf(() =>
        defineContentConfiguration({
          types: [type('note', { enabled: false })],
          kinds,
        }),
      ),
    ).toBe('invalid_default_type');
    const types = [type('note')];
    expect(
      problemOf(() =>
        defineContentConfiguration({
          types,
          kinds: [
            { id: 'knows', label: 'knows', inverseLabel: 'known by' },
            { id: 'knows', label: 'knows', inverseLabel: 'known by' },
          ],
        }),
      ),
    ).toBe('duplicate_kind_id');
    expect(
      problemOf(() =>
        defineContentConfiguration({
          types,
          kinds: [{ id: 'knows', label: 'knows', inverseLabel: '' }],
        }),
      ),
    ).toBe('invalid_kind_label');
    expect(
      problemOf(() =>
        defineContentConfiguration({
          types,
          kinds: [{ id: 'Knows', label: 'knows', inverseLabel: 'known by' }],
        }),
      ),
    ).toBe('invalid_kind_id');
  });
});

describe('relationship kinds (D-08)', () => {
  test('the configured kinds, each with a non-empty inverse label', () => {
    expect(RELATIONSHIP_KINDS.map((kind) => [kind.id, kind.label, kind.inverseLabel])).toEqual([
      ['member_of', 'member of', 'has member'],
      ['lives_at', 'lives at', 'has resident'],
      ['located_at', 'located at', 'location of'],
      ['knows', 'knows', 'known by'],
      ['owns', 'owns', 'owned by'],
      ['appears_in', 'appears in', 'features'],
      ['related_to', 'related to', 'related to'],
    ]);
    for (const kind of CONTENT_CONFIGURATION.kinds) {
      expect(kind.inverseLabel.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('quick-create entry points (D-09, D-14)', () => {
  test('every entry point names an enabled configured type; session actions are namespaced', () => {
    for (const entry of [...QUICK_CREATE_ENTRY_POINTS, ...SESSION_QUICK_CREATE_ENTRY_POINTS]) {
      expect(CONTENT_CONFIGURATION.type(entry.type)?.enabled).toBe(true);
      expect(entry.label.trim()).not.toBe('');
    }
    expect(SESSION_QUICK_CREATE_ENTRY_POINTS.map((entry) => [entry.id, entry.type])).toEqual([
      ['content.add_npc', 'npc'],
      ['content.add_note', 'note'],
    ]);
    expect(QUICK_CREATE_ENTRY_POINTS.map((entry) => entry.label)).toEqual([
      'Add NPC',
      'Add location',
      'Add note',
    ]);
  });
});
