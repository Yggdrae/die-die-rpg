# TechSpec: Identity and Membership

Source: `_prd.md` and `_bdd.md`.
Related: feature 00 contracts and architecture, feature 02 campaign creation, feature 03 sync,
feature 04 authorization, and feature 06 audit.
Persistence and transactional invariants are defined in `_db.md`. No `_domain.md` is needed for
the small rule set in this feature.

Review note (2026-08-28): the identity package, core PostgreSQL migration, account/session service,
authentication adapter, and operator recovery flow now exist and pass their focused tests. Membership,
invitation, campaign-owner integration, HTTP route set, web flows, and real audit/sync integration
remain proposed work tracked in `_tasks.md`.

## Executive Summary

Add one identity-and-membership capability to the modular monolith. It owns local accounts,
opaque server-side sessions, operator-issued recovery tokens, campaign membership, and invitation
consumption. Other features receive authenticated user identity from the API authentication hook
and campaign identity through one published `ActorResolver`; they never query membership storage.

PostgreSQL is authoritative. Passwords use a maintained password-hashing implementation with a
memory-hard algorithm and per-password salt. Session, invitation, and recovery credentials are
random opaque secrets; only cryptographic hashes are persisted. Membership and token transitions
that must be single-use or preserve sole ownership execute in database transactions.

The browser may cache the current user's synchronized membership rows for offline reads. This
cache grants no server authority. Feature 03 owns synchronization, local database removal, and
reconciliation when a membership is revoked.

P0 is specified here. P1 routes and optional email delivery extend the same boundaries but do not
block MVP. External identity providers and MFA remain P2.

## Current State

Verified repository facts:

- Bun workspace with strict TypeScript, Biome, Bun Test, a Fastify API shell, and React/Vite PWA.
- `apps/api/src/app.ts` provides TypeBox route typing and the shared `ApiError` response shape. It
  has no authentication, domain routes, or persistence.
- `packages/contracts/src/actor.ts` publishes `Role` and `ActorRef`. `Role` includes reserved
  `observer`; `ActorRef` contains `userId`, `campaignId`, and `role`.
- `packages/contracts/src/audit.ts` publishes `AuditRecorder`. Feature 06 owns durable audit
  storage; feature 01 must call the boundary for membership changes.
- `tools/guard` enforces architectural boundaries. Feature 00 requires identity to be the only
  supported source of campaign roles.
- No PostgreSQL application adapter, migration framework, auth library, cookie policy, or email
  provider is installed. This design selects `drizzle-orm`, `drizzle-kit`, `postgres`, and
  `@node-rs/argon2`; installation belongs to later implementation tasks.
- Feature 02 owns campaign creation. It must call the membership operation defined here in the
  same transaction so the creator becomes the sole owner.

Everything below is proposed.

## Proposed Architecture

```text
packages/identity/
├── domain/          Role constraints and pure transition validation
├── application/     Account, session, invitation, membership, recovery use cases
├── contracts/       TypeBox request/response schemas and public module interfaces
└── infra/           PostgreSQL repositories, hashing, opaque-token generation

apps/api/src/modules/identity/
├── routes.ts        Thin Fastify route registration
├── authenticate.ts  Session credential -> AuthenticatedUser
└── operator-cli.ts  Trusted-host recovery-token issuance entry point

apps/web/src/features/identity/
└── signup, login, recovery, invitation continuation, membership screens
```

The package is split only at boundaries that carry a rule or an infrastructure dependency:

- Domain code knows roles and lifecycle rules, not Fastify, PostgreSQL, cookies, or PowerSync.
- Application use cases own authorization, transaction intent, and failure translation.
- Infrastructure owns credential hashing, token generation, persistence, and clocks.
- Fastify routes validate and translate HTTP only.
- The trusted-host recovery command invokes the same application use case through an
  operator-only adapter; it is not an authenticated campaign HTTP route.

The API authentication hook establishes `AuthenticatedUser { userId, sessionId }` from the
server-side session. Campaign routes then call `ActorResolver.resolve(userId, campaignId)`.
Client-supplied roles are ignored and must not appear in authenticated request schemas.

## Interfaces and Contracts

Public package surface:

```ts
interface AuthenticatedUser {
  readonly userId: Id;
  readonly sessionId: Id;
}

interface ActorResolver {
  resolve(userId: Id, campaignId: Id): Promise<Result<ActorRef, 'membership_not_found'>>;
}

interface CampaignMembershipWriter {
  createOwner(input: { userId: Id; campaignId: Id }): Promise<Result<ActorRef, MembershipError>>;
}
```

`ActorResolver` is the only exported role-resolution interface. Repository types remain internal.
`CampaignMembershipWriter.createOwner` is exported specifically for feature 02 and participates
in its database transaction; it is not a general role-assignment escape hatch.

Boundary schemas:

| Contract | Fields / constraints |
| --- | --- |
| `Username` | Trim ASCII whitespace; 3-32 ASCII characters; first is alphanumeric; remainder matches `[A-Za-z0-9_-]`; lowercase comparison value plus retained trimmed display value |
| `PasswordInput` | Boundary-only secret; 15-128 Unicode code points and at most 512 UTF-8 bytes; no trimming or normalization; never serialized in a response or log |
| `UserSummary` | `id`, `username`, optional verified-email state only when P1 ships |
| `SessionSummary` | `id`, `createdAt`, `expiresAt`, `lastSeenAt?`, `current`; never credential/hash |
| `MembershipView` | `user`, `campaignId`, one MVP role; removed rows excluded |
| `InvitationView` | `id`, `campaignId`, target role, expiry, revocation/consumption state; never token/hash after creation |
| `InvitationCredential` | Opaque token accepted only at the invitation boundary |
| `RecoveryCredential` | Opaque token accepted only at the recovery boundary |

Assignable invitation and ordinary role-change roles are `gm | assistant_gm | player`. `owner` is
created only by campaign creation or ownership transfer. `observer` fails validation for all MVP
write operations even though it remains valid in the shared `Role` contract.

Password hashing uses `@node-rs/argon2` with Argon2id v=19, 64 MiB memory (`memoryCost: 65536`),
three iterations, one lane, a library-generated 16-byte random salt, and a 32-byte output. The PHC
encoded string is stored, and successful login rehashes when any stored parameter is weaker or no
longer current.

Session, invitation, and recovery credentials are 32 random bytes from the runtime CSPRNG,
base64url-encoded without padding as 43-character strings. Persistence stores only the 32-byte
SHA-256 digest. SHA-256 is appropriate here because the input has 256 bits of entropy; it is never
used for passwords. Raw credentials exist only in the issuance response or secure cookie and are
redacted from logs.

Lifecycle constants use database time and an exclusive expiry boundary: a credential is usable
only while `database_now < expires_at`. Sessions expire 30 days after issuance and have no P0 idle
timeout. Recovery tokens expire after 30 minutes. Invitations default to seven days; callers may
choose a lifetime from five minutes through 30 days, inclusive.

## API

All structured requests and responses use TypeBox. Success responses omit secrets except at the
single issuance boundary. Authentication uses an `HttpOnly`, `Secure` in production,
`SameSite=Lax` cookie containing the opaque session credential. State-changing cookie-authenticated
routes require same-origin enforcement and CSRF protection appropriate to the deployed origin.

| Method | Path | Auth | Request | Success response |
| --- | --- | --- | --- | --- |
| POST | `/auth/accounts` | none | username, password | user summary; sets session cookie |
| POST | `/auth/sessions` | none | username, password | user/session summary; sets session cookie |
| DELETE | `/auth/session` | session | none | `204` and cleared cookie |
| POST | `/auth/recovery/consume` | recovery token | token, new password | `204`; token consumed |
| GET | `/invitations/:token` | none | token in path | safe campaign/invitation preview or generic unusable result |
| POST | `/invitations/:token/accept` | session | token in path | membership and campaign destination |
| POST | `/campaigns/:campaignId/invitations` | owner/gm | target role, expiry | invitation metadata plus raw token once |
| DELETE | `/campaigns/:campaignId/invitations/:invitationId` | owner/gm | none | `204` |
| GET | `/campaigns/:campaignId/members` | campaign member | pagination | current membership views |
| GET | `/users/me/campaigns` | session | pagination | current campaign membership views |
| DELETE | `/campaigns/:campaignId/members/:userId` | owner/gm | none | `204` |
| PATCH | `/campaigns/:campaignId/members/:userId/role` | owner | non-owner role | membership view |
| POST | `/campaigns/:campaignId/ownership-transfer` | owner | target user ID | committed memberships; former owner is `gm` |

