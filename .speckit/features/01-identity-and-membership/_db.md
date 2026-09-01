# Data Design: Identity and Membership

Source: `_prd.md`, `_bdd.md`, and `_techspec.md`.
Related: feature 02 campaign lifecycle, feature 03 offline sync, feature 06 audit, and feature 07
campaign import/export.

## Scope and Decisions

PostgreSQL is authoritative for accounts, identity bindings, password credentials, sessions,
recovery tokens, invitations, and campaign memberships. The browser may hold a synchronized copy
of the current user's memberships, but that copy is disposable and grants no server authority.

P0 uses opaque server-side sessions. Passwords use a maintained memory-hard password hashing
implementation. High-entropy session, invitation, and recovery secrets use a separate deterministic
lookup digest; only the digest is persisted. Raw secrets are returned once at issuance and never
stored, logged, synchronized, audited, or exported.

No blob or CRDT storage is required. Optional verified email is P1 and is excluded from the P0
schema migration. Account deletion is unavailable in P0.

Persistence uses `drizzle-orm` PostgreSQL schema definitions and typed queries, the stable
`postgres` driver, and `drizzle-kit` for generated, reviewed, forward-only SQL migrations. The
repository pins exact package versions in `bun.lock` when task 03 installs them. Migrations are
generated and committed, then applied with `drizzle-kit migrate`; `drizzle-kit push` is prohibited.
PostgreSQL behavior not expressible in schema definitions uses a named custom SQL migration.

Opaque sessions are governed by
[`ADR-001`](adrs/ADR-001-opaque-server-sessions.md).

## Frozen Security and Lifecycle Constants

| Policy | P0 decision |
| --- | --- |
| Username | Trim leading/trailing ASCII whitespace; 3-32 ASCII characters; regex `[A-Za-z0-9][A-Za-z0-9_-]{2,31}`; normalize with locale-independent ASCII lowercase |
| Password input | 15-128 Unicode code points and at most 512 UTF-8 bytes; no trimming or Unicode normalization |
| Password hash | `@node-rs/argon2`; Argon2id v=19; 64 MiB; 3 iterations; parallelism 1; 16-byte random salt; 32-byte output; PHC string storage |
| Opaque secrets | 32 CSPRNG bytes, base64url without padding (43 characters); persist the 32-byte SHA-256 digest only |
| Session lifetime | 30 days absolute; no P0 idle timeout |
| Recovery lifetime | 30 minutes |
| Invitation lifetime | Seven-day default; caller-selected minimum five minutes and maximum 30 days |
| Expiry boundary | Usable only when `database_now < expires_at`; equality is expired |
| Session retention | Hard-delete 30 days after `revoked_at` when revoked, otherwise 30 days after `expires_at` |
| Recovery/invitation retention | Hard-delete 90 days after the first terminal event (`used_at`, `revoked_at`, or `expires_at`) |

All durations are exact elapsed intervals, not calendar-day boundaries. Cleanup is asynchronous;
these are earliest deletion times, not guarantees of immediate deletion.

## Sources of Truth and Ownership

| Data | Authoritative owner | Readers | Writers | Offline |
| --- | --- | --- | --- | --- |
| User/display username | Feature 01, PostgreSQL | Authenticated application flows; member summaries | Account application service | No authoritative offline write |
| Identity binding/password | Feature 01, PostgreSQL | Authentication service only | Account and recovery services | Never synchronized |
| Session | Feature 01, PostgreSQL | Authentication service; owning user in P1 | Login/logout/recovery policy | Never synchronized |
| Recovery token | Feature 01, PostgreSQL | Recovery service and trusted-host adapter | Trusted-host issuance; recovery consumption | Never synchronized |
| Invitation | Feature 01, PostgreSQL | Authorized campaign members; safe public preview | `owner`/`gm`; acceptance service | Never synchronized |
| Campaign membership | Feature 01, PostgreSQL | Only published identity APIs and sync authorization | Campaign creation, invitation acceptance, membership administration | Current user's active row is a read cache |
| Membership/recovery audit | Feature 06 | Feature 06 policy | Feature 01 through `AuditRecorder` | Defined by feature 06 |

Other features must not query these tables. Feature 02 receives the narrow owner-creation writer;
all role reads use `ActorResolver`.

## PostgreSQL Conventions

