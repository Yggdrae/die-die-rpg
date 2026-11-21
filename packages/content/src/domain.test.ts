import { describe, expect, test } from 'bun:test';
import { check, type Visibility } from '@rpg/contracts';
import {
  CONTENT_LIMITS,
  checkEntityType,
  checkLongText,
  checkRelationshipKind,
  checkSummary,
  intersectVisibility,
  isWithin,
  normalizeCustomFields,
  normalizeName,
  normalizeTag,
  normalizeTags,
  prepareQuickCreate,
  visibilityWithin,
} from './domain.ts';
import {
  EntityReplicaSchema,
  PersonalNoteReplicaSchema,
  QuickCreateInput,
  RelationshipReplicaSchema,
} from './schemas.ts';
import {
  CONTENT_CONFIGURATION,
  defineContentConfiguration,
  ENTITY_TYPES,
  RELATIONSHIP_KINDS,
} from './types.ts';

const errorOf = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? undefined : result.error;

describe('Type as Configuration (BR-001, FR-003)', () => {
  // `_bdd.md` "A new type needs configuration only": a test-local configuration adds `vehicle`;
  // no rule changes.
  const withVehicle = defineContentConfiguration({
    types: [
      ...ENTITY_TYPES,
      {
        id: 'vehicle',
        label: 'Vehicle',
        pluralLabel: 'Vehicles',
        quickCreate: { secondField: 'summary' },
        enabled: true,
      },
    ],
    kinds: RELATIONSHIP_KINDS,
  });

  test('A new type needs configuration only: every pure rule accepts it', () => {
    expect(checkEntityType('vehicle', 'create', withVehicle).ok).toBe(true);
    expect(checkEntityType('vehicle', 'existing', withVehicle).ok).toBe(true);
    expect(prepareQuickCreate({ type: 'vehicle', name: ' Cart ' }, withVehicle)).toEqual({
      ok: true,
      value: { type: 'vehicle', name: 'Cart', summary: '' },
    });
    expect(checkEntityType('vehicle', 'create').ok).toBe(false);
  });

  test('A type removed from configuration does not lose data', () => {
    // Removed (absent from the default configuration) or disabled: create rejected, existing kept.
    const disabled = defineContentConfiguration({
      types: [
        ...ENTITY_TYPES,
        {
          id: 'vehicle',
          label: 'Vehicle',
          pluralLabel: 'Vehicles',
          quickCreate: { secondField: 'summary' },
          enabled: false,
        },
      ],
      kinds: RELATIONSHIP_KINDS,
    });
    for (const config of [CONTENT_CONFIGURATION, disabled]) {
      expect(errorOf(checkEntityType('vehicle', 'create', config))).toBe('unknown_type');
      expect(checkEntityType('vehicle', 'existing', config).ok).toBe(true);
    }
  });

  test('An unknown type is rejected for create (villain)', () => {
    expect(errorOf(checkEntityType('villain', 'create'))).toBe('unknown_type');
    expect(errorOf(prepareQuickCreate({ type: 'villain', name: 'Mordo' }))).toBe('unknown_type');
    // A malformed type is not a type at all, even for an existing record.
    expect(errorOf(checkEntityType('Villain', 'existing'))).toBe('invalid_type');
    expect(errorOf(checkEntityType(7, 'create'))).toBe('invalid_type');
  });

  test('every enabled MVP type is accepted by the same rules', () => {
    for (const definition of CONTENT_CONFIGURATION.types) {
      expect(checkEntityType(definition.id, 'create').ok).toBe(true);
      expect(prepareQuickCreate({ type: definition.id, name: 'Ferryman' }).ok).toBe(true);
    }
  });
});