P1 adds `GET /auth/sessions`, `DELETE /auth/sessions/:sessionId`, verified-email management, and
optional email delivery for invitations. Email remains optional metadata, never the login key.

The logged-out invitation flow stores only the invitation token in short-lived browser navigation
state or a narrowly scoped, protected cookie. After signup/login, the client submits that same
token to the acceptance endpoint. Authentication must not encode or consume the invitation.

The operator recovery adapter is the root command
`bun run identity:issue-recovery --username <username> [--operator-reference <reference>]`. It is
available only to a process with the server environment and database credential. It writes only
the raw 43-character token plus a newline to stdout once; diagnostics and the expiry instant go to
stderr. The optional non-secret reference is 1-64 ASCII characters matching
`[A-Za-z0-9][A-Za-z0-9._:-]*`. Issuance revokes any earlier unused recovery token for that user in
the same transaction. Normal HTTP routes cannot issue recovery tokens.

## Authorization and Visibility

| Operation | Rule |
| --- | --- |
| Resolve actor | Current authoritative membership must exist |
| List campaign members | Requester has any current campaign membership; feature 04 may narrow fields later |
| List own campaigns/sessions | Authenticated user may access only their own records |
| Create/revoke invitation | Any current `owner` or `gm` in that campaign; creator identity is irrelevant |
| Remove non-owner member | `owner` may remove any non-owner; `gm` may remove only `assistant_gm` or `player`, never another `gm` |
| Change non-owner role | Current `owner` only |
| Transfer ownership | Current owner only; target is a current member |
| Issue recovery | Trusted host operator only; campaign role is irrelevant |
| GM self-removal | A current `gm` may remove themselves after authority is checked in the transaction |

Missing membership, hidden campaign, and unauthorized campaign access use the shared
`not_found_or_forbidden` response where existence disclosure would leak data. Authentication
failures return `unauthenticated`. Public invitation preview exposes only campaign display name,
target role, and expiry. It omits inviter identity, campaign members, and internal campaign ID.
Unknown, expired, revoked, and used tokens return the same unusable-invitation result.

Removing membership invalidates fresh `ActorResolver` calls immediately in the committed
transaction. The application also publishes a revocation signal to the feature 03 boundary so
connected sync access is cut and local campaign data is scheduled for deletion. The database,
not that notification, remains authoritative.

## Data and Persistence

- Source of truth: PostgreSQL for users, identity bindings, password credentials, sessions,
  recovery tokens, invitations, and campaign memberships.
- Local source: synchronized current-user membership rows are a disposable read cache only.
- Required data document: `_db.md` must define tables, indexes, foreign keys, normalization,
  token/session cleanup, migrations, and the transaction/isolation mechanism.

Logical records:

| Record | Required semantics |
| --- | --- |
| User | Stable internal ID, instance-unique normalized username, display username, timestamps |
| Identity binding | User ID, provider kind, provider subject; local-password binding now, external provider later without changing user IDs |
| Password credential | User ID, algorithm/version parameters, salted hash, changed timestamp |
| Auth session | ID, user ID, credential hash, issued/expiry/revoked timestamps, optional last-seen metadata |
| Recovery token | ID, user ID, token hash, issued/expiry/used/revoked timestamps, operator audit metadata |
| Invitation | ID, campaign ID, target role, token hash, creator, expiry/used/revoked timestamps, accepting user |
| Campaign membership | Campaign ID, user ID, exactly one role, active/removal lifecycle timestamps |

Required uniqueness and atomicity:

- One user per normalized username.
- At most one current membership per `(campaignId, userId)`.
- Exactly one committed owner per campaign. Campaign creation and initial owner membership share
  one transaction. Ownership transfer promotes the target and demotes the former owner to `gm` in
  one transaction.
- Invitation and recovery consumption perform conditional state transition and dependent write in
  one transaction. Concurrent consumers produce exactly one success.
- Removal never cascades to campaign content authored by that user.
- Password reset consumes its token and revokes every existing session for the user atomically.
  Recovery does not create a session; the user logs in with the new password.

