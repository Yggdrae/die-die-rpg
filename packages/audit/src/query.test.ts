import { describe, expect, test } from 'bun:test';
import type { StoredCampaignAuditEvent } from './infra/postgres/repositories.ts';
import {
  AUDIT_PAGE_DEFAULT_LIMIT,
  type AuditEventReader,
  AuditQueryService,
  type AuditReadAuthorizer,
  type AuditReadScope,
  type AuditTargetGroup,
} from './query.ts';
import { AuditRendererRegistry } from './renderers.ts';

const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
const ACTOR = '00000000-0000-4000-8000-0000000000b1';
const VISIBLE = '00000000-0000-4000-8000-000000001001';
const HIDDEN = '00000000-0000-4000-8000-000000001002';
const SECRET_VALUE = 'the-butler-did-it';

function stored(sequence: number, overrides: Partial<StoredCampaignAuditEvent> = {}) {
  const id = `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
  return {
    id,
    campaignId: CAMPAIGN,
    sessionId: null,
    campaignSequence: sequence,
    actorUserId: ACTOR,
    actorRole: 'gm',
    action: 'note.updated',
    targetType: 'note',
    targetId: VISIBLE,
    targetVisibility: { visibility: { mode: 'everyone' } },
    beforeValue: { title: 'Old' },
    afterValue: { title: 'New' },
    clientRecordedAt: new Date('2026-10-26T10:00:00.000Z'),
    acceptedAt: new Date(Date.UTC(2026, 9, 26, 11, 0, sequence)),
    originMutationId: id,
    rendererVersion: 1,
    ...overrides,
  } satisfies StoredCampaignAuditEvent;
}

/** In-memory store reader with the same contract as the PostgreSQL repositories. */
class MemoryReader implements AuditEventReader {
  constructor(readonly rows: StoredCampaignAuditEvent[]) {}

  #inScope(scope: AuditReadScope, row: StoredCampaignAuditEvent): boolean {
    return (
      row.campaignId === scope.campaignId &&
      (scope.sessionId === undefined || row.sessionId === scope.sessionId) &&
      (scope.actorUserId === undefined || row.actorUserId === scope.actorUserId) &&
      (scope.targetType === undefined || row.targetType === scope.targetType) &&
      (scope.targetId === undefined || row.targetId === scope.targetId)
    );
  }

  #permitted(scope: AuditReadScope, groups: readonly AuditTargetGroup[]) {
    return this.rows
      .filter((row) => this.#inScope(scope, row))
      .filter((row) =>
        groups.some(
          (group) =>
            group.targetType === row.targetType &&
            group.targetId === row.targetId &&
            group.snapshotText === JSON.stringify(row.targetVisibility),
        ),
      )
      .sort((left, right) => right.campaignSequence - left.campaignSequence);
  }

  async targetGroups(scope: AuditReadScope) {
    const groups = new Map<string, AuditTargetGroup>();
    for (const row of this.rows.filter((candidate) => this.#inScope(scope, candidate))) {
      const snapshotText = JSON.stringify(row.targetVisibility);
      groups.set(`${row.targetType}|${row.targetId}|${snapshotText}`, {
        targetType: row.targetType,
        targetId: row.targetId,
        snapshot: row.targetVisibility,
        snapshotText,
      });
    }
    return [...groups.values()];
  }

  async countWithin(scope: AuditReadScope, groups: readonly AuditTargetGroup[]) {
    return this.#permitted(scope, groups).length;
  }

  async pageWithin(
    scope: AuditReadScope,
    groups: readonly AuditTargetGroup[],
    page: { readonly limit: number; readonly cursor?: string },
  ) {
    const permitted = this.#permitted(scope, groups);
    if (page.cursor === undefined) return permitted.slice(0, page.limit);
    const anchor = permitted.find((row) => row.id === page.cursor);
    if (anchor === undefined) return undefined;
    return permitted
      .filter((row) => row.campaignSequence < anchor.campaignSequence)
      .slice(0, page.limit);
  }
}

const onlyTarget = (targetId: string): AuditReadAuthorizer => ({
  permits: async (occurrence) => occurrence.targetId === targetId,
});
const everything: AuditReadAuthorizer = { permits: async () => true };

function registryWith(render: () => { text: string }) {
  const registry = new AuditRendererRegistry();
  registry.register({ action: 'note.updated', version: 1, render });
  return registry;
}

describe('AuditQueryService (feature 06 task 03)', () => {
  // Scenario: Audit data cannot reveal a hidden target (totals do not disclose it).
  test('totals, pages, and cursors come from the permitted set only', async () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      stored(index + 1, { targetId: index % 3 === 0 ? HIDDEN : VISIBLE }),
    );
    const service = new AuditQueryService(
      new MemoryReader(rows),
      registryWith(() => ({ text: 'Note retitled.' })),
    );
    const first = await service.query(
      { scope: { campaignId: CAMPAIGN }, limit: 4 },
      onlyTarget(VISIBLE),
    );
    if (!first.ok) throw new Error('expected a page');
    expect(first.page.total).toBe(6);
    expect(first.page.items.map((item) => item.target.id)).toEqual(Array(4).fill(VISIBLE));
    expect(first.page.nextCursor).toBe(first.page.items[3]?.id);
    const second = await service.query(
      { scope: { campaignId: CAMPAIGN }, limit: 4, cursor: first.page.nextCursor },
      onlyTarget(VISIBLE),
    );
    if (!second.ok) throw new Error('expected a page');
    expect(second.page.items).toHaveLength(2);
    expect(second.page.nextCursor).toBeUndefined();
    expect(second.page.total).toBe(6);
    const ids = [...first.page.items, ...second.page.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(6);
  });

  test('a hidden event is never a valid cursor, and is indistinguishable from an unknown one', async () => {
    const rows = [stored(1, { targetId: HIDDEN }), stored(2)];
    const service = new AuditQueryService(new MemoryReader(rows), new AuditRendererRegistry());
    const hidden = await service.query(
      { scope: { campaignId: CAMPAIGN }, cursor: rows[0]?.id },
      onlyTarget(VISIBLE),
    );
    const unknown = await service.query(
      { scope: { campaignId: CAMPAIGN }, cursor: '00000000-0000-4000-8000-00000000ffff' },
      onlyTarget(VISIBLE),
    );
    expect(hidden).toEqual({ ok: false, reason: 'invalid_cursor' });
    expect(unknown).toEqual(hidden);
    const nothing = await service.query(
      { scope: { campaignId: CAMPAIGN }, cursor: rows[1]?.id },
      { permits: async () => false },
    );
    expect(nothing).toEqual(hidden);
  });

  test('a reader with no permitted target sees an empty page and a zero total', async () => {
    const service = new AuditQueryService(
      new MemoryReader([stored(1, { targetId: HIDDEN })]),
      new AuditRendererRegistry(),
    );
    expect(
      await service.query({ scope: { campaignId: CAMPAIGN } }, { permits: async () => false }),
    ).toEqual({ ok: true, page: { items: [], total: 0 } });
  });

  // Scenario Outline: Filters narrow without widening visibility.
  test('actor and target filters narrow the permitted set', async () => {
    const other = '00000000-0000-4000-8000-0000000000c1';
    const rows = [
      stored(1),
      stored(2, { actorUserId: other }),
      stored(3, { targetId: HIDDEN }),
      stored(4, { targetId: HIDDEN, actorUserId: other }),
    ];
    const service = new AuditQueryService(new MemoryReader(rows), new AuditRendererRegistry());
    const byActor = await service.query(
      { scope: { campaignId: CAMPAIGN, actorUserId: other } },
      onlyTarget(VISIBLE),
    );
    expect(byActor.ok && byActor.page.items.map((item) => item.id)).toEqual([String(rows[1]?.id)]);
    const byHiddenTarget = await service.query(
      { scope: { campaignId: CAMPAIGN, targetType: 'note', targetId: HIDDEN } },
      onlyTarget(VISIBLE),
    );
    expect(byHiddenTarget).toEqual({ ok: true, page: { items: [], total: 0 } });
  });

  test('each (target, stored snapshot) group is decided separately', async () => {
    const rows = [
      stored(1, { targetVisibility: { visibility: { mode: 'gm_only' } } }),
      stored(2, { targetVisibility: { visibility: { mode: 'everyone' } } }),
    ];
    const asked: unknown[] = [];
    const service = new AuditQueryService(new MemoryReader(rows), new AuditRendererRegistry());
    const result = await service.query(
      { scope: { campaignId: CAMPAIGN } },
      {
        permits: async (occurrence) => {
          asked.push(occurrence.snapshot);
          return (
            (occurrence.snapshot as { visibility: { mode: string } }).visibility.mode !== 'gm_only'
          );
        },
      },
    );
    expect(asked).toHaveLength(2);
    expect(result.ok && result.page.items.map((item) => item.id)).toEqual([String(rows[1]?.id)]);
    expect(result.ok && result.page.total).toBe(1);
  });

  // Scenario: A registered renderer explains an event.
  test('a registered renderer describes a permitted event', async () => {
    const service = new AuditQueryService(
      new MemoryReader([stored(1)]),
      registryWith(() => ({ text: 'Note retitled from Old to New.' })),
    );
    const result = await service.query({ scope: { campaignId: CAMPAIGN } }, everything);
    expect(result.ok && result.page.items[0]?.description).toEqual({
      kind: 'registered',
      text: 'Note retitled from Old to New.',
    });
  });

  // Scenario: An unregistered event remains safe.
  test('missing, throwing, and invalid renderers fall back without raw before/after values', async () => {
    const secretRow = stored(1, {
      beforeValue: { clue: SECRET_VALUE },
      afterValue: { clue: `${SECRET_VALUE}!` },
    });
    const registries = [
      new AuditRendererRegistry(),
      registryWith(() => {
        throw new Error(SECRET_VALUE);
      }),
      registryWith(() => ({ text: '' })),
    ];
    for (const registry of registries) {
      const service = new AuditQueryService(new MemoryReader([secretRow]), registry);
      const result = await service.query({ scope: { campaignId: CAMPAIGN } }, everything);
      if (!result.ok) throw new Error('expected a page');
      expect(result.page.items[0]?.description).toEqual({
        kind: 'generic',
        text: 'Recorded note.updated on note.',
      });
      const body = JSON.stringify(result.page);
      expect(body).not.toContain(SECRET_VALUE);
      expect(body).not.toContain('before');
      expect(body).not.toContain('after');
      expect(body).not.toContain('campaignSequence');
    }
  });

  test('the limit defaults and is bounded', async () => {
    const rows = Array.from({ length: 120 }, (_, index) => stored(index + 1));
    const service = new AuditQueryService(new MemoryReader(rows), new AuditRendererRegistry());
    const byDefault = await service.query({ scope: { campaignId: CAMPAIGN } }, everything);
    expect(byDefault.ok && byDefault.page.items).toHaveLength(AUDIT_PAGE_DEFAULT_LIMIT);
    const large = await service.query({ scope: { campaignId: CAMPAIGN }, limit: 500 }, everything);
    expect(large.ok && large.page.items).toHaveLength(100);
    expect(large.ok && large.page.total).toBe(120);
  });
});
