import { err } from '@rpg/contracts';
import type { ExportConsistency, SnapshotCursor } from './orchestrator.ts';
import type { ChunkPlacement } from './paths.ts';
import type { ExportRegistry } from './registry.ts';

/**
 * Complete-replica offline export (`_db.md`, Export Consistency; `_techspec.md`, offline export).
 * Offline, the orchestrator reads the device replica instead of PostgreSQL. It may produce a
 * package only when every registered contributor reports its local data complete at one replica
 * cursor; otherwise the export fails as `incomplete_replica`, naming the modules, and never
 * becomes a silent partial backup.
 */

/** What the device can prove about its replica for one campaign. */
export interface ReplicaCoverage {
  coverage(campaignId: string): Promise<{
    /** Replica checkpoint the local reads observe; `undefined` before the first full sync. */
    readonly cursor: string | undefined;
    /** Per module id: `true` when complete at `cursor`, else a stable reason code. */
    readonly modules: Readonly<Record<string, true | string>>;
  }>;
}

/** Cursor consistency over a replica: every registered module must be covered and complete. */
export function replicaConsistency(
  registry: ExportRegistry,
  replica: ReplicaCoverage,
): ExportConsistency {
  return {
    kind: 'cursor',
    read: async (campaignId): Promise<SnapshotCursor> => {
      const { cursor, modules } = await replica.coverage(campaignId);
      const incompleteModules = registry
        .list()
        .map((registration) => registration.module.moduleId)
        .filter((moduleId) => cursor === undefined || modules[moduleId] !== true);
      return incompleteModules.length === 0 && cursor !== undefined
        ? { complete: true, cursor }
        : { complete: false, incompleteModules };
    },
  };
}

/**
 * Registration for a P0 contributor whose data the device replica does not hold. It keeps the
 * registry complete (so the refusal names the module) and can never be read: its coverage must
 * report the reason, and reading it anyway fails the export.
 */
export function unreplicatedContributor(moduleId: string, placement: ChunkPlacement) {
  return {
    module: {
      moduleId,
      export: async (): Promise<never> => {
        throw new Error('not_replicated');
      },
      import: async () => err('not_replicated'),
    },
    placement,
  } as const;
}
