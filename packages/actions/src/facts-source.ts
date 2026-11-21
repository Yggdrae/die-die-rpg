import type { ResourceFacts } from '@rpg/authorization';
import type { PostgresEffectRepository } from './infra/postgres/repository.ts';
import { EFFECT_APPLICATION_CLASS, effectFacts } from './policies.ts';

/** Feature 06 reads an application's audit history through feature 04, on these facts. */
export function effectFactsSource(applications: Pick<PostgresEffectRepository, 'get'>): {
  readonly resourceClass: string;
  loadFacts(campaignId: string, resourceId: string): Promise<ResourceFacts | undefined>;
} {
  return {
    resourceClass: EFFECT_APPLICATION_CLASS,
    loadFacts: async (campaignId, resourceId) => {
      const record = await applications.get(campaignId, resourceId);
      return record === undefined
        ? undefined
        : effectFacts({ campaignId, id: record.id, visibility: record.visibility });
    },
  };
}