describe('Quick create (BR-003, D-09)', () => {
  test('A GM captures an NPC with a name and one line', () => {
    expect(
      prepareQuickCreate({
        type: 'npc',
        name: 'Ferryman',
        summary: 'Asks for silver, takes copper',
      }),
    ).toEqual({
      ok: true,
      value: { type: 'npc', name: 'Ferryman', summary: 'Asks for silver, takes copper' },
    });
  });

  test('Quick create without an entry-point type uses the default type', () => {
    expect(prepareQuickCreate({ name: 'Rumour' })).toEqual({
      ok: true,
      value: { type: CONTENT_CONFIGURATION.defaultQuickCreateType, name: 'Rumour', summary: '' },
    });
  });

  test('A name is required', () => {
    for (const name of ['', '   ', '\t\n']) {
      expect(errorOf(prepareQuickCreate({ name }))).toBe('name_required');
    }
  });
});

describe('Limits (D-11)', () => {
  test('name 1..200 after trim', () => {
    expect(normalizeName(`  ${'n'.repeat(200)}  `)).toEqual({ ok: true, value: 'n'.repeat(200) });
    expect(errorOf(normalizeName('n'.repeat(201)))).toBe('name_too_long');
    expect(errorOf(normalizeName(' '))).toBe('name_required');
    expect(errorOf(normalizeName(undefined))).toBe('invalid_text');
    // Code points, not UTF-16 units: 200 astral characters fit.
    expect(normalizeName('🐉'.repeat(200)).ok).toBe(true);
    expect(errorOf(normalizeName('🐉'.repeat(201)))).toBe('name_too_long');
  });

  test('summary 0..280, description and body 0..50,000', () => {
    expect(checkSummary('').ok).toBe(true);
    expect(checkSummary('s'.repeat(280)).ok).toBe(true);
    expect(errorOf(checkSummary('s'.repeat(281)))).toBe('summary_too_long');
    expect(checkLongText('').ok).toBe(true);
    expect(checkLongText('d'.repeat(CONTENT_LIMITS.longTextMax)).ok).toBe(true);
    expect(errorOf(checkLongText('d'.repeat(50_001)))).toBe('long_text_too_long');
    expect(errorOf(checkSummary(null))).toBe('invalid_text');
  });
});

describe('Tags (D-18, BR-009)', () => {
  test('Tags are normalized', () => {
    expect(normalizeTags([' Antagonist ', 'antagonist', 'Village'])).toEqual({
      ok: true,
      value: ['antagonist', 'village'],
    });
    expect(normalizeTag('  Old \t  Road ')).toBe('old road');
    // NFC: a decomposed accent equals the precomposed one.
    expect(normalizeTags(['Café', 'café'])).toEqual({ ok: true, value: ['café'] });
    // Idempotent.
    expect(normalizeTag(normalizeTag(' Ärger  Im Dorf '))).toBe(normalizeTag(' Ärger  Im Dorf '));
  });

  test('a 64-character tag is accepted, 65 rejected; a 33rd tag is rejected', () => {
    expect(normalizeTags(['t'.repeat(64)]).ok).toBe(true);
    expect(errorOf(normalizeTags(['t'.repeat(65)]))).toBe('tag_too_long');
    const many = Array.from({ length: 32 }, (_, index) => `tag-${index}`);
    expect(normalizeTags(many).ok).toBe(true);
    expect(errorOf(normalizeTags([...many, 'tag-32']))).toBe('too_many_tags');
    // Duplicates collapse before counting.
    expect(normalizeTags([...many, 'TAG-0']).ok).toBe(true);
    expect(errorOf(normalizeTags(['  ']))).toBe('tag_empty');
    expect(errorOf(normalizeTags('village'))).toBe('invalid_tags');
    expect(errorOf(normalizeTags([1]))).toBe('invalid_tags');
  });
});

