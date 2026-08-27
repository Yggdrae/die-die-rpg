import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';

import { ActorRef, Role } from './actor.ts';
import { AttachmentRef } from './attachment.ts';
import { AuditEvent } from './audit.ts';
import { EntityEnvelope } from './entity.ts';
import { ApiError } from './error.ts';
import { Id, Timestamp, Version } from './primitives.ts';
import { SearchDoc } from './registries.ts';
import { SemanticOp } from './semantic-op.ts';
import { SystemRef, systemRefToString } from './system.ts';
import { Visibility } from './visibility.ts';

const ID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ID_B = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const NOW = '2026-08-27T14:32:00Z';

/**
 * Reject paths carry the weight here. These validators are the boundary that keeps invalid
 * data out of the domain (`PRD.md` s.16), and a validator is only tested by what it refuses.
 */

describe('Id', () => {
  test('accepts a lowercase uuid', () => {
    expect(Value.Check(Id, ID_A)).toBe(true);
  });

  test.each([
    ['uppercase', '3F2504E0-4F89-41D3-9A0C-0305E82C3301'],
    ['no dashes', '3f2504e04f8941d39a0c0305e82c3301'],
    ['truncated', '3f2504e0-4f89-41d3-9a0c'],
    ['empty', ''],
    ['arbitrary string', 'npc-merchant'],
  ])('rejects %s', (_label, value) => {
    expect(Value.Check(Id, value)).toBe(false);
  });
});

describe('Timestamp', () => {
  test.each([
    ['second precision utc', '2026-08-27T14:32:00Z'],
    ['millisecond precision utc', '2026-08-27T14:32:00.123Z'],
  ])('accepts %s', (_label, value) => {
    expect(Value.Check(Timestamp, value)).toBe(true);
  });

  test.each([
    ['a positive offset', '2026-08-27T14:32:00+02:00'],
    ['a local time with no zone', '2026-08-27T14:32:00'],
    ['a date only', '2026-08-27'],
    ['epoch millis', '1756305120000'],
  ])('rejects %s', (_label, value) => {
    expect(Value.Check(Timestamp, value)).toBe(false);
  });
});

describe('Version', () => {
  test('accepts 1', () => {
    expect(Value.Check(Version, 1)).toBe(true);
  });

  test.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '1'],
  ])('rejects %s', (_label, value) => {
    expect(Value.Check(Version, value)).toBe(false);
  });
});

describe('Visibility', () => {
  test.each([
    ['gm only', { mode: 'gm_only' }],
    ['everyone', { mode: 'everyone' }],
    ['a named party', { mode: 'party', partyIds: [ID_A] }],
    ['named players', { mode: 'players', playerIds: [ID_A, ID_B] }],
  ])('accepts %s', (_label, value) => {
    expect(Value.Check(Visibility, value)).toBe(true);
  });

  test('rejects an unknown mode', () => {
    expect(Value.Check(Visibility, { mode: 'party_leader' })).toBe(false);
  });

  test('rejects targeted visibility with an empty target list', () => {
    expect(Value.Check(Visibility, { mode: 'players', playerIds: [] })).toBe(false);
    expect(Value.Check(Visibility, { mode: 'party', partyIds: [] })).toBe(false);
  });

  test('rejects targeted visibility with no target list at all', () => {
    expect(Value.Check(Visibility, { mode: 'players' })).toBe(false);
  });
});

describe('Role', () => {
  test.each(['owner', 'gm', 'assistant_gm', 'player', 'observer'])('accepts %s', (value) => {
    expect(Value.Check(Role, value)).toBe(true);
  });

  test('rejects an invented role', () => {
    expect(Value.Check(Role, 'co_gm')).toBe(false);
  });
});

describe('ActorRef', () => {
  test('accepts a resolved actor', () => {
    expect(Value.Check(ActorRef, { userId: ID_A, campaignId: ID_B, role: 'gm' })).toBe(true);
  });

  test('rejects an actor with no campaign', () => {
    expect(Value.Check(ActorRef, { userId: ID_A, role: 'gm' })).toBe(false);
  });
});

describe('EntityEnvelope', () => {
  const valid = {
    id: ID_A,
    campaignId: ID_B,
    type: 'npc',
    name: 'Merchant',
    tags: ['village'],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: NOW,
    createdBy: ID_B,
    updatedAt: NOW,
    updatedBy: ID_B,
  };

  test('accepts a complete envelope', () => {
    expect(Value.Check(EntityEnvelope, valid)).toBe(true);
  });

  test('accepts a tombstoned envelope', () => {
    expect(Value.Check(EntityEnvelope, { ...valid, deletedAt: NOW })).toBe(true);
  });

  // The three fields feature 03 cannot retrofit.
  test.each(['version', 'visibility', 'campaignId'])('rejects an envelope missing %s', (field) => {
    const { [field]: _removed, ...withoutField } = valid as Record<string, unknown>;
    expect(Value.Check(EntityEnvelope, withoutField)).toBe(false);
  });

  test('rejects a non-integer version', () => {
    expect(Value.Check(EntityEnvelope, { ...valid, version: 1.5 })).toBe(false);
  });

  test('rejects an empty name', () => {
    expect(Value.Check(EntityEnvelope, { ...valid, name: '' })).toBe(false);
  });
});

