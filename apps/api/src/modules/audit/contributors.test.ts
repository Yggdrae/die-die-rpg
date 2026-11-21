import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import {
  ACCOUNT_AUDIT_ACTIONS,
  ADDITIONAL_AUDIT_ACTIONS,
  AUDIT_CONTRIBUTORS,
  createAuditRendererRegistry,
} from './contributors.ts';

/**
 * Feature 06 task 06: contributor conformance. CI fails when a PRD-required contributor is missing
 * from the inventory, when a built contributor records an action without a registered renderer,
 * or when code records an action under a contributor prefix that has not registered (including a
 * feature that is not built yet).
 */

const ROOT = new URL('../../../../../', import.meta.url);
const CAMPAIGN = '00000000-0000-4000-8000-0000000000c1';
const PLAYER = '00000000-0000-4000-8000-0000000000b1';

/** Representative payloads, as each call site records them. */
const SAMPLES: Record<
  string,
  { before?: Record<string, unknown>; after?: Record<string, unknown>; targetType?: string }
> = {
  'character.created': { after: { name: 'Ash', system: 'cairn-2e@1.0.0' } },
  'character.deleted': { before: { name: 'Ash', system: 'cairn-2e@1.0.0' } },
  'session.started': { after: { number: 3 } },
  'session.paused': { after: { number: 3, status: 'paused' } },
  'session.resumed': { after: { number: 3, status: 'active' } },
  'session.ended': { after: { number: 3, status: 'ended' } },
  'session.scene_changed': { after: { sceneId: '00000000-0000-4000-8000-000000000030' } },
  'encounter.started': { after: { name: 'Ambush at the ford' } },
  'encounter.ended': { after: { name: 'Ambush at the ford' } },
  'encounter.participant_added': {
    after: { name: 'Bandit 2', encounterId: '00000000-0000-4000-8000-000000000040' },
  },
  'encounter.participant_removed': {
    before: { name: 'Bandit 2', encounterId: '00000000-0000-4000-8000-000000000040' },
  },
  'encounter.participant_revealed': {
    after: { name: 'Bandit 2', encounterId: '00000000-0000-4000-8000-000000000040' },
  },
  'effect.applied': {
    before: { changes: [{ path: 'resources.hp.current', value: 10 }] },
    after: { changes: [{ path: 'resources.hp.current', value: 7 }] },
  },
  'membership.created': { after: { role: 'player', version: 1, removed: false } },
  'membership.removed': { after: { role: 'player', version: 3, removed: true } },
  'membership.role_changed': { after: { role: 'assistant_gm', version: 2, removed: false } },
  'membership.ownership_transferred': { after: { role: 'owner', version: 4, removed: false } },
  'campaign.created': { after: { system: { systemId: 'fixture-system', version: '1.0.0' } } },
  'campaign.details_updated': {
    before: { name: 'Draft', description: '' },
    after: { name: 'Ashen Road', description: '' },
  },
  'campaign.setting_changed': { after: { namespace: 'table.rules' } },
  'campaign.system_updated': {
    before: { system: { systemId: 'fixture-system', version: '1.0.0' } },
    after: { system: { systemId: 'fixture-system', version: '1.1.0' } },
  },
  'campaign.deleted': {},
  'campaign.imported': { after: { system: { systemId: 'fixture-system', version: '1.0.0' } } },
  'visibility.revealed': {
    targetType: 'fixture_note',
    before: { visibility: { mode: 'gm_only' }, version: 1 },
    after: { visibility: { mode: 'players', playerIds: [PLAYER] }, version: 2 },
  },
  'visibility.unrevealed': {
    targetType: 'fixture_note',
    before: { visibility: { mode: 'players', playerIds: [PLAYER] }, version: 2 },
    after: { visibility: { mode: 'gm_only' }, version: 3 },
  },
  'sync.conflict_resolved': { after: { conflictId: CAMPAIGN, choice: 'resubmit' } },
  'attachment.uploaded': {
    targetType: 'fixture_note',
    after: { mime: 'application/pdf', size: 2_516_582 },
  },
  'attachment.deleted': {
    targetType: 'fixture_note',
    before: { mime: 'image/png', size: 2048 },
  },
  'entity.created': {
    targetType: 'campaign_entity',
    after: { type: 'npc', name: 'Ferryman', summary: 'Asks for silver', tags: [] },
  },
  'entity.updated': {
    targetType: 'campaign_entity',
    before: { name: 'Ferryman', summary: '' },
    after: { type: 'npc', name: 'Old Ferryman', summary: 'Takes copper', changed: ['description'] },
  },
  'entity.deleted': { targetType: 'campaign_entity', before: { type: 'item', name: 'Lantern' } },
  'entity.relationship_created': {
    targetType: 'entity_relationship',
    after: { kind: 'member_of', sourceEntityId: CAMPAIGN, targetEntityId: PLAYER },
  },
  'entity.relationship_deleted': {
    targetType: 'entity_relationship',
    before: { kind: 'lives_at', sourceEntityId: CAMPAIGN, targetEntityId: PLAYER },
  },
  'entity.personal_note_created': {
    targetType: 'personal_note',
    after: { name: 'Elder lied', tags: [], changed: ['body'] },
  },
  'entity.personal_note_updated': {
    targetType: 'personal_note',
    before: {},
    after: { changed: ['body'] },
  },
  'entity.personal_note_deleted': { targetType: 'personal_note', before: { name: 'Elder lied' } },
};

