import { err, ok, type Result } from '@rpg/contracts';

import { validatePassword } from '../domain/password.ts';
import { normalizeUsername } from '../domain/username.ts';
import { digestOpaqueCredential, generateOpaqueCredential } from '../infra/credentials.ts';
import type { PasswordHasher } from '../infra/password-hasher.ts';
import type {
  RecoveryTokenConsumeResult,
  RecoveryTokenIssueResult,
} from '../infra/postgres/repositories.ts';

const OPERATOR_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const OPAQUE_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface IdentityRecoveryStore {
  issueForUsername(
    usernameNormalized: string,
    input: {
      readonly id: string;
      readonly tokenDigest: Uint8Array;
      readonly operatorReference?: string;
    },
  ): Promise<RecoveryTokenIssueResult>;
  consume(input: {
    readonly tokenDigest: Uint8Array;
    readonly replacementPasswordHash: string;
  }): Promise<RecoveryTokenConsumeResult>;
}

export interface RecoveryIssuanceAudit {
  recordIssued(event: {
    readonly tokenId: string;
    readonly userId: string;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
    readonly operatorReference?: string;
  }): Promise<void>;
}

export interface IdentityRecoveryLog {
  recoveryIssued(userId: string, tokenId: string): void;
  recoveryIssuanceAuditDegraded(tokenId: string): void;
  recoverySucceeded(userId: string, tokenId: string): void;
  recoveryFailed(): void;
}

export interface IssuedRecoveryCredential {
  /** Issuance-only secret. The operator adapter writes it to stdout exactly once. */
  readonly credential: string;
  readonly tokenId: string;
  readonly userId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export type RecoveryIssuanceError =
  | 'invalid_username'
  | 'invalid_operator_reference'
  | 'user_not_found'
  | 'identity_unavailable';
export type RecoveryConsumptionError =
  | 'invalid_password'
  | 'unusable_token'
  | 'identity_unavailable';

export class RecoveryService {
  constructor(
    private readonly store: IdentityRecoveryStore,
    private readonly passwords: PasswordHasher,
    private readonly audit: RecoveryIssuanceAudit,
    private readonly log: IdentityRecoveryLog,
  ) {}

  async issue(input: {
    readonly username: string;
    readonly operatorReference?: string;
  }): Promise<Result<IssuedRecoveryCredential, RecoveryIssuanceError>> {
    const username = normalizeUsername(input.username);
    if (!username.ok) return username;
    if (
      input.operatorReference !== undefined &&
      !OPERATOR_REFERENCE_PATTERN.test(input.operatorReference)
    ) {
      return err('invalid_operator_reference');
    }

    const credential = generateOpaqueCredential();
    const issued = await this.store.issueForUsername(username.value.normalized, {
      id: crypto.randomUUID(),
      tokenDigest: await digestOpaqueCredential(credential),
      operatorReference: input.operatorReference,
    });
    if (!issued.ok) {
      return err(issued.error === 'user_not_found' ? 'user_not_found' : 'identity_unavailable');
    }

    this.log.recoveryIssued(issued.value.userId, issued.value.tokenId);
    try {
      await this.audit.recordIssued({
        ...issued.value,
        operatorReference: input.operatorReference,
      });
    } catch {
      this.log.recoveryIssuanceAuditDegraded(issued.value.tokenId);
    }
    return ok({ credential, ...issued.value });
  }

  async consume(input: {
    readonly credential: string;
    readonly newPassword: string;
  }): Promise<Result<void, RecoveryConsumptionError>> {
    const password = validatePassword(input.newPassword);
    if (!password.ok) return password;
    if (!OPAQUE_CREDENTIAL_PATTERN.test(input.credential)) return this.unusableToken();

    const consumed = await this.store.consume({
      tokenDigest: await digestOpaqueCredential(input.credential),
      replacementPasswordHash: await this.passwords.hash(password.value),
    });
    if (!consumed.ok) {
      return consumed.error === 'unusable_token'
        ? this.unusableToken()
        : err('identity_unavailable');
    }
    this.log.recoverySucceeded(consumed.value.userId, consumed.value.tokenId);
    return ok(undefined);
  }

  private unusableToken(): Result<never, RecoveryConsumptionError> {
    this.log.recoveryFailed();
    return err('unusable_token');
  }
}
