import { describe, expect, test } from 'bun:test';
import type { Visibility } from '@rpg/contracts';
import { VISIBILITY_NARROWED_ON_IMPORT, visibilityForImport } from './import-visibility.ts';

/**
 * Feature 07 `_bdd.md` "Visibility does not widen" through feature 04's import rule: targeted
 * audiences survive only with a mapping for every target; otherwise `gm_only` with a warning.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = id(99);

describe('visibilityForImport', () => {
  const none = () => undefined;

  test('gm_only and everyone restore as stored, with no warning', () => {
    expect(visibilityForImport({ mode: 'gm_only' }, none, source)).toEqual({
      visibility: { mode: 'gm_only' },
    });
    expect(visibilityForImport({ mode: 'everyone' }, none, source)).toEqual({
      visibility: { mode: 'everyone' },
    });
  });

  test('Scenario: Visibility does not widen — unmapped players narrow to gm_only', () => {
    const result = visibilityForImport({ mode: 'players', playerIds: [id(1)] }, none, source);
    expect(result).toEqual({
      visibility: { mode: 'gm_only' },
      warning: { code: VISIBILITY_NARROWED_ON_IMPORT, sourceId: source },
    });
  });

  test('one unmapped target narrows the whole record; never to everyone', () => {
    const map = (kind: string, sourceId: string) =>
      kind === 'member' && sourceId === id(1) ? id(11) : undefined;
    const result = visibilityForImport({ mode: 'players', playerIds: [id(1), id(2)] }, map, source);
    expect(result.visibility).toEqual({ mode: 'gm_only' });
    expect(result.warning?.code).toBe(VISIBILITY_NARROWED_ON_IMPORT);
  });

  test('an approved mapping keeps the targeted audience, remapped and deduplicated', () => {
    const map = (kind: string, sourceId: string) =>
      kind === 'member' ? id(50) : kind === 'party' && sourceId === id(3) ? id(33) : undefined;
    expect(
      visibilityForImport({ mode: 'players', playerIds: [id(1), id(2)] }, map, source),
    ).toEqual({ visibility: { mode: 'players', playerIds: [id(50)] } });
    expect(visibilityForImport({ mode: 'party', partyIds: [id(3)] }, map, source)).toEqual({
      visibility: { mode: 'party', partyIds: [id(33)] },
    });
    // A member mapping is never used for a party target.
    expect(
      visibilityForImport({ mode: 'party', partyIds: [id(4)] }, map, source).visibility,
    ).toEqual({
      mode: 'gm_only',
    });
  });

  test('an unknown mode is never treated as an audience', () => {
    const hostile = { mode: 'admins', ids: [id(1)] } as unknown as Visibility;
    expect(visibilityForImport(hostile, () => id(1)).visibility).toEqual({ mode: 'gm_only' });
  });
});
