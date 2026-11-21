# Task 13: Architecture Guard and P0 Acceptance Suite

Status: completed. Guard, Playwright, security regression, concurrency audit, and traceability are done. Every P0 scenario is automated against the real authority or the device reconciler. The only leg not exercised is the PowerSync service delivering rows to a device, which is a feature 03 task 04 criterion (see PRD test 1).

## Goal

Prove the P0 feature against its BDD, security boundaries, cross-feature contracts, and repository
gates.

## Dependencies

- Tasks 07, 10, 11, and 12 (all completed; feature 03 tasks 01/04/07 and feature 06 tasks 01/02 delivered the revocation contract, membership stream, reconciler, and durable audit)

## Scope

### Change

- Extend `tools/guard` to reject direct membership-store imports outside feature 01 and
  client-supplied campaign roles.
- Add Playwright coverage for signup to campaign creation, login/logout, logged-out invitation
  through authentication, invitation revocation, member removal, and recovery consumption.
- Add/complete PostgreSQL concurrency coverage for username, invitation, recovery, ownership, and
  removal transitions.
- Add security regression coverage for cookie/origin/rate-limit behavior and raw-secret absence
  from browser responses and captured logs.
- Map every P0 BDD scenario to an automated test or a named integration assertion.

### Do Not Change

- No generic final test rewrite, P1 behavior, unrelated refactor, or weakening/skipping of P0
  scenarios.

## Acceptance Criteria

- [x] Every P0 BDD scenario is automated and traceable (table below; no BLOCKED or partial rows).
- [x] PRD test 1 passes through initial synchronization, at the strongest level available without the PowerSync service: bootstrap tokens plus device replica initialisation through the real reconciler (see PRD test 1). The provider-level leg is tracked by feature 03 task 04.
- [x] Architecture guard proves `ActorResolver` is the only supported role-read path.
- [x] PostgreSQL races have exactly one valid winner and no partial writes.
- [x] Full repository gates and identity E2E pass from a clean migrated database.

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
bun run test:e2e
```

`bun run test:e2e` is the repository Playwright command (`playwright.config.ts`, Edge channel, Vite
dev server on 4173, API mocked at the network edge). PostgreSQL-backed acceptance runs under
`bun test` through `buildRuntimeApp` and needs `DATABASE_URL` (or `TEST_DATABASE_URL`) with
`bun run db:migrate` applied; it skips when no database is reachable.

## Progress

Evidence from the last run (this task, 2026-10-24), including a freshly created and migrated
database for `bun test`:

| Gate | Result |
| --- | --- |
| `bun run check` | pass (177 files) |
| `bun run typecheck` | pass (all workspaces) |
| `bun test` | 454 pass, 0 fail (also on a clean database migrated from empty) |
| `bun run guard` | pass (146 files) |
| `bun run build` | pass |
| `bun run test:e2e` | 18 pass (7 new in `identity-p0.e2e.ts`) |

### Guard ("Feature 01" section of `tools/guard/src/rules.ts`)

- `no-membership-store-imports`: outside `packages/identity`, rejects imports of identity `infra/`
  or `schema` modules (package subpath or relative `src/` path, static, dynamic, `require`,
  re-export) and imports of the membership-store symbols `PostgresMembershipRepository`,
  `PostgresInvitationRepository`, `identityCampaignMemberships`, `identityInvitations`,
  `identitySchema` through any path, including the `@rpg/identity` entry point and integration
  tests. The narrow `PostgresCampaignMembershipWriter` (feature 02 creation boundary) is allowed.
- `no-client-supplied-role-authority`: in `apps/` and non-identity `packages/`, rejects role
  headers (`headers['x-...role']`, `headers.campaignRole`, any `'x-...role'` literal, so web code
  sending one fails too), actor-role names read from `request.body/query/params/headers`,
  `role` read from headers or query, destructuring of those, and actors assembled from request
  input (`role: request.body.x`). A body `role` or `targetRole` is a validated target, not an
  actor, and is allowed. Test files are exempt (they forge claims to prove they are ignored).
- `no-client-actor-role-claims` (existing, feature 02 section) now exempts test files for the same
  reason; production files still fail.
- Together with `no-external-membership-store-access` (raw SQL), these leave `ActorResolver` as the
  only role-read path. `rules.test.ts` proves each unsupported path fails against a negative fixture
  and the supported path (`actors.resolve(userId, campaignId)`) passes ("ActorResolver is the only
  supported role-read path"). 35 new guard tests.

### New tests

- `apps/api/src/identity-p0.integration.test.ts`: 13 tests, real runtime plus PostgreSQL through
  `buildRuntimeApp` (it gained an optional `logger` input so tests can capture log lines).
  Records every response and log line and asserts that no password, session credential,
  invitation token, or recovery token appears outside its one intended carrier (session credential:
  `Set-Cookie` of signup/login; invitation token: the issuance response body; recovery token:
  operator stdout only).
- `apps/web/e2e/identity-p0.e2e.ts`: 7 tests (login/logout, logged-out invitation through failed
  login then account creation, generic unusable invitation, invitation revocation, member removal
  and role change, GM removal limits, recovery consumption). Signup to campaign creation and the
  login-path invitation remain in `identity-campaign.e2e.ts`. Every test asserts the client sends no
  role claim.
- Guard: 35 tests as above. No production behavior changed besides the `buildRuntimeApp` logger
  option.

### PostgreSQL concurrency audit

Existing coverage was audited first; nothing at repository level was missing, so none was
duplicated. Each race asserts one winner, the loser's error, and the absence of partial rows.

| Transition | Existing test |
| --- | --- |
| Username (normalized duplicate) | `repositories.integration.test.ts`: concurrent normalized-username inserts produce one complete account (one user, binding, credential, session) |
| Invitation | `invitation.integration.test.ts` concurrency: six acceptors, tombstone reactivation, one user two invitations, revoke vs accept |
| Recovery | `repositories.integration.test.ts`: recovery has exactly one concurrent consumer (winner password applied, sessions revoked, `used_at` set) |
| Ownership | `ownership.integration.test.ts`: concurrent creation, concurrent transfers, transfer vs target removal |
| Removal / role | `membership-admin.integration.test.ts` concurrency: concurrent removals, GM self-removal vs owner removal, demotion vs removal, promotion vs removal, transfer vs removal, concurrent role changes |

Added at the HTTP layer only: concurrent recovery consumption through `POST /auth/recovery/consume`
(`identity-p0`: operator recovery) returns exactly `204` and `404`, exactly one password works, and
two tokens end up used.

### Security regression

Cookie flags (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Expires` equal to the session expiry, `Secure`
only in production), digest-only credential storage, origin check on every mutating authenticated
route (missing, foreign, and downgraded-scheme origins all `403` with state unchanged), rate limits
(login, account creation, recovery consume: per client address, fail closed, no account-existence
oracle, a limited valid recovery token is not spent), generic login failure, and raw-secret absence
from responses and captured logs: `identity-p0` tests "cookie policy", "mutations require a
same-origin request", "rate limiting", "session lifecycle", and "no raw secret reached ...".