Token rows retain hashes and lifecycle metadata only for the retention window defined in `_db.md`.
Credentials, tokens, sessions, and password hashes are excluded from feature 07 exports.

## Offline and Synchronization

- Offline behavior: the client resolves its cached `ActorRef` for an already-synchronized campaign
  from its current membership cache. Signup, login, invitation acceptance, recovery, membership
  administration, and authoritative role mutation require the server.
- Sync ownership: feature 03 owns SQLite/WASM, PowerSync, subscription rules, queueing, reconnect,
  and local database deletion. Feature 01 exposes authoritative membership changes and a
  revocation feed/boundary without importing PowerSync.
- Conflict strategy: server membership state wins. Role change and removal are authoritative
  transitions, not offline last-write-wins entities. On reconnect, a removed row/tombstone deletes
  the cached actor and campaign database; a changed role replaces the cached role.
- Pending offline mutations from a revoked user must be rejected during upload authorization and
  must not restore membership or data.

## Realtime

No general WebSocket feature is introduced. Connected sync access changes immediately through
feature 03's provider-neutral revocation boundary. UI notification may use the sync status/error
surface owned by feature 03. Correctness never depends on an ephemeral message being delivered.

## Blob Storage

N/A. Avatars and profile media are out of scope. No identity secret enters object storage.

## Error Handling

| Failure | API behavior |
| --- | --- |
| Duplicate username | Stable conflict/validation code; no account or session created |
| Invalid login | Generic invalid-credentials response; no account-enumeration detail |
| Missing/expired/revoked session | Clear cookie where applicable; `unauthenticated`; equality with `expires_at` is expired |
| Invalid/expired/revoked/used token | Generic unusable-token response; no state change |
| Concurrent token consumption | One success; loser receives unusable-token response |
| Missing membership or unauthorized campaign target | `not_found_or_forbidden` where disclosure matters |
| Reserved or forbidden role | Validation/business error; no write |
| Sole-owner removal | Business conflict; transaction rolls back |
| Ownership transfer conflict | Transaction rolls back; ownership remains unchanged |
| Audit recorder unavailable | Membership mutation remains committed; retry/degradation follows `AuditRecorder` contract |
| Sync revocation delivery unavailable | Membership remains revoked authoritatively; retry signal and deny all subsequent server access |
| Unexpected persistence/hash failure | Safe shared error; internal detail logged without credential material |

Login and token endpoints require rate limiting. Authentication logs include outcome, request
correlation, and safe account/token identifiers where available, never passwords, raw tokens,
session credentials, hashes, or full optional email addresses.

## Observability

- Logs: account creation outcome, login failure category, session revocation, token lifecycle
  outcome, authorization denial category, and degraded sync/audit notifications. Redaction tests
  cover every credential-bearing boundary.
- Audit: recovery issuance and membership create/remove/role-change/ownership-transfer events.
  Until feature 06 persists them, use its documented no-op/retry adapter contract.
- Metrics: authentication successes/failures, invitation acceptance latency/outcome, recovery
  outcome, active-session count, and revocation propagation failures. No username or token labels.
- Traces: application-use-case spans may carry generated IDs, never secrets. Distributed tracing
  infrastructure is not introduced by this feature.

## Testing Strategy

- Unit: username/password boundaries, username normalization, role assignment rules,
  reserved-role rejection, owner invariants, token state transitions, exclusive expiry boundaries,
  credential encoding/digest, credential redaction, and application authorization.
- Integration with PostgreSQL: unique username race, concurrent invitation/recovery consumption,
  create-campaign-plus-owner atomicity, ownership transfer, sole-owner removal rejection, session
  expiry/revocation, password verification/rehash path, and authored-content retention.
- Contract: every Fastify request/response schema, `ActorResolver`, and feature 02 owner-creation
  boundary. Architecture guard rejects direct membership-store imports outside feature 01.
- Sync integration with feature 03 double: removal and role change revoke connected access; server
  rejection wins over cached membership and pending writes.
- E2E with Playwright: signup to campaign creation; login/logout; logged-out invitation through
  signup/login to campaign; invite revocation; member removal; recovery consumption; secret values
  absent from browser-visible responses and logs.
