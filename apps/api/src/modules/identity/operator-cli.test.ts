import { describe, expect, test } from 'bun:test';
import {
  type IdentityRecoveryLog,
  type IdentityRecoveryStore,
  type RecoveryIssuanceAudit,
  RecoveryService,
} from '@rpg/identity';

import { runOperatorRecoveryCommand } from './operator-cli.ts';

function service(): RecoveryService {
  const store: IdentityRecoveryStore = {
    issueForUsername: async () => ({
      ok: true,
      value: {
        tokenId: '0198f702-4be0-7000-8000-000000000001',
        userId: '0198f702-4be0-7000-8000-000000000002',
        issuedAt: new Date('2026-08-28T12:00:00Z'),
        expiresAt: new Date('2026-08-28T12:30:00Z'),
      },
    }),
    consume: async () => ({ ok: false, error: 'unusable_token' }),
  };
  const audit: RecoveryIssuanceAudit = { recordIssued: async () => undefined };
  const log: IdentityRecoveryLog = {
    recoveryIssued: () => undefined,
    recoveryIssuanceAuditDegraded: () => undefined,
    recoverySucceeded: () => undefined,
    recoveryFailed: () => undefined,
  };
  return new RecoveryService(
    store,
    {
      hash: async () => 'unused',
      verify: async () => ({ valid: false, needsRehash: false }),
    },
    audit,
    log,
  );
}

describe('operator recovery command', () => {
  test('writes the raw token to stdout exactly once and only safe diagnostics to stderr', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runOperatorRecoveryCommand({
      databaseUrl: 'postgres://local-command-only',
      args: ['--username', 'table_gm', '--operator-reference', 'host:desk-1'],
      output: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      createRuntime: () => ({ service: service(), close: async () => undefined }),
    });

    expect(exitCode).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stderr.join('\n')).not.toContain(stdout[0] ?? 'missing');
    expect(stderr.join('\n')).toContain('Expires at 2026-08-28T12:30:00.000Z.');
  });

  test('requires both trusted database access and an explicit username', async () => {
    const stderr: string[] = [];
    const output = { stdout: () => undefined, stderr: (line: string) => stderr.push(line) };

    expect(await runOperatorRecoveryCommand({ databaseUrl: undefined, args: [], output })).toBe(2);
    expect(stderr).toEqual(['Usage: --username <username> [--operator-reference <reference>]']);

    stderr.length = 0;
    expect(
      await runOperatorRecoveryCommand({
        databaseUrl: undefined,
        args: ['--username', 'table_gm'],
        output,
      }),
    ).toBe(2);
    expect(stderr).toEqual(['DATABASE_URL is required.']);
  });
});
