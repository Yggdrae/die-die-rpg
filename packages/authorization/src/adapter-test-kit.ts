import type { AuditSqlExecutor } from '@rpg/audit';
import { GM_ONLY, type Visibility } from '@rpg/contracts';
import type {
  ResourceFacts,
  VisibilityAdapter,
  VisibilityWrite,
  VisibilityWriteResult,
} from './registry.ts';
import { normalizeTargetIds, sameVisibility } from './visibility.ts';

/**
 * Shared Visibility adapter contract (`_db.md`, Visibility Mutation Transaction; Required Data
 * Tests). Every owner runs it against its real persistence and asserts no findings. The kit only
 * observes `recordAudit` calls; the executor the adapter passes stays opaque.
 */

export interface VisibilityAdapterContractSubject {
  readonly adapter: VisibilityAdapter;
  /** Creates one live record in `campaignId` carrying `visibility`; returns its resource ID. */
  seed(input: { readonly campaignId: string; readonly visibility: Visibility }): Promise<string>;
  /** Tombstones a seeded record. Owners with tombstones must supply it. */
  tombstone?(campaignId: string, resourceId: string): Promise<void>;
  /**
   * B-1 (optional): seeds a live record in `campaignId` and names a Visibility the owner's own
   * invariant must refuse (for example a relationship wider than its endpoints). Owners with such
   * an invariant supply it; the write must return `invariant_violation` and change nothing.
   */
  invariantViolation?(
    campaignId: string,
  ): Promise<{ readonly resourceId: string; readonly visibility: Visibility }>;
}

export type AdapterContractCheck =
  | 'load_facts'
  | 'load_other_campaign'
  | 'load_missing'
  | 'write_applies'
  | 'write_stale_version'
  | 'write_missing'
  | 'write_other_campaign'
  | 'audit_in_transaction'
  | 'concurrent_single_winner'
  | 'tombstone_excluded'
  | 'invariant_refused';

export interface AdapterContractFinding {
  readonly check: AdapterContractCheck;
  readonly detail: string;
}

export interface AdapterContractReport {
  readonly resourceClass: string;
  readonly checks: readonly AdapterContractCheck[];
  readonly findings: readonly AdapterContractFinding[];
}

class AuditProbeFailure extends Error {}

interface AuditProbe {
  readonly calls: number;
  recordAudit(executor: AuditSqlExecutor): Promise<void>;
}

function auditProbe(options: { readonly fail?: boolean } = {}): AuditProbe {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    recordAudit: async () => {
      calls += 1;
      if (options.fail === true) throw new AuditProbeFailure('audit probe failure');
    },
  };
}

function players(count: number): Visibility {
  return {
    mode: 'players',
    playerIds: normalizeTargetIds(Array.from({ length: count }, () => crypto.randomUUID())),
  };
}