const EXPECTED_TEXT: Record<string, string> = {
  'campaign.details_updated': 'Renamed the campaign from "Draft" to "Ashen Road".',
  'campaign.system_updated':
    'Updated the game system from fixture-system@1.0.0 to fixture-system@1.1.0.',
  'visibility.revealed': 'Revealed fixture_note to 1 player.',
  'membership.role_changed': "Changed a member's role to assistant GM.",
  'attachment.uploaded': 'Attached a PDF (2.4 MB).',
  'attachment.deleted': 'Removed a PNG image (2.0 KB).',
  'campaign.imported': 'Imported the campaign from a package with fixture-system@1.0.0.',
  'entity.created': 'Created NPC "Ferryman".',
  'session.started': 'Started session 3.',
  'session.scene_changed': 'Changed the current scene.',
  'encounter.participant_added': 'Added to the encounter: Bandit 2.',
  'entity.updated': 'Renamed NPC "Ferryman" to "Old Ferryman". Changed: summary, description.',
  'entity.deleted': 'Deleted Item "Lantern".',
  'entity.relationship_created': 'Linked two entities (member of).',
  'entity.personal_note_updated': 'Updated a personal note. Changed: text.',
};

function render(action: string, sample = SAMPLES[action] ?? {}) {
  const registry = createAuditRendererRegistry();
  return registry.render({
    action,
    targetType: sample.targetType ?? 'campaign',
    targetId: CAMPAIGN,
    ...(sample.before === undefined ? {} : { before: sample.before }),
    ...(sample.after === undefined ? {} : { after: sample.after }),
    at: '2026-10-26T14:35:00Z',
    rendererVersion: registry.currentVersion(action),
  });
}