describe('SemanticOp', () => {
  test.each([
    ['a delta', { op: 'delta', path: 'resources.hp', value: -3 }],
    ['a delta with a reason', { op: 'delta', path: 'resources.hp', value: -3, reason: 'attack' }],
    ['a set', { op: 'set', path: 'name', value: 'Renamed' }],
    ['a clamp', { op: 'clamp', path: 'resources.hp', min: 0, max: 6 }],
  ])('accepts %s', (_label, value) => {
    expect(Value.Check(SemanticOp, value)).toBe(true);
  });

  test('rejects a delta with a non-numeric value', () => {
    expect(Value.Check(SemanticOp, { op: 'delta', path: 'resources.hp', value: 'a lot' })).toBe(
      false,
    );
  });

  test('rejects an unknown operation', () => {
    expect(Value.Check(SemanticOp, { op: 'increment', path: 'resources.hp', value: 1 })).toBe(
      false,
    );
  });

  test('rejects an empty path', () => {
    expect(Value.Check(SemanticOp, { op: 'delta', path: '', value: 1 })).toBe(false);
  });
});

describe('ApiError', () => {
  test('accepts a code and message', () => {
    expect(Value.Check(ApiError, { code: 'version_conflict', message: 'Stale write.' })).toBe(true);
  });

  test('rejects an empty code', () => {
    expect(Value.Check(ApiError, { code: '', message: 'Stale write.' })).toBe(false);
  });
});

describe('AttachmentRef', () => {
  test('accepts a ready attachment', () => {
    expect(
      Value.Check(AttachmentRef, {
        attachmentId: ID_A,
        mime: 'image/png',
        size: 2048,
        status: 'ready',
      }),
    ).toBe(true);
  });

  test('rejects a negative size', () => {
    expect(
      Value.Check(AttachmentRef, {
        attachmentId: ID_A,
        mime: 'image/png',
        size: -1,
        status: 'ready',
      }),
    ).toBe(false);
  });
});

describe('AuditEvent', () => {
  const valid = {
    id: ID_A,
    campaignId: ID_B,
    actor: { userId: ID_B, campaignId: ID_B, role: 'gm' },
    action: 'handout.revealed',
    targetType: 'handout',
    targetId: ID_A,
    at: NOW,
    private: false,
  };

  test('accepts a public event', () => {
    expect(Value.Check(AuditEvent, valid)).toBe(true);
  });

  // Feature 06 routes on this. Missing means it cannot separate the GM-private log.
  test('rejects an event with no private flag', () => {
    const { private: _omitted, ...withoutFlag } = valid;
    expect(Value.Check(AuditEvent, withoutFlag)).toBe(false);
  });
});

describe('SystemRef', () => {
  test('accepts a pinned system', () => {
    expect(Value.Check(SystemRef, { systemId: 'example-system', version: '1.0.0' })).toBe(true);
  });

  test('renders as system-id@version', () => {
    expect(systemRefToString({ systemId: 'example-system', version: '1.0.0' })).toBe(
      'example-system@1.0.0',
    );
  });

  test.each([
    ['an unpinned version', { systemId: 'example-system', version: 'latest' }],
    ['a partial version', { systemId: 'example-system', version: '1.0' }],
    ['an uppercase system id', { systemId: 'Example-System', version: '1.0.0' }],
  ])('rejects %s', (_label, value) => {
    expect(Value.Check(SystemRef, value)).toBe(false);
  });
});

describe('SearchDoc', () => {
  test('carries visibility so feature 20 can filter at query time', () => {
    expect(
      Value.Check(SearchDoc, {
        id: 'npc:1',
        type: 'npc',
        title: 'Merchant',
        body: 'Sells rope.',
        campaignId: ID_B,
        visibility: { mode: 'gm_only' },
      }),
    ).toBe(true);
  });

  test('rejects a document with no visibility', () => {
    expect(
      Value.Check(SearchDoc, {
        id: 'npc:1',
        type: 'npc',
        title: 'Merchant',
        body: 'Sells rope.',
        campaignId: ID_B,
      }),
    ).toBe(false);
  });
});
