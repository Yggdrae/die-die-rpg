import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return 'bytea';
  },
});

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const identityUsers = pgTable(
  'identity_users',
  {
    id: uuid('id').primaryKey(),
    usernameDisplay: text('username_display').notNull(),
    usernameNormalized: text('username_normalized').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('identity_users_username_normalized_uidx').on(table.usernameNormalized),
    check(
      'identity_users_username_display_check',
      sql`octet_length(${table.usernameDisplay}) BETWEEN 3 AND 32 AND ${table.usernameDisplay} COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$'`,
    ),
    check(
      'identity_users_username_normalized_check',
      sql`octet_length(${table.usernameNormalized}) BETWEEN 3 AND 32 AND ${table.usernameNormalized} COLLATE "C" ~ '^[a-z0-9][a-z0-9_-]{2,31}$' AND ${table.usernameNormalized} = lower(${table.usernameDisplay})`,
    ),
  ],
);

export const identityBindings = pgTable(
  'identity_bindings',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'restrict' }),
    providerKind: text('provider_kind').notNull(),
    providerSubject: text('provider_subject').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('identity_bindings_provider_subject_uidx').on(
      table.providerKind,
      table.providerSubject,
    ),
    uniqueIndex('identity_bindings_user_provider_uidx').on(table.userId, table.providerKind),
    check('identity_bindings_provider_kind_check', sql`${table.providerKind} = 'local'`),
  ],
);

export const identityPasswordCredentials = pgTable(
  'identity_password_credentials',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'restrict' }),
    passwordHash: text('password_hash').notNull(),
    changedAt: instant('changed_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId] })],
);

export const identitySessions = pgTable(
  'identity_sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'restrict' }),
    credentialDigest: bytea('credential_digest').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    expiresAt: instant('expires_at').notNull(),
    revokedAt: instant('revoked_at'),
    lastSeenAt: instant('last_seen_at'),
  },
  (table) => [
    uniqueIndex('identity_sessions_credential_digest_uidx').on(table.credentialDigest),
    index('identity_sessions_user_expiry_idx').on(table.userId, table.expiresAt.desc()),
    index('identity_sessions_active_cleanup_idx')
      .on(table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      'identity_sessions_credential_digest_length_check',
      sql`octet_length(${table.credentialDigest}) = 32`,
    ),
    check(
      'identity_sessions_expiry_check',
      sql`${table.expiresAt} = ${table.createdAt} + interval '30 days'`,
    ),
  ],
);

export const identityRecoveryTokens = pgTable(
  'identity_recovery_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'restrict' }),
    tokenDigest: bytea('token_digest').notNull(),
    issuedAt: instant('issued_at').notNull().defaultNow(),
    expiresAt: instant('expires_at').notNull(),
    usedAt: instant('used_at'),
    revokedAt: instant('revoked_at'),
    operatorReference: text('operator_reference'),
  },
  (table) => [
    uniqueIndex('identity_recovery_tokens_digest_uidx').on(table.tokenDigest),
    index('identity_recovery_tokens_user_issued_idx').on(table.userId, table.issuedAt.desc()),
    index('identity_recovery_tokens_expiry_idx').on(table.expiresAt),
    check(
      'identity_recovery_tokens_digest_length_check',
      sql`octet_length(${table.tokenDigest}) = 32`,
    ),
    check(
      'identity_recovery_tokens_expiry_check',
      sql`${table.expiresAt} = ${table.issuedAt} + interval '30 minutes'`,
    ),
    check(
      'identity_recovery_tokens_operator_reference_check',
      sql`${table.operatorReference} IS NULL OR (octet_length(${table.operatorReference}) BETWEEN 1 AND 64 AND ${table.operatorReference} COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$')`,
    ),
  ],
);

export const identitySchema = {
  identityBindings,
  identityPasswordCredentials,
  identityRecoveryTokens,
  identitySessions,
  identityUsers,
};