- IDs use PostgreSQL `uuid` and match the shared lowercase UUID contract when serialized.
- Instants use `timestamptz`, are generated or validated by the server, and serialize as UTC.
- Mutable lifecycle records carry `created_at` and `updated_at`. Synchronized membership rows also
  carry `version bigint NOT NULL DEFAULT 1` and a removal tombstone.
- Role/provider/token state values use check constraints. PostgreSQL enum types are avoided so
  adding an external provider or reserved role does not require an enum rewrite.
- Credential digests are exactly 32 bytes of SHA-256 output and use `bytea` plus a length check.
- Database and application logs must redact password input, password hashes, token digests, raw
  tokens, and session cookies.

## Logical Schema

### `identity_users`

| Column | Type | Constraints / meaning |
| --- | --- | --- |
| `id` | `uuid` | primary key |
| `username_display` | `text` | user-facing spelling |
| `username_normalized` | `text` | unique login comparison value |
| `created_at` | `timestamptz` | not null |
| `updated_at` | `timestamptz` | not null |

Indexes and constraints:

- Unique index on `username_normalized`; duplicate-account races are resolved by this constraint.
- `username_display` is the trimmed submitted spelling and satisfies
  `[A-Za-z0-9][A-Za-z0-9_-]{2,31}` under bytewise ASCII semantics.
- `username_normalized` equals the locale-independent ASCII lowercase of `username_display`, is
  3-32 bytes, and satisfies `[a-z0-9][a-z0-9_-]{2,31}`.
- Boundary code computes the normalized value; database checks enforce the persisted shape and the
  unique index arbitrates races. Changing normalization after accounts exist requires collision
  detection and a backfill migration.

### `identity_bindings`

| Column | Type | Constraints / meaning |
| --- | --- | --- |
| `id` | `uuid` | primary key |
| `user_id` | `uuid` | foreign key to `identity_users(id)` |
| `provider_kind` | `text` | P0 check: `local`; extensible later |
| `provider_subject` | `text` | stable provider-local subject; normalized username for P0 |
| `created_at` | `timestamptz` | not null |
| `updated_at` | `timestamptz` | not null |

Constraints:

- Unique `(provider_kind, provider_subject)`.
- Unique `(user_id, provider_kind)` for P0. Revisit only if a provider can bind more than one
  identity to one user.
- Deleting a user is restricted until account-deletion policy exists.

This table keeps the stable user ID independent of the login provider. Password material is not
stored here.

### `identity_password_credentials`

| Column | Type | Constraints / meaning |
| --- | --- | --- |
| `user_id` | `uuid` | primary key and foreign key to `identity_users(id)` |
| `password_hash` | `text` | encoded hash including algorithm, salt, and parameters |
| `changed_at` | `timestamptz` | not null |

The encoded hash is produced by `@node-rs/argon2` using Argon2id v=19, `memoryCost: 65536`,
`timeCost: 3`, `parallelism: 1`, a 16-byte random salt, and a 32-byte output. The boundary accepts
15-128 Unicode code points and at most 512 UTF-8 bytes without trimming or normalization. The
application rehashes after successful verification when algorithm/version or any cost, salt, or
output parameter is weaker than the frozen values. Plaintext never enters a database column.

### `identity_sessions`

| Column | Type | Constraints / meaning |
| --- | --- | --- |
| `id` | `uuid` | primary key; safe public session identifier |
| `user_id` | `uuid` | foreign key to `identity_users(id)` |
| `credential_digest` | `bytea` | not null, unique |
| `created_at` | `timestamptz` | not null |
| `expires_at` | `timestamptz` | not null, greater than `created_at` |
| `revoked_at` | `timestamptz` | nullable |
| `last_seen_at` | `timestamptz` | nullable; P1 display/operations only |

Indexes:

- Unique index on `credential_digest` for authentication lookup.
- Index `(user_id, expires_at DESC)` for P1 session listing and remote sign-out.
- Partial cleanup index on `expires_at` for rows not yet revoked.
- Checks require a 32-byte digest and `expires_at = created_at + interval '30 days'`.

A session is active only when `revoked_at IS NULL AND expires_at > database_now`. Logout and
remote sign-out conditionally set `revoked_at`; rows are not hard-deleted on the request path.

Sessions expire exactly 30 days after `created_at`; P0 has no idle expiry. Credentials contain 32
CSPRNG bytes and persist only their 32-byte SHA-256 digest. `credential_digest` has
`CHECK (octet_length(credential_digest) = 32)`. Successful password recovery sets `revoked_at` on
every unrevoked session for that user in the token-consumption transaction. Cleanup may hard-delete
a revoked row at `revoked_at + interval '30 days'`, or a never-revoked expired row at
`expires_at + interval '30 days'`.