describe('Custom Fields (D-01)', () => {
  test('A GM adds a free-form custom field', () => {
    expect(normalizeCustomFields({ ' Price ': 'one silver' })).toEqual({
      ok: true,
      value: { Price: 'one silver' },
    });
    expect(normalizeCustomFields({}).ok).toBe(true);
  });

  test('"Price" and "price" on one entity are rejected', () => {
    expect(errorOf(normalizeCustomFields({ Price: 'one silver', price: 'two' }))).toBe(
      'duplicate_field_label',
    );
    expect(errorOf(normalizeCustomFields({ Price: 'a', ' price': 'b' }))).toBe(
      'duplicate_field_label',
    );
  });

  test('33 entries, a non-string value, a 65-character label are rejected', () => {
    const entries = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`Field ${index}`, 'v']));
    expect(normalizeCustomFields(entries(32)).ok).toBe(true);
    expect(errorOf(normalizeCustomFields(entries(33)))).toBe('too_many_fields');
    expect(errorOf(normalizeCustomFields({ Price: 1 }))).toBe('invalid_field_value');
    expect(errorOf(normalizeCustomFields({ Price: null }))).toBe('invalid_field_value');
    expect(normalizeCustomFields({ ['l'.repeat(64)]: 'v' }).ok).toBe(true);
    expect(errorOf(normalizeCustomFields({ ['l'.repeat(65)]: 'v' }))).toBe('field_label_too_long');
    expect(errorOf(normalizeCustomFields({ '  ': 'v' }))).toBe('field_label_empty');
    expect(normalizeCustomFields({ Note: 'v'.repeat(1_000) }).ok).toBe(true);
    expect(errorOf(normalizeCustomFields({ Note: 'v'.repeat(1_001) }))).toBe(
      'field_value_too_long',
    );
    for (const value of [[], 'x', null, new Date()]) {
      expect(errorOf(normalizeCustomFields(value))).toBe('invalid_fields');
    }
  });

  test('a free-form label that names an object property is kept as a field', () => {
    const parsed = JSON.parse('{"__proto__":"cursed","constructor":"wood"}') as unknown;
    const result = normalizeCustomFields(parsed);
    if (!result.ok) throw new Error(result.error);
    expect(Object.keys(result.value)).toEqual(['__proto__', 'constructor']);
    expect(JSON.stringify(result.value)).toBe('{"__proto__":"cursed","constructor":"wood"}');
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
  });
});

describe('Relationship kinds come from configuration (D-08)', () => {
  test('configured kinds are accepted; an unknown kind is rejected', () => {
    for (const kind of RELATIONSHIP_KINDS) expect(checkRelationshipKind(kind.id).ok).toBe(true);
    expect(errorOf(checkRelationshipKind('hates'))).toBe('unknown_kind');
    expect(errorOf(checkRelationshipKind(undefined))).toBe('unknown_kind');
  });
});

describe('Visibility intersection and relationship bound (D-07)', () => {
  const p1 = '00000000-0000-4000-8000-0000000000a1';
  const p2 = '00000000-0000-4000-8000-0000000000a2';
  const p3 = '00000000-0000-4000-8000-0000000000a3';
  const samples: Visibility[] = [
    { mode: 'gm_only' },
    { mode: 'everyone' },
    { mode: 'players', playerIds: [p1] },
    { mode: 'players', playerIds: [p2] },
    { mode: 'players', playerIds: [p1, p2] },
  ];
  // Audience model (feature 04 decision sense): who may read under the Visibility.
  const universe = ['gm', p1, p2, p3];
  const audience = (visibility: Visibility): Set<string> => {
    switch (visibility.mode) {
      case 'gm_only':
      case 'party':
        return new Set(['gm']);
      case 'everyone':
        return new Set(universe);
      case 'players':
        return new Set(['gm', ...visibility.playerIds]);
    }
  };
  const subset = (a: Set<string>, b: Set<string>) => [...a].every((item) => b.has(item));
  const sameSet = (a: Set<string>, b: Set<string>) => subset(a, b) && subset(b, a);

  test('intersection equals the audience intersection, exhaustively', () => {
    for (const a of samples) {
      for (const b of samples) {
        const result = intersectVisibility(a, b);
        const expected = new Set([...audience(a)].filter((item) => audience(b).has(item)));
        expect({ a, b, same: sameSet(audience(result), expected) }).toEqual({ a, b, same: true });
        expect(intersectVisibility(b, a)).toEqual(result);
      }
    }
    expect(
      intersectVisibility(
        { mode: 'players', playerIds: [p1] },
        { mode: 'players', playerIds: [p2] },
      ),
    ).toEqual({ mode: 'gm_only' });
    expect(
      intersectVisibility(
        { mode: 'players', playerIds: [p2, p1] },
        { mode: 'players', playerIds: [p1, p2, p3] },
      ),
    ).toEqual({ mode: 'players', playerIds: [p1, p2] });
  });

  test('within and the relationship bound agree with the audience model, exhaustively', () => {
    let cases = 0;
    for (const rel of samples) {
      for (const source of samples) {
        expect(visibilityWithin(rel, source)).toBe(subset(audience(rel), audience(source)));
        for (const target of samples) {
          const expected =
            subset(audience(rel), audience(source)) && subset(audience(rel), audience(target));
          expect({ rel, source, target, ok: isWithin(rel, source, target) }).toEqual({
            rel,
            source,
            target,
            ok: expected,
          });
          cases += 1;
        }
      }
    }
    expect(cases).toBe(samples.length ** 3);
  });

  test('party fails closed: never within anything wider than gm_only, intersects to gm_only', () => {
    const party: Visibility = { mode: 'party', partyIds: [p3] };
    for (const other of samples) {
      expect(intersectVisibility(party, other)).toEqual({ mode: 'gm_only' });
      expect(visibilityWithin(party, other)).toBe(false);
      expect(visibilityWithin(other, party)).toBe(other.mode === 'gm_only');
    }
  });
});