/** Production TypeScript under packages/, apps/, and systems/ (no tests, specs, or harnesses). */
async function productionSources(): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  const walk = async (relative: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(new URL(relative, ROOT), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${relative}${entry.name}`;
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'e2e', 'drizzle'].includes(entry.name)) continue;
        await walk(`${path}/`);
      } else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.(test|e2e)\.tsx?$/.test(entry.name) &&
        !entry.name.startsWith('e2e-harness') &&
        // Declarations and this inventory name every action; only call sites count as recording.
        !['audit-declarations.ts', 'conflict-audit.ts', 'contributors.ts'].includes(entry.name)
      ) {
        files.push({ path, text: await Bun.file(new URL(path, ROOT)).text() });
      }
    }
  };
  for (const top of ['packages/', 'apps/', 'systems/']) await walk(top);
  return files;
}

describe('audit contributor inventory (feature 06 FR-005)', () => {
  test('mirrors every contributor the PRD requires', async () => {
    const prd = await Bun.file(new URL('.speckit/features/06-audit-log/_prd.md', ROOT)).text();
    const requirement = /- FR-005:([\s\S]*?)(?=\n- FR-006)/.exec(prd)?.[1] ?? '';
    const cited = [...requirement.matchAll(/\(([0-9]{2}(?:,\s*[0-9]{2})*)\)/g)].flatMap((match) =>
      (match[1] ?? '').split(/,\s*/),
    );
    expect(cited.length).toBeGreaterThanOrEqual(10);
    const inventory = AUDIT_CONTRIBUTORS.flatMap((contributor) => contributor.features);
    expect([...new Set(inventory)].sort()).toEqual([...new Set(cited)].sort());
    const prefixes = AUDIT_CONTRIBUTORS.map((contributor) => contributor.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  test('every action of a built contributor has a registered declaration that renders', () => {
    const registry = createAuditRendererRegistry();
    const actions = [
      ...AUDIT_CONTRIBUTORS.flatMap((contributor) => contributor.actions),
      ...ADDITIONAL_AUDIT_ACTIONS,
    ];
    for (const action of actions) {
      const sample = SAMPLES[action];
      expect({ action, sample: sample !== undefined }).toEqual({ action, sample: true });
      expect({ action, version: registry.currentVersion(action) >= 1 }).toEqual({
        action,
        version: true,
      });
      expect({ action, payload: registry.acceptsPayload(action, sample ?? {}) }).toEqual({
        action,
        payload: true,
      });
      expect({ action, kind: render(action).kind }).toEqual({ action, kind: 'registered' });
    }
    for (const [action, text] of Object.entries(EXPECTED_TEXT)) {
      expect(render(action).text).toBe(text);
    }
    for (const contributor of AUDIT_CONTRIBUTORS) {
      expect(contributor.status === 'built').toBe(contributor.actions.length > 0);
      for (const action of contributor.actions)
        expect(action.startsWith(`${contributor.prefix}.`)).toBe(true);
    }
  });

  test('renderers never echo raw values, whatever the payload holds', () => {
    const hostile = {
      name: { nested: '{"secret":"x"}' },
      description: 'y'.repeat(10_000),
      role: '{"role":"owner"}',
      system: { systemId: '{"a":1}', version: 3 },
      namespace: ['a'],
      visibility: { mode: 'players', playerIds: 'not-a-list' },
      choice: '<script>',
    };
    for (const action of Object.keys(SAMPLES)) {
      const output = render(action, { before: hostile, after: hostile });
      expect(output.text.length).toBeLessThanOrEqual(280);
      expect(output.text).not.toContain('{"');
      expect(output.text).not.toContain('<script>');
      expect(output.text).not.toContain('y'.repeat(100));
    }
  });

  test('code records no action outside a registered contributor (built or not)', async () => {
    const owned = AUDIT_CONTRIBUTORS.map((contributor) => contributor.prefix);
    const prefixes = [...owned, 'sync', 'recovery'];
    const literal = new RegExp(`['"\`]((?:${prefixes.join('|')})\\.[a-z_]+)['"\`]`, 'g');
    const found = new Map<string, string[]>();
    for (const file of await productionSources()) {
      for (const match of file.text.matchAll(literal)) {
        const action = match[1] ?? '';
        found.set(action, [...(found.get(action) ?? []), file.path]);
      }
    }
    const known = new Set([
      ...AUDIT_CONTRIBUTORS.flatMap((contributor) => contributor.actions),
      ...ADDITIONAL_AUDIT_ACTIONS,
      ...ACCOUNT_AUDIT_ACTIONS,
    ]);
    const unregistered = [...found].filter(([action]) => !known.has(action));
    expect(unregistered).toEqual([]);
    // Every inventoried action is still recorded somewhere (no stale row).
    for (const action of known)
      expect({ action, recorded: found.has(action) }).toEqual({ action, recorded: true });
  });
});