### `identity_recovery_tokens`

| Column | Type | Constraints / meaning |
| --- | --- | --- |
| `id` | `uuid` | primary key; safe audit identifier |
| `user_id` | `uuid` | foreign key to `identity_users(id)` |
| `token_digest` | `bytea` | not null, unique |
| `issued_at` | `timestamptz` | not null |
| `expires_at` | `timestamptz` | not null, greater than `issued_at` |
| `used_at` | `timestamptz` | nullable |
| `revoked_at` | `timestamptz` | nullable |
| `operator_reference` | `text` | nullable safe host/operator audit reference; never a secret |

Indexes:

- Unique index on `token_digest` for consumption lookup.
- Index `(user_id, issued_at DESC)` for operator diagnostics and cleanup.
- Index on `expires_at` for retention cleanup.
- Checks require a 32-byte digest, `expires_at = issued_at + interval '30 minutes'`, and the
  optional operator-reference format defined below.

The token is usable only when both lifecycle timestamps are null and `expires_at > database_now`.
`operator_reference` must not imply that a campaign role authorized issuance.

Recovery tokens contain 32 CSPRNG bytes, expire exactly 30 minutes after `issued_at`, and persist
only a 32-byte SHA-256 digest guarded by `CHECK (octet_length(token_digest) = 32)`. Issuing a new
token locks the user and revokes every earlier unused, unrevoked token for that user. The optional
`operator_reference` is 1-64 ASCII characters matching
`[A-Za-z0-9][A-Za-z0-9._:-]{0,63}` and contains no secret. A row may be hard-deleted 90 days after
the earliest of its `used_at`, `revoked_at`, or `expires_at` terminal instants.

Trusted-host issuance uses
`bun run identity:issue-recovery --username <username> [--operator-reference <reference>]`.
The process requires the server environment and database credential, writes only the raw token
plus newline to stdout once, writes diagnostics and expiry to stderr, and exposes no HTTP issuance
route.

### `identity_invitations`

| Column | Type | Constraints / meaning |
| --- | --- | --- |
| `id` | `uuid` | primary key |
| `campaign_id` | `uuid` | foreign key to feature 02 campaign |
| `created_by_user_id` | `uuid` | foreign key to `identity_users(id)` |
| `target_role` | `text` | check: `gm`, `assistant_gm`, or `player` |
| `token_digest` | `bytea` | not null, unique |
| `created_at` | `timestamptz` | not null |
| `expires_at` | `timestamptz` | not null, greater than `created_at` |
| `used_at` | `timestamptz` | nullable |
| `accepted_by_user_id` | `uuid` | nullable foreign key to `identity_users(id)` |
| `revoked_at` | `timestamptz` | nullable |
| `revoked_by_user_id` | `uuid` | nullable foreign key to `identity_users(id)` |

Constraints:

- Unique index on `token_digest`.
- Check that `used_at` and `accepted_by_user_id` are either both null or both non-null.
- Check that `target_role` cannot be `owner` or reserved `observer`.
- Checks require a 32-byte digest and an expiry from five minutes through 30 days after
  `created_at`, inclusive.
- Index `(campaign_id, created_at DESC)` for campaign invitation administration.
- Index on `expires_at` for retention cleanup.

Authorization is checked from current memberships inside the write transaction. Creator IDs are
historical attribution and do not grant continuing authority.

Invitation tokens contain 32 CSPRNG bytes and persist only a 32-byte SHA-256 digest guarded by
`CHECK (octet_length(token_digest) = 32)`. The default lifetime is seven days; requested expiry must
be from five minutes through 30 days after database `created_at`, inclusive. The token is usable
only before `expires_at`. Any current `owner` or `gm` in the campaign may revoke any unused
invitation, regardless of creator. Public preview returns only campaign display name, target role,
and expiry; it omits internal campaign ID, inviter, and membership data, and all unusable states
share one response. A row may be hard-deleted 90 days after the earliest of its `used_at`,
`revoked_at`, or `expires_at` terminal instants. P1 email delivery metadata remains separate and
does not change token authority.

### `identity_campaign_memberships`