describe('record schemas', () => {
  const envelope = {
    id: '00000000-0000-4000-8000-000000000001',
    campaignId: '00000000-0000-4000-8000-000000000002',
    name: 'Ferryman',
    tags: ['ferry'],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: '2026-10-28T10:00:00.000Z',
    createdBy: '00000000-0000-4000-8000-000000000003',
    updatedAt: '2026-10-28T10:00:00.000Z',
    updatedBy: '00000000-0000-4000-8000-000000000003',
  };

  test('entity, personal-note, and relationship records are entity envelopes', () => {
    expect(
      check(EntityReplicaSchema, {
        ...envelope,
        type: 'npc',
        summary: '',
        description: '',
        fields: { Price: 'one silver' },
      }),
    ).toBe(true);
    expect(
      check(EntityReplicaSchema, {
        ...envelope,
        type: 'Villain',
        summary: '',
        description: '',
        fields: {},
      }),
    ).toBe(false);
    expect(
      check(EntityReplicaSchema, {
        ...envelope,
        type: 'npc',
        summary: '',
        description: '',
        fields: { Price: 1 },
      }),
    ).toBe(false);
    expect(
      check(PersonalNoteReplicaSchema, {
        ...envelope,
        type: 'note',
        authorUserId: envelope.createdBy,
        body: '',
        visibility: { mode: 'players', playerIds: [envelope.createdBy] },
      }),
    ).toBe(true);
    expect(
      check(RelationshipReplicaSchema, {
        ...envelope,
        type: 'relationship',
        tags: [],
        sourceEntityId: envelope.id,
        targetEntityId: envelope.campaignId,
        kind: 'lives_at',
      }),
    ).toBe(true);
    // Visibility is required (frozen envelope).
    const { visibility: _omitted, ...withoutVisibility } = envelope;
    expect(
      check(EntityReplicaSchema, {
        ...withoutVisibility,
        type: 'npc',
        summary: '',
        description: '',
        fields: {},
      }),
    ).toBe(false);
  });

  test('quick-create input carries no visibility, location, or other choice', () => {
    expect(check(QuickCreateInput, { type: 'npc', name: 'Ferryman' })).toBe(true);
    expect(check(QuickCreateInput, { type: 'npc', name: 'Ferryman', summary: 'One line' })).toBe(
      true,
    );
    expect(
      check(QuickCreateInput, { type: 'npc', name: 'Ferryman', visibility: { mode: 'everyone' } }),
    ).toBe(false);
  });
});
