import { expect, test } from 'bun:test';
import type { EntityEnvelope } from '../entity.ts';
import { unwrap } from '../result.ts';
import { InMemoryRepository } from './in-memory-repository.ts';
import { makeEntity, repositoryContractTests } from './repository-contract.ts';

repositoryContractTests('InMemoryRepository', () => new InMemoryRepository<EntityEnvelope>());

test('seed loads fixture data without version checks', async () => {
  const repo = new InMemoryRepository<EntityEnvelope>();
  repo.seed([
    makeEntity('3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'Merchant'),
    makeEntity('3f2504e0-4f89-41d3-9a0c-0305e82c3302', 'Guard'),
  ]);

  expect(repo.size).toBe(2);
  const found = unwrap(await repo.get('3f2504e0-4f89-41d3-9a0c-0305e82c3302'));
  expect(found.name).toBe('Guard');
});