| Column | Type | Constraints / meaning |
| --- | --- | --- |
| `campaign_id` | `uuid` | foreign key to feature 02 campaign |
| `user_id` | `uuid` | foreign key to `identity_users(id)` |
| `role` | `text` | check: `owner`, `gm`, `assistant_gm`, or `player` |
| `created_at` | `timestamptz` | not null |
| `updated_at` | `timestamptz` | not null |
| `removed_at` | `timestamptz` | nullable tombstone |
| `version` | `bigint` | not null, starts at 1, increments on role/removal changes |

Constraints and indexes:

- Primary key `(campaign_id, user_id)`. A removed user who rejoins reactivates the same identity
  edge, clears `removed_at`, sets the invited role, and increments `version`.
- Partial unique index on `campaign_id WHERE role = 'owner' AND removed_at IS NULL` enforces at
  most one active owner.
- Index `(user_id, campaign_id) WHERE removed_at IS NULL` supports a user's campaign list and sync
  parameter lookup.
- Index `(campaign_id, role) WHERE removed_at IS NULL` supports member listing and authorization.
- `version >= 1` and allowed-role checks. Reserved `observer` is not persistable in MVP.

Exactly one owner cannot be expressed by the partial unique index alone. Feature 02's campaign
table and this table must add a database-enforced cross-table invariant before campaign creation
ships: every non-deleted campaign has exactly one active owner membership. Feature 02 owns the
mechanism and isolation decision; feature 01 does not preselect it. Application-only validation is
insufficient. Campaign creation and ownership transfer commit atomically under that mechanism.

Membership removal is a tombstone because it must reach synchronized clients. It never cascades
to authored campaign content. Account deletion is unavailable in P0, so user foreign keys restrict
deletion. Campaign hard deletion remains owned by feature 02.

Membership tombstones are retained indefinitely. Feature 03 must define the client
acknowledgment/watermark condition proving all eligible clients can no longer resurrect or retain
the membership before a finite purge policy may replace this rule.

## Transaction and Concurrency Rules

Use database time for expiry checks. Authorization reads and dependent writes occur in the same
transaction. The application maps constraint failures to stable business results.

### Account creation

1. Insert user, local identity binding, password credential, and session in one transaction.
2. Let the unique normalized-username constraint arbitrate concurrent signups.
3. Roll back every row if any insert or session issuance fails.

### Invitation acceptance

1. Find the invitation by token digest and lock it with `SELECT ... FOR UPDATE`.
2. Recheck unused, unrevoked, unexpired state using database time.
3. Insert or reactivate the membership. Reject if an active membership already exists; do not
   silently change an existing role.
4. Set `used_at` and `accepted_by_user_id` in the same transaction.

The locked conditional transition guarantees one winner. A uniqueness or state conflict rolls
back membership creation and returns the generic unusable-invitation/business-conflict result.

### Recovery consumption

1. Find the token by digest and lock it with `SELECT ... FOR UPDATE`.
2. Recheck lifecycle and expiry.
3. Replace the encoded password hash and set `changed_at`.
4. Set `revoked_at` on every currently unrevoked session for the user.
5. Set `used_at` in the same transaction.

Exactly one concurrent consumer commits.

### Membership administration

- Lock the acting and target membership rows before evaluating authority.
- Removal sets `removed_at`, increments `version`, and commits before access/sync notifications.
- Role change updates one non-owner row and increments `version`.
- Ownership transfer locks all active memberships for the campaign in a stable order, uses feature
  02's database-enforced owner mechanism, promotes the target, and demotes the former owner to `gm`
  in one transaction.
- A `gm` may remove their own membership. The transaction authorizes from the locked active row
  before applying its tombstone. A `gm` still cannot remove another `gm`.

`READ COMMITTED` plus explicit row locks and database constraints is sufficient for token
consumption and member mutation. Campaign creation/ownership integration tests must prove the
feature 02 owner invariant. Feature 02 selects stronger isolation and retry behavior if its chosen
database mechanism is not safe at `READ COMMITTED`.

Audit recording follows the frozen non-blocking `AuditRecorder` contract after the authoritative
transaction. A failed audit or revocation notification does not restore membership. Failure is
observable and retried by the owning integration; all subsequent server authorization still reads
the committed membership state.

## Offline Representation and Sync

Feature 03 owns SQLite/WASM, PowerSync configuration, subscriptions, and local deletion. Feature
01 exposes only membership-shaped authoritative data and revocation events.

The local membership cache contains only the current user's rows needed for offline actor
resolution:

| Field | Purpose |
| --- | --- |
| `campaign_id`, `user_id`, `role` | cached `ActorRef` |
| `version`, `updated_at` | server ordering/replacement |
| `removed_at` | removal tombstone and local cleanup trigger |

