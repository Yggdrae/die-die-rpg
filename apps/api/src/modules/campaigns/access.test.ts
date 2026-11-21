import { describe, expect, test } from 'bun:test';
import { AuthorizationService, ResourcePolicyRegistry } from '@rpg/authorization';
import { CampaignSettingRegistry } from '@rpg/campaigns';
import type { ActorRef, Role } from '@rpg/contracts';
import { Type } from '@sinclair/typebox';
import { registerResourcePolicies } from '../sync/sync-rules.ts';
import { campaignAccessPolicy } from './access.ts';

const CAMPAIGN = '00000000-0000-4000-8000-000000000001';
const ROLES: readonly Role[] = ['owner', 'gm', 'assistant_gm', 'player', 'observer'];

function policy() {
  const settings = new CampaignSettingRegistry();
  const schema = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
  settings.register({
    namespace: 'owner.only',
    schema,
    memberVisible: true,
    writableRoles: ['owner'],
  });
  settings.register({
    namespace: 'table.shared',
    schema,
    memberVisible: true,
    writableRoles: ['owner', 'gm', 'player'],
  });
  const authorization = new AuthorizationService(
    // Campaign access only; content adapters (feature 16) are irrelevant here.
    registerResourcePolicies(new ResourcePolicyRegistry()),
  );
  return campaignAccessPolicy(authorization, settings);
}

function actor(role: Role, campaignId = CAMPAIGN): ActorRef {
  return { userId: '00000000-0000-4000-8000-000000000002', campaignId, role };
}

describe('campaign access policy', () => {
  test('write_setting needs both the feature 04 decision and the namespace writable roles', () => {
    const access = policy();
    const allowed = (namespace?: string) =>
      ROLES.filter((role) => access.decide(actor(role), 'write_setting', namespace));
    expect(allowed('owner.only')).toEqual(['owner']);
    // assistant_gm is not declared writable; observer is denied by feature 04 first.
    expect(allowed('table.shared')).toEqual(['owner', 'gm', 'player']);
    expect(allowed('unregistered.namespace')).toEqual([]);
    expect(allowed(undefined)).toEqual([]);
  });

  test('a hidden campaign-scoped value reads as GM-only', () => {
    const access = policy();
    const readers = ROLES.filter((role) =>
      access.decide(actor(role), 'read', 'owner.only', { mode: 'gm_only' }),
    );
    expect(readers).toEqual(['owner', 'gm', 'assistant_gm']);
  });

  test('other capabilities follow the campaign declaration only', () => {
    const access = policy();
    for (const role of ROLES) {
      expect(access.decide(actor(role), 'read')).toBe(role !== 'observer');
      expect(access.decide(actor(role), 'update')).toBe(role === 'owner');
      expect(access.decide(actor(role), 'delete')).toBe(role === 'owner');
      expect(access.decide(actor(role), 'update_system')).toBe(role === 'owner');
    }
  });
});