export async function runVisibilityAdapterContract(
  subject: VisibilityAdapterContractSubject,
): Promise<AdapterContractReport> {
  const { adapter } = subject;
  const findings: AdapterContractFinding[] = [];
  const checks: AdapterContractCheck[] = [];
  const campaignId = crypto.randomUUID();
  const otherCampaignId = crypto.randomUUID();

  const run = async (check: AdapterContractCheck, work: (fail: Fail) => Promise<void>) => {
    checks.push(check);
    const fail: Fail = (detail) => {
      findings.push({ check, detail });
    };
    try {
      await work(fail);
    } catch (error) {
      fail(`threw ${error instanceof Error ? error.name : 'non-error'}`);
    }
  };
  const write = (
    input: Omit<VisibilityWrite, 'recordAudit'>,
    probe: AuditProbe,
  ): Promise<VisibilityWriteResult> =>
    adapter.writeVisibility({ ...input, recordAudit: (executor) => probe.recordAudit(executor) });
  const seedLoaded = async (visibility: Visibility = GM_ONLY) => {
    const resourceId = await subject.seed({ campaignId, visibility });
    const facts = await adapter.loadFacts(campaignId, resourceId);
    if (facts === undefined) throw new Error('seeded record did not load');
    return facts;
  };
  const unchanged = async (fail: Fail, facts: ResourceFacts) => {
    const reloaded = await adapter.loadFacts(campaignId, facts.resourceId);
    if (
      reloaded === undefined ||
      reloaded.version !== facts.version ||
      !sameVisibility(reloaded.visibility, facts.visibility)
    ) {
      fail('record changed');
    }
  };

  await run('load_facts', async (fail) => {
    const visibility = players(2);
    const resourceId = await subject.seed({ campaignId, visibility });
    const facts = await adapter.loadFacts(campaignId, resourceId);
    if (facts === undefined) return fail('seeded record not found');
    if (facts.resourceClass !== adapter.resourceClass) fail('wrong resource class');
    if (facts.campaignId !== campaignId || facts.resourceId !== resourceId) fail('wrong identity');
    if (!sameVisibility(facts.visibility, visibility)) fail('visibility not round-tripped');
    if (!Number.isInteger(facts.version) || facts.version < 1) fail('version not a positive int');
  });

  await run('load_other_campaign', async (fail) => {
    const facts = await seedLoaded();
    if ((await adapter.loadFacts(otherCampaignId, facts.resourceId)) !== undefined) {
      fail('record loaded through another campaign');
    }
  });

  await run('load_missing', async (fail) => {
    if ((await adapter.loadFacts(campaignId, crypto.randomUUID())) !== undefined) {
      fail('missing record loaded');
    }
  });

  await run('write_applies', async (fail) => {
    const facts = await seedLoaded();
    const visibility = players(2);
    const probe = auditProbe();
    const result = await write(
      { campaignId, resourceId: facts.resourceId, expectedVersion: facts.version, visibility },
      probe,
    );
    if (!result.ok) return fail(`rejected with ${result.reason}`);
    if (result.facts.version !== facts.version + 1) fail('version not incremented by 1');
    if (!sameVisibility(result.facts.visibility, visibility)) fail('returned visibility differs');
    if (probe.calls !== 1) fail(`recordAudit called ${probe.calls} times`);
    const reloaded = await adapter.loadFacts(campaignId, facts.resourceId);
    if (
      reloaded === undefined ||
      reloaded.version !== facts.version + 1 ||
      !sameVisibility(reloaded.visibility, visibility)
    ) {
      fail('write not persisted');
    }
  });

  await run('write_stale_version', async (fail) => {
    const facts = await seedLoaded();
    const first = await write(
      {
        campaignId,
        resourceId: facts.resourceId,
        expectedVersion: facts.version,
        visibility: players(1),
      },
      auditProbe(),
    );
    if (!first.ok) return fail('setup write rejected');
    const probe = auditProbe();
    const stale = await write(
      {
        campaignId,
        resourceId: facts.resourceId,
        expectedVersion: facts.version,
        visibility: players(1),
      },
      probe,
    );
    if (stale.ok || stale.reason !== 'version_conflict') fail('stale version not a conflict');
    if (probe.calls !== 0) fail('recordAudit called for a conflict');
    await unchanged(fail, first.facts);
  });

  await run('write_missing', async (fail) => {
    const probe = auditProbe();
    const result = await write(
      { campaignId, resourceId: crypto.randomUUID(), expectedVersion: 1, visibility: players(1) },
      probe,
    );
    if (result.ok || result.reason !== 'not_found') fail('missing record not not_found');
    if (probe.calls !== 0) fail('recordAudit called for a missing record');
  });

  await run('write_other_campaign', async (fail) => {
    const facts = await seedLoaded();
    const probe = auditProbe();
    const result = await write(
      {
        campaignId: otherCampaignId,
        resourceId: facts.resourceId,
        expectedVersion: facts.version,
        visibility: players(1),
      },
      probe,
    );
    if (result.ok || result.reason !== 'not_found') fail('cross-campaign write not not_found');
    if (probe.calls !== 0) fail('recordAudit called for a cross-campaign write');
    await unchanged(fail, facts);
  });

  await run('audit_in_transaction', async (fail) => {
    const facts = await seedLoaded();
    const probe = auditProbe({ fail: true });
    let threw = false;
    try {
      await write(
        {
          campaignId,
          resourceId: facts.resourceId,
          expectedVersion: facts.version,
          visibility: players(1),
        },
        probe,
      );
    } catch (error) {
      threw = error instanceof AuditProbeFailure;
    }
    if (probe.calls !== 1) fail(`recordAudit called ${probe.calls} times`);
    if (!threw) fail('audit failure did not propagate');
    // The update and the audit enqueue share one transaction: neither survives.
    await unchanged(fail, facts);
  });

  await run('concurrent_single_winner', async (fail) => {
    const facts = await seedLoaded();
    const candidates = [players(1), players(1)];
    const probes = [auditProbe(), auditProbe()];
    const results = await Promise.all(
      candidates.map((visibility, index) =>
        write(
          { campaignId, resourceId: facts.resourceId, expectedVersion: facts.version, visibility },
          probes[index] ?? auditProbe(),
        ),
      ),
    );
    const winners = results.flatMap((result, index) => (result.ok ? [index] : []));
    const conflicts = results.filter(
      (result) => !result.ok && result.reason === 'version_conflict',
    );
    if (winners.length !== 1 || conflicts.length !== 1) {
      return fail(`${winners.length} winners, ${conflicts.length} conflicts`);
    }
    if (probes.reduce((sum, probe) => sum + probe.calls, 0) !== 1) fail('audit not exactly once');
    const winner = candidates[winners[0] ?? 0] ?? GM_ONLY;
    const reloaded = await adapter.loadFacts(campaignId, facts.resourceId);
    if (
      reloaded === undefined ||
      reloaded.version !== facts.version + 1 ||
      !sameVisibility(reloaded.visibility, winner)
    ) {
      fail('stored state is not the single winner');
    }
  });

  if (subject.tombstone !== undefined) {
    const tombstone = subject.tombstone;
    await run('tombstone_excluded', async (fail) => {
      const facts = await seedLoaded();
      await tombstone(campaignId, facts.resourceId);
      if ((await adapter.loadFacts(campaignId, facts.resourceId)) !== undefined) {
        fail('tombstone loaded');
      }
      const probe = auditProbe();
      const result = await write(
        {
          campaignId,
          resourceId: facts.resourceId,
          expectedVersion: facts.version,
          visibility: players(1),
        },
        probe,
      );
      if (result.ok || result.reason !== 'not_found') fail('tombstone write not not_found');
      if (probe.calls !== 0) fail('recordAudit called for a tombstone');
    });
  }

  if (subject.invariantViolation !== undefined) {
    const violation = subject.invariantViolation;
    await run('invariant_refused', async (fail) => {
      const { resourceId, visibility } = await violation(campaignId);
      const facts = await adapter.loadFacts(campaignId, resourceId);
      if (facts === undefined) return fail('seeded record did not load');
      const probe = auditProbe();
      const result = await write(
        { campaignId, resourceId, expectedVersion: facts.version, visibility },
        probe,
      );
      if (result.ok || result.reason !== 'invariant_violation') {
        fail('invariant-violating write not refused with invariant_violation');
      }
      if (probe.calls !== 0) fail('recordAudit called for a refused write');
      await unchanged(fail, facts);
    });
  }

  return { resourceClass: adapter.resourceClass, checks, findings };
}

type Fail = (detail: string) => void;
