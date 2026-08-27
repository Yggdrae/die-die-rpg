import { describe, expect, test } from 'bun:test';
import { ActorRef, check, EntityEnvelope, Id, issues, SystemRef } from '@rpg/contracts';

import { ACTORS, FIXTURE_CAMPAIGN, FIXTURE_ENTITIES, FIXTURE_SYSTEM } from './campaign.ts';
import { FIXTURE_CHARACTER_SCHEMA } from './character-schema.ts';
import { CAMPAIGN_ID } from './ids.ts';

/**
 * A fixture that does not validate is worse than no fixture: features build against it and
 * inherit the error. Hence a CI gate rather than a convention (task 06).
 */

describe('fixture identifiers', () => {
  test('campaign id is a valid Id', () => {
    expect(check(Id, CAMPAIGN_ID)).toBe(true);
  });

  test('every entity id is a valid Id', () => {
    for (const entity of FIXTURE_ENTITIES) {
      expect(check(Id, entity.id)).toBe(true);
    }
  });

  test('entity ids are unique', () => {
    const ids = FIXTURE_ENTITIES.map((entity) => entity.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('fixture entities', () => {
  test('every entity validates against EntityEnvelope', () => {
    for (const entity of FIXTURE_ENTITIES) {
      const errors = issues(EntityEnvelope, entity);
      expect(errors.map((e) => `${entity.name}: ${e.path} ${e.message}`)).toEqual([]);
    }
  });

  test('all entities belong to the fixture campaign', () => {
    for (const entity of FIXTURE_ENTITIES) {
      expect(entity.campaignId).toBe(CAMPAIGN_ID);
    }
  });

  test('matches the content listed in PRD.md s.82', () => {
    const byType = (type: string) => FIXTURE_ENTITIES.filter((e) => e.type === type).length;
    expect(byType('location')).toBe(5);
    expect(byType('npc')).toBe(6);
    expect(byType('item')).toBe(5);
  });
});

describe('fixture visibility coverage', () => {
  const modes = new Set(FIXTURE_ENTITIES.map((entity) => entity.visibility.mode));

  // A fixture where everything is public lets a feature pass its tests without ever
  // exercising the filtering that keeps secrets secret.
  test('includes gm_only content', () => {
    expect(modes.has('gm_only')).toBe(true);
  });

  test('includes everyone content', () => {
    expect(modes.has('everyone')).toBe(true);
  });

  test('includes content revealed to specific players', () => {
    expect(modes.has('players')).toBe(true);
  });
});

describe('fixture actors', () => {
  test('every actor validates against ActorRef', () => {
    for (const actor of Object.values(ACTORS)) {
      expect(check(ActorRef, actor)).toBe(true);
    }
  });

  test('covers all five roles from PRD.md s.60', () => {
    const roles = new Set(Object.values(ACTORS).map((actor) => actor.role));
    expect(roles).toEqual(new Set(['owner', 'gm', 'assistant_gm', 'player', 'observer']));
  });
});

describe('fixture system', () => {
  test('validates against SystemRef', () => {
    expect(check(SystemRef, FIXTURE_SYSTEM)).toBe(true);
  });

  test('campaign pins the fixture system', () => {
    expect(FIXTURE_CAMPAIGN.system).toEqual(FIXTURE_SYSTEM);
  });

  // The whole point of the fixture schema (task 06, and `PRD.md` s.89).
  test('is neither Cairn nor Fate', () => {
    expect(FIXTURE_SYSTEM.systemId).not.toContain('cairn');
    expect(FIXTURE_SYSTEM.systemId).not.toContain('fate');
  });
});

describe('fixture character schema', () => {
  const keys = FIXTURE_CHARACTER_SCHEMA.fields.map((field) => field.key);

  test('field keys are unique', () => {
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('borrows no field name from an MVP system', () => {
    const mvpNames = ['STR', 'DEX', 'WIL', 'HP', 'aspects', 'skills', 'stress', 'fatePoints'];
    for (const name of mvpNames) {
      expect(keys).not.toContain(name);
    }
  });

  test('covers enough component types for feature 15 to build a real sheet', () => {
    const types = new Set(FIXTURE_CHARACTER_SCHEMA.fields.map((field) => field.type));
    for (const required of [
      'text',
      'number',
      'boolean',
      'resource',
      'select',
      'repeater',
      'computed',
    ]) {
      expect(types.has(required as never)).toBe(true);
    }
  });

  test('includes a gm-only field so sheet filtering is exercised', () => {
    expect(FIXTURE_CHARACTER_SCHEMA.fields.some((field) => field.gmOnly === true)).toBe(true);
  });

  test('every computed field declares a formula', () => {
    for (const field of FIXTURE_CHARACTER_SCHEMA.fields) {
      if (field.type === 'computed') {
        expect(field.formula).toBeDefined();
      }
    }
  });
});