## BDD traceability (P0)

Keys. `IP` = `apps/api/src/identity-p0.integration.test.ts` (test names abbreviated: prd1, logged-out,
unusable, admin, recovery, policy, no-delete, claims, session, origin, cookie, rate-limit, secrets).
`E2E` = `apps/web/e2e/identity-p0.e2e.ts`; `E2E-A` = `identity-campaign.e2e.ts`. `INV`, `ADM`, `OWN`,
`REPO` = `packages/identity/src/infra/postgres/{invitation,membership-admin,ownership,repositories}.integration.test.ts`.
`ACC`, `RCV`, `MS`, `INS` = `packages/identity/src/application/{account-session-service,recovery-service,membership-service,invitation-service}.test.ts`.
`DOM` = `packages/identity/src/domain/*.test.ts` (password, username, roles, token-lifecycle,
membership-cache). `SCH` = `contracts/schemas.test.ts`. `CLI` = `apps/api/src/modules/identity/operator-cli.test.ts`.
`REV` = `apps/api/src/membership-revocation.integration.test.ts`. `SYNC` = `apps/api/src/modules/sync/routes.test.ts`.
`GUARD` = `tools/guard/src/rules.test.ts`.

Status: **ok** = automated. Additional keys: `MR` = `apps/api/src/modules/sync/membership-reconciler.test.ts`; `RV` = `packages/sync/src/revocation.test.ts`; `AR` = `apps/api/src/audit-runtime.integration.test.ts`; `AC` = `apps/api/src/modules/audit/composition.test.ts`.