It must not contain usernames for unrelated users, credential data, sessions, invitations, or
recovery records. Campaign member lists are not required for offline role resolution and need a
separate visibility decision before synchronization.

Conflict behavior:

- Membership writes are server-only. No offline membership mutation is accepted.
- Higher server `version` replaces the cached role.
- A removal tombstone deletes the cached actor, campaign data, and pending campaign mutations.
- Rejected pending writes cannot recreate membership or retain access.
- Sign-out clears all local identity and campaign data as required by feature 03.

Feature 03 must define acknowledgment/watermark behavior before membership tombstones receive a
finite retention period.

## Retention, Deletion, and Export

| Data | P0 behavior |
| --- | --- |
| Users and identity bindings | Retained indefinitely; account deletion is unavailable |
| Password credential | Current encoded hash only; old hashes are not retained |
| Sessions | Hard-delete no earlier than 30 days after revocation, or 30 days after expiry when never revoked |
| Recovery tokens | Hard-delete no earlier than 90 days after the earliest use, revocation, or expiry terminal instant |
| Invitations | Hard-delete no earlier than 90 days after the earliest use, revocation, or expiry terminal instant |
| Memberships | Removal tombstone retained indefinitely until feature 03 approves a sync-safe purge policy |
| Authored campaign content | Never deleted because membership is removed |

Feature 07 may export stable user display identity and current/required membership information as
its approved format requires. It must exclude identity bindings, password hashes, optional email,
sessions, token rows, token digests, and raw credentials. Import creates a new campaign owned by
the importer and does not restore old memberships.

No account-delete path, cascade, or anonymization operation may be added in P0. A future product
decision requires a new data migration and retention review.

## Migration Plan

This is the first application persistence feature; there is no production backfill.

1. Install and configure `drizzle-orm`, `drizzle-kit`, and `postgres`; commit generated/reviewed
   migrations and apply them with `drizzle-kit migrate`. Never use schema push.
2. Create user, binding, password, session, and recovery tables plus constraints/indexes.
3. Coordinate with feature 02 to create the campaign table and invitation/membership foreign keys.
   The campaign row, initial owner membership, and deferred exactly-one-owner invariant ship
   together; do not temporarily permit ownerless committed campaigns.
4. Add invitation and membership tables and the sync publication/configuration required by
   feature 03. Publish only approved membership columns, never credential tables.
5. Add idempotent cleanup for the frozen 30-day session and 90-day token/invitation retention
   floors. Keep membership tombstones out of cleanup until feature 03 approves finite retention.
6. Add P1 email/session-management columns in a later additive migration. External provider
   bindings are additive rows and do not change user IDs.

Every migration is forward-only and transactional where PostgreSQL permits it. Destructive column
changes require an expand/backfill/verify/contract sequence and a rollback plan. Never log or copy
credential values during backfill.

## Required Database Tests

- Concurrent normalized-username inserts create one user and no orphan binding/credential/session.
- Username and password boundary values match the frozen byte/code-point rules.
- Stored password PHC strings encode Argon2id v=19 and the frozen cost, salt, and output values.
- Expired/revoked sessions fail authentication; equality with expiry fails; logout revocation is
  immediately visible.
- Concurrent invitation consumption creates/reactivates one membership and consumes once.
- Concurrent recovery consumption changes the password once, consumes once, and atomically revokes
  all existing sessions.
- Campaign creation plus owner membership is all-or-nothing.
- Partial unique and deferred constraints reject zero/multiple committed owners.
- Ownership transfer never exposes a committed invalid owner count.
- Sole-owner removal and forbidden/reserved roles fail without writes.
- Membership removal retains authored content and produces a sync tombstone/version increment.
- Actor resolution excludes removed rows and ignores client-supplied roles.
- Credential tables are absent from sync publication and feature 07 export.
- Cleanup preserves rows at the 30/90-day retention boundary, removes only older eligible rows,
  and never deletes membership tombstones.

## Blocking TODOs Before Implementation Tasks

All feature-01-owned decisions are frozen above. Remaining blockers are externally owned:

- Feature 02: select the database-enforced mechanism and transaction isolation that guarantee
  exactly one active owner for every committed, non-deleted campaign across campaign and
  membership mutations.
- Feature 03: define the acknowledgment/watermark evidence proving all eligible clients have
  observed a membership tombstone before it can be purged. Until then, retention is indefinite.