- Security: rate-limit behavior, cookie flags, CSRF/origin checks, account-enumeration resistance,
  malformed credential limits, and raw-secret log scanning.

BDD scenarios are the acceptance suite. P1 scenarios stay skipped/tagged until their scope ships;
they are not weakened to make P0 pass.

## Implementation Sequence

1. Use the frozen behavior in `_prd.md`, `_bdd.md`, and `_db.md`, plus the accepted opaque-session
   ADR.
2. Add identity package contracts, domain rules, hashing/token ports, and focused unit tests.
3. Add PostgreSQL migrations/adapters and transactional concurrency tests.
4. Add authentication hook and P0 account/session/recovery routes, including the trusted-host
   recovery issuance adapter.
5. Add membership, invitation, actor-resolution, and feature 02 campaign-owner integration.
6. Add feature 03 revocation/cache boundary and feature 06 audit adapter integration.
7. Add React flows and Playwright acceptance coverage.
8. Add P1 session management and optional email only as separately scoped tasks.

## Impacted Areas

- `packages/identity/` — existing capability package; extend it with membership and invitation scope.
- `packages/contracts/` — export only cross-feature identity interfaces if they must be globally
  shared; keep feature-specific HTTP schemas in `packages/identity`.
- `apps/api/src/app.ts` and `apps/api/src/modules/identity/` — plugin registration, authentication,
  routes, and operator adapter.
- `apps/web/src/features/identity/` and application routing — user flows.
- PostgreSQL migration/configuration area selected in `_db.md` — new identity tables and indexes.
- `tools/guard/` — prohibit direct membership persistence access and client-supplied actor roles.
- Feature 02 integration — atomic campaign creation plus owner membership.
- Feature 03 integration boundary — membership-filtered sync and revocation cleanup.
- Feature 06 integration boundary — membership and recovery audit events.

## Risks and Tradeoffs

- Opaque sessions require a database lookup but give immediate revocation and remote sign-out
  without a token denylist. This matches the product requirement and private-instance scale.
- A cached offline role can remain visible until reconnect. The product explicitly accepts the
  cache as non-authoritative; server writes fail closed and feature 03 deletes local campaign data
  after reconciliation.
- Non-blocking audit recording can temporarily omit an access-change event. This follows the frozen
  `AuditRecorder` contract; retry/degradation must be observable without rolling back the access
  change.
- The operator recovery command is security-sensitive. Keeping issuance outside campaign HTTP
  authorization reduces attack surface but requires documented host-access procedures.
- Native Argon2 bindings add a platform-specific runtime dependency. Task 03 must verify the
  pinned `@node-rs/argon2` package under the repository's supported Bun/host matrix before schema
  work proceeds.

## ADRs

- Accepted: [`ADR-001: Opaque server-side sessions`](adrs/ADR-001-opaque-server-sessions.md).
  Immediate revocation, remote sign-out, and sync-layer access removal outweigh one indexed lookup
  per authenticated request.
- No ADR yet for single-role membership: the PRD already approves exactly one role and no competing
  implementation is in scope.
- No ADR for external identity-provider support: the stable user plus provider-binding model is a
  compatibility constraint, not an implemented provider decision.

## Frozen P0 Lifecycle Decisions

- A `gm` may remove themselves but may not remove another `gm`.
- Any current `owner` or `gm` may revoke any unused invitation in their campaign.
- Ownership transfer always demotes the former owner to `gm`.
- Account deletion is unavailable. Users, bindings, and current password credentials are retained.
- Revoked/expired sessions are retained for 30 days; recovery tokens and invitations are retained
  for 90 days after their terminal instant. Membership tombstones are retained indefinitely until
  feature 03 defines safe purge acknowledgment.
- Migration/query tooling is Drizzle ORM with PostgreSQL schema definitions, `drizzle-kit`
  generated/reviewed forward-only SQL migrations, and the stable `postgres` driver. Complex
  PostgreSQL constraints may use reviewed custom SQL migrations; `drizzle-kit push` is not used.

## External Blockers

- Feature 02 must choose the database-enforced exactly-one-active-owner mechanism across campaign
  and membership rows and prove it under the selected transaction isolation.
- Feature 03 must define the client acknowledgment/watermark condition that makes membership
  tombstone purge safe. Feature 01 retains those tombstones indefinitely until then.