| Scenario | Status | Covered by |
| --- | --- | --- |
| Create an account with a unique username | ok | ACC atomic account session; REPO account creation uses opaque credentials; IP prd1, cookie, policy; E2E-A signup |
| Reject a username already registered | ok | REPO concurrent normalized-username inserts; IP policy (`  name  ` and upper-case variants: 409, one user, one session) |
| Reject a username outside the P0 policy (5 rows) | ok | DOM username; SCH; ACC rejects invalid input before hashing; IP policy (all 5 usernames: 400, no account/session) |
| Enforce the P0 password boundaries (4 rows) | ok | DOM password; SCH code-point boundaries; IP policy (14/15/128 four-byte/129 over HTTP; 128 points is 512 bytes) |
| Preserve password input exactly | ok | DOM password does not trim or normalize; IP policy (leading space; NFC vs NFD login) |
| Log in with valid credentials | ok | ACC rehashes only after valid login; REPO account creation, login, authentication, logout; IP session, cookie; E2E login |
| Reject invalid login credentials | ok | ACC one generic invalid-login result; IP session (wrong password equals unknown user, no cookie, failure logged without password); E2E-A generic failure |
| Log out | ok | ACC logout revocation idempotent; REPO; IP session (origin-checked, revokes only that credential); E2E login/logout |
| Reject an expired or revoked session | ok | REPO active lookup excludes revoked and expired; IP session (expired and revoked cookies: 401) |
| Session expiry uses an exclusive boundary | ok | REPO active lookup excludes the exact expiry instant; DOM token-lifecycle |
| Instance operator issues a recovery token | ok | RCV issue; CLI stdout once, safe stderr; IP recovery (operator CLI, no password flag, token only on stdout); AR "membership, campaign, and recovery events are durably recorded" (`recovery.issued` row in `audit_account_events` with operator reference, no token in stderr) |
| Campaign authority does not grant recovery authority | ok | CLI needs trusted database access; IP recovery (owner and anonymous: no HTTP issuance surface, no token rows) |
| Recover an account with an operator-issued token | ok | REPO recovery; RCV validates before consuming; IP recovery (password changed, all earlier sessions revoked, no cookie, login required); E2E recovery |
| Recovery expiry uses an exclusive boundary | ok | DOM token-lifecycle; REPO expired state is expiry equal to now; IP recovery (aged token) |
| Reject an unusable recovery token (4 rows) | ok | REPO all states; RCV; IP recovery (expired, revoked, used, unknown: same 404 body, password unchanged) |
| A recovery token cannot be consumed twice | ok | REPO exactly one concurrent consumer; IP recovery (HTTP race: 204 and 404) |
| Campaign creator becomes the sole owner | ok | OWN campaign rows and initial owner commit together, concurrent creations; IP prd1 |
| A membership has exactly one MVP role | ok | DOM roles; SCH rejects observer; OWN observer not persistable; IP prd1 |
| List campaign members | ok | ADM campaign list, pagination; IP prd1, admin |
| List a user's campaigns | ok | ADM self-only list omits removals; IP prd1, logged-out, admin |
| An authorized inviter creates an invitation (owner, gm) | ok | INV owner/gm issuance; IP admin (promoted gm invites) |
| Reject invitation creation by any other role | ok | INV assistant_gm, player, non-member, removed gm; IP admin (demoted gm), claims |
| Reject an invitation for the reserved observer role | ok | INV observer and owner targets; SCH; IP claims (HTTP 400) |
| Reject an invitation that would create another owner | ok | INV owner target creates nothing and keeps one owner; IP claims (HTTP 400) |
| A logged-in user accepts an invitation | ok | INV logged-in non-member joins; INS; IP prd1 |
| Preview a usable invitation without authentication | ok | INV usable preview; SCH preview fields; IP logged-out (exact keys, no campaign id or inviter) |
| Preview an unusable invitation generically (4 rows) | ok | INV every unusable state previews the same; IP unusable (identical 404 body); E2E unusable |
| Invitation expiry uses an exclusive boundary | ok | DOM token-lifecycle; INV expired fails closed (expiry equal to now); lifetime bounds 5 minutes to 30 days |
| A logged-out user retains the invitation through authentication | ok | INV keeps invitation pending through account creation; IP logged-out (signup path and login path); E2E, E2E-A |
| Reject an unusable invitation (4 rows) | ok | INV each state fails closed; IP unusable |
| An invitation cannot be consumed twice | ok | INV six concurrent acceptors, reactivation, double invitation |
| Revoke an unused invitation | ok | INV revoke regardless of creator, revoke vs accept; IP unusable (gm revokes owner's); E2E revocation |
| An invitation grants nothing outside its campaign and role | ok | INV; IP logged-out (one campaign, one role) |
| Remove a lower-authority member (5 rows) | ok | ADM removal matrix (5 rows: access ends, content stays, audit, signal after commit); IP admin (owner/gm HTTP removal; every server path denies, `REV`: bootstrap and upload); REV "default durable publisher records delivery and revokes the removed member subscriptions"; device cleanup: MR "tombstone purges the replica and pending work; stale versions never restore access", RV "tombstone on reconnect drops campaign data and pending work and emits ReplicaPurged"; E2E; audit AR |
| A GM cannot remove another GM | ok | ADM; IP admin; E2E GM limits |
| A GM removes themselves | ok | ADM; IP admin (loses campaign and bootstrap access, owner unchanged); device loss: MR tombstone purge, RV "tombstone on reconnect...", REV default durable publisher |
| Reject member removal by any other role | ok | ADM; IP admin |
| The sole owner cannot be removed | ok | OWN, ADM; IP admin (409, one owner) |
| Owner changes a non-owner role | ok | ADM role change; REV role change authoritative with failing delivery; IP admin (version 2, audit, effective on next request); device uses the new role: MR "higher server version replaces the cached role; equal or lower is kept", RV "higher version replaces the cached role; stale delivery is kept" |
| Reject role change by a non-owner | ok | ADM; IP admin |
| Reject assigning the reserved observer role | ok | ADM; SCH; IP admin (HTTP 400 for observer and owner) |
| Reject ownership transfer by a non-owner | ok | OWN only current owner transfers; IP admin |
| Transfer ownership atomically | ok | OWN concurrent transfers, transfer vs removal; ADM versions bumped, both signalled; IP admin (former owner becomes gm, audit) |
| Account deletion is unavailable in P0 | ok | IP no-delete (five candidate operations: 404, account intact); removal remains the access control (ADM, IP admin) |
| Resolve an actor from authoritative membership | ok | OWN ActorResolver tests, client-supplied role claims cannot affect resolution; MS; IP claims (forged headers/body/query ignored); GUARD |
| Fail actor resolution without membership | ok | OWN absent and removed return membership_not_found; MS; IP prd1 (outsider 404) |
| Resolve a cached role while offline | ok | DOM membership-cache; MS cache mapping; MR (identity's `reconcileMembershipCache`/`toMembershipCacheRow` drive the device reconciler; role resolves via `access.actor` from the cache; only approved fields cached: "only approved cache fields reach the device"); RV; IP prd1 device leg (real stream-shaped rows resolve owner/gm/player roles offline, non-member resolves nothing) |
| Server revocation wins after reconnect | ok | DOM tombstone removes cached access; server: REV removed member denied on read, sync bootstrap, upload; device: MR tombstone purges replica and pending work, stale lower versions never restore access, rejoin needs a higher version; RV "absence from a complete set revokes only authority-confirmed campaigns", "confirmed campaign deletion and sign-out clean up locally"; real-authority round trip in `offline-campaign.integration.test.ts` "membership revocation removes local context and the authority refuses the stale edit" |

P1 scenarios in `_bdd.md` (sessions list, remote sign-out, verified email, no-email core flows, email
invitation) are out of scope and untouched.

### PRD test 1 and the provider-level leg

PRD test 1 ("initial synchronization succeeds"). Automated in `IP prd1` (`apps/api/src/identity-p0.integration.test.ts`, real runtime + PostgreSQL): GM creates a campaign, players and GM join by invitation, memberships and roles resolve, each member's `GET /sync/bootstrap/:id` returns a short-lived token bound to that user and campaign, a non-member and anonymous caller get nothing. Added: each member's own membership rows, read from PostgreSQL in the shape of the `current_user_memberships` stream, initialise a fresh SQLite replica through the real `ReplicaAccessReconciler` with identity's reconcile rule, and the role resolves from the cache (owner, gm, player); the outsider's replica resolves nothing.

Judgment on criterion 2: satisfied for feature 01. Feature 01 owns membership truth, bootstrap authorization, the cache row mapping and the reconcile rule, and every one of those is exercised end to end against the real authority and the real device reconciler. What is not exercised is the PowerSync service itself downloading those rows into browser SQLite (stream definition applied by a running service, least-privilege publication as seen by the service). That leg is owned by feature 03 task 04 and cannot fail for feature 01 reasons: the stream selects the same `identity_campaign_memberships` columns the test reads, and the reconciler rejects foreign or unapproved fields. If feature 03 task 04's provider round trip later fails, it reopens that task, not this one.

## Notes and limits

- Playwright specs mock the API at the network edge by repository convention, so real cookie and
  `Origin` behavior in a browser is not exercised there. The real-stack equivalents are the
  `IP` tests, which drive the Fastify app over HTTP and PostgreSQL via `app.inject`.
- Not found by this task: any defect in production identity code. The only existing-code change
  besides the guard was making `buildRuntimeApp` accept an optional log stream.
