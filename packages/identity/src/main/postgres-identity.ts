import type { AuditRecorder, CampaignAccessRevocationPublisher } from '@rpg/contracts';
import {
  AccountSessionService,
  type IdentityAuthenticationLog,
} from '../application/account-session-service.ts';
import { InvitationService } from '../application/invitation-service.ts';
import { type MembershipLog, MembershipService } from '../application/membership-service.ts';
import {
  type IdentityRecoveryLog,
  type RecoveryIssuanceAudit,
  RecoveryService,
} from '../application/recovery-service.ts';
import { Argon2PasswordHasher } from '../infra/password-hasher.ts';
import { connectIdentityDatabase } from '../infra/postgres/database.ts';
import {
  type CampaignDisplayNameReader,
  PostgresCampaignMembershipWriter,
  PostgresInvitationRepository,
  PostgresMembershipRepository,
} from '../infra/postgres/membership-repository.ts';
import {
  AccountRepository,
  RecoveryTokenRepository,
  SessionRepository,
} from '../infra/postgres/repositories.ts';

export function createPostgresIdentityRuntime(input: {
  readonly connectionString: string;
  readonly campaignNames: CampaignDisplayNameReader;
  readonly audit: AuditRecorder;
  readonly revocations: CampaignAccessRevocationPublisher;
  readonly recoveryAudit: RecoveryIssuanceAudit;
  readonly authenticationLog: IdentityAuthenticationLog;
  readonly recoveryLog: IdentityRecoveryLog;
  readonly membershipLog: MembershipLog;
}) {
  const connection = connectIdentityDatabase(input.connectionString);
  const memberships = new MembershipService(
    new PostgresMembershipRepository(connection.db),
    input.audit,
    input.revocations,
    input.membershipLog,
  );
  const passwords = new Argon2PasswordHasher();
  return {
    accounts: new AccountSessionService(
      new AccountRepository(connection.db),
      new SessionRepository(connection.db),
      passwords,
      input.authenticationLog,
    ),
    recovery: new RecoveryService(
      new RecoveryTokenRepository(connection.db),
      passwords,
      input.recoveryAudit,
      input.recoveryLog,
    ),
    invitations: new InvitationService(
      new PostgresInvitationRepository(connection.db, input.campaignNames),
    ),
    memberships,
    membershipWriter: new PostgresCampaignMembershipWriter(),
    close: connection.close,
  };
}
