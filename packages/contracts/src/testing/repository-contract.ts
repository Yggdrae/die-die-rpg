import { describe, expect, test } from 'bun:test';
import type { EntityEnvelope } from '../entity.ts';
import type { SyncedRepository } from '../repository.ts';
import { isVersionConflict } from '../repository.ts';
import { isErr, isOk, unwrap } from '../result.ts';

const CAMPAIGN = '3f2504e0-4f89-41d3-9a0c-0305e82c3300';
const ID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ID_B = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const NOW = '2026-08-27T14:32:00Z';

export function makeEntity(id: string, name: string): EntityEnvelope {
  return {
    id,
    campaignId: CAMPAIGN,
    type: 'npc',
    name,
    tags: [],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: NOW,
    createdBy: CAMPAIGN,
    updatedAt: NOW,
    updatedBy: CAMPAIGN,
  };
}

/**
 * The behavioral contract every `SyncedRepository` must satisfy.
 *
 * Feature 03 runs this suite against its real local-first implementation. If the in-memory
 * double is more permissive than the real one, waves 1 and 2 are built against behavior
 * that does not exist, and the divergence surfaces in wave 3 when it is expensive.
 *
 * The conflict cases are the point. `PRD.md` s.80 targets zero silent overwrites, and a
 * repository that resolves a stale write by accepting it cannot meet that.
 */
export function repositoryContractTests(
  label: string,
  createRepository: () => SyncedRepository<EntityEnvelope>,
): void {
  describe(`SyncedRepository contract: ${label}`, () => {
    test('create starts at version 1', async () => {
      const repo = createRepository();
      const created = unwrap(await repo.upsert(makeEntity(ID_A, 'Merchant'), null));
      expect(created.version).toBe(1);
    });

    test('get returns a created record', async () => {
      const repo = createRepository();
      await repo.upsert(makeEntity(ID_A, 'Merchant'), null);
      const found = unwrap(await repo.get(ID_A));
      expect(found.name).toBe('Merchant');
    });

    test('get on a missing record is not_found, not a throw', async () => {
      const repo = createRepository();
      const result = await repo.get(ID_B);
      expect(isErr(result)).toBe(true);
    });

    test('update with the matching version increments by one', async () => {
      const repo = createRepository();
      const created = unwrap(await repo.upsert(makeEntity(ID_A, 'Merchant'), null));
      const updated = unwrap(await repo.upsert({ ...created, name: 'Elder' }, created.version));
      expect(updated.version).toBe(2);
      expect(updated.name).toBe('Elder');
    });

    test('update with a stale version conflicts and does not mutate', async () => {
      const repo = createRepository();
      const created = unwrap(await repo.upsert(makeEntity(ID_A, 'Merchant'), null));
      await repo.upsert({ ...created, name: 'Elder' }, created.version);

      const stale = await repo.upsert({ ...created, name: 'Guard' }, created.version);

      expect(isErr(stale)).toBe(true);
      if (isErr(stale) && isVersionConflict(stale.error)) {
        expect(stale.error.expectedVersion).toBe(1);
        expect(stale.error.actualVersion).toBe(2);
      } else {
        throw new Error('expected a version conflict carrying both versions');
      }

      const current = unwrap(await repo.get(ID_A));
      expect(current.name).toBe('Elder');
    });

    test('concurrent writes against the same version: exactly one wins', async () => {
      const repo = createRepository();
      const created = unwrap(await repo.upsert(makeEntity(ID_A, 'Merchant'), null));

      const [first, second] = await Promise.all([
        repo.upsert({ ...created, name: 'Elder' }, created.version),
        repo.upsert({ ...created, name: 'Guard' }, created.version),
      ]);

      expect([first, second].filter(isOk)).toHaveLength(1);
      expect([first, second].filter(isErr)).toHaveLength(1);
    });

    test('softDelete tombstones and hides from the default list', async () => {
      const repo = createRepository();
      const created = unwrap(await repo.upsert(makeEntity(ID_A, 'Merchant'), null));

      expect(isOk(await repo.softDelete(ID_A, created.version))).toBe(true);

      const listed = unwrap(await repo.list(CAMPAIGN));
      expect(listed).toHaveLength(0);

      const withDeleted = unwrap(await repo.list(CAMPAIGN, { includeDeleted: true }));
      expect(withDeleted).toHaveLength(1);
      expect(withDeleted[0]?.deletedAt).toBeDefined();
    });

    test('softDelete with a stale version conflicts', async () => {
      const repo = createRepository();
      const created = unwrap(await repo.upsert(makeEntity(ID_A, 'Merchant'), null));
      await repo.upsert({ ...created, name: 'Elder' }, created.version);

      const result = await repo.softDelete(ID_A, created.version);
      expect(isErr(result)).toBe(true);
    });

    test('list is scoped to one campaign', async () => {
      const repo = createRepository();
      await repo.upsert(makeEntity(ID_A, 'Merchant'), null);
      await repo.upsert({ ...makeEntity(ID_B, 'Stranger'), campaignId: ID_B }, null);

      const listed = unwrap(await repo.list(CAMPAIGN));
      expect(listed).toHaveLength(1);
      expect(listed[0]?.name).toBe('Merchant');
    });

    test('a returned record is a copy, so a caller cannot mutate stored state', async () => {
      const repo = createRepository();
      await repo.upsert(makeEntity(ID_A, 'Merchant'), null);

      const first = unwrap(await repo.get(ID_A));
      first.name = 'Tampered';

      const second = unwrap(await repo.get(ID_A));
      expect(second.name).toBe('Merchant');
    });
  });
}
