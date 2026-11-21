import {
  type IdentityRecoveryLog,
  type RecoveryIssuanceAudit,
  RecoveryService,
} from '../application/recovery-service.ts';
import { Argon2PasswordHasher } from '../infra/password-hasher.ts';
import { connectIdentityDatabase } from '../infra/postgres/database.ts';
import { RecoveryTokenRepository } from '../infra/postgres/repositories.ts';

export function createPostgresRecoveryRuntime(input: {
  readonly connectionString: string;
  readonly audit: RecoveryIssuanceAudit;
  readonly log: IdentityRecoveryLog;
}): { readonly service: RecoveryService; close(): Promise<void> } {
  const connection = connectIdentityDatabase(input.connectionString);
  return {
    service: new RecoveryService(
      new RecoveryTokenRepository(connection.db),
      new Argon2PasswordHasher(),
      input.audit,
      input.log,
    ),
    close: connection.close,
  };
}
