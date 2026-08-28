import { describe, expect, test } from 'bun:test';

import type { PasswordHasher } from '../infra/password-hasher.ts';
import type {
  RecoveryTokenConsumeResult,
  RecoveryTokenIssueResult,
} from '../infra/postgres/repositories.ts';
import {
  type IdentityRecoveryLog,
  type IdentityRecoveryStore,
  type RecoveryIssuanceAudit,
  RecoveryService,
} from './recovery-service.ts';

const ISSUED_AT = new Date('2026-08-28T12:00:00Z');
const EXPIRES_AT = new Date('2026-08-28T12:30:00Z');

class FakeRecoveryStore implements IdentityRecoveryStore {
  issueResult: RecoveryTokenIssueResult = {
    ok: true,
    value: {
      tokenId: '0198f702-4be0-7000-8000-000000000001',
      userId: '0198f702-4be0-7000-8000-000000000002',
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    },
  };
  consumeResult: RecoveryTokenConsumeResult = {
    ok: true,
    value: {
      tokenId: '0198f702-4be0-7000-8000-000000000001',
      userId: '0198f702-4be0-7000-8000-000000000002',
    },
  };
  issuedInput?: { readonly username: string; readonly digest: Uint8Array };
  consumeCalls = 0;

  async issueForUsername(
    usernameNormalized: string,
    input: { readonly tokenDigest: Uint8Array },
  ): Promise<RecoveryTokenIssueResult> {
    this.issuedInput = { username: usernameNormalized, digest: input.tokenDigest };
    return this.issueResult;
  }

  async consume(): Promise<RecoveryTokenConsumeResult> {
    this.consumeCalls += 1;
    return this.consumeResult;
  }
}

const passwords: PasswordHasher = {
  hash: async (password) => `hash:${password}`,
  verify: async () => ({ valid: false, needsRehash: false }),
};

function harness(auditFailure = false) {
  const store = new FakeRecoveryStore();
  const auditEvents: unknown[] = [];
  const degraded: string[] = [];
  const audit: RecoveryIssuanceAudit = {
    recordIssued: async (event) => {
      auditEvents.push(event);
      if (auditFailure) throw new Error('audit unavailable');
    },
  };
  const log: IdentityRecoveryLog = {
    recoveryIssued: () => undefined,
    recoveryIssuanceAuditDegraded: (tokenId) => degraded.push(tokenId),
    recoverySucceeded: () => undefined,
    recoveryFailed: () => undefined,
  };
  return {
    store,
    auditEvents,
    degraded,
    service: new RecoveryService(store, passwords, audit, log),
  };
}

describe('RecoveryService', () => {
  test('issues one opaque credential while persisting only its digest and safe reference', async () => {
    const { service, store, auditEvents } = harness();
    const result = await service.issue({
      username: ' Table_GM ',
      operatorReference: 'host:desk-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.issuedInput?.username).toBe('table_gm');
    expect(store.issuedInput?.digest).toHaveLength(32);
    expect(Buffer.from(store.issuedInput?.digest ?? []).toString('base64url')).not.toBe(
      result.value.credential,
    );
    expect(JSON.stringify(auditEvents)).not.toContain(result.value.credential);
    expect(auditEvents).toHaveLength(1);
  });

  test('reports audit degradation without retracting an issued credential', async () => {
    const { service, degraded } = harness(true);
    const result = await service.issue({ username: 'table_gm' });

    expect(result.ok).toBe(true);
    expect(degraded).toEqual(['0198f702-4be0-7000-8000-000000000001']);
  });

  test('rejects unsafe operator references before persistence', async () => {
    const { service, store } = harness();
    expect(
      await service.issue({ username: 'table_gm', operatorReference: 'campaign owner' }),
    ).toEqual({ ok: false, error: 'invalid_operator_reference' });
    expect(store.issuedInput).toBeUndefined();
  });

  test('fails malformed and unavailable tokens closed', async () => {
    const { service, store } = harness();
    expect(
      await service.consume({ credential: 'not-a-token', newPassword: 'valid recovery password' }),
    ).toEqual({ ok: false, error: 'unusable_token' });
    expect(store.consumeCalls).toBe(0);

    store.consumeResult = { ok: false, error: 'unusable_token' };
    expect(
      await service.consume({ credential: 'a'.repeat(43), newPassword: 'valid recovery password' }),
    ).toEqual({ ok: false, error: 'unusable_token' });
  });

  test('validates the new password before consuming the token', async () => {
    const { service, store } = harness();
    expect(await service.consume({ credential: 'a'.repeat(43), newPassword: 'too short' })).toEqual(
      { ok: false, error: 'invalid_password' },
    );
    expect(store.consumeCalls).toBe(0);
  });
});
