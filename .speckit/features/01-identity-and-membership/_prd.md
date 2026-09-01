# PRD: Identity and Membership

Source: `PRD.md` s.6, s.59, s.60, s.69, s.87 Test 1, s.88.
Track: A. Depends on: contracts from feature 00 only.

## Problem

Nothing in the platform can be authorized until the platform knows who is acting and what they
are to a given campaign. The source PRD spreads this across authentication (s.59), authorization
roles (s.60), and the join flow (s.69, s.87). Those are one ownership boundary: identity and the
membership edge between a user and a campaign.

Every other feature needs the answer to "who is this, and what role do they hold here" and none
of them should compute it.

The initial deployment is a private, self-hosted instance run on a trusted machine for a known
table. Core account access and recovery must not depend on a public email service, domain, or
paid external infrastructure.

## Goals

- A GM creates an account and reaches campaign creation without friction, inside the 10 minute
  activation budget (`PRD.md` s.78).
- Account creation, invitation, and recovery work without configured email delivery.
- A player joins a campaign from an invitation and receives exactly one role.
- Any feature can resolve `ActorRef` for a request without knowing how authentication works.
- The model admits an external identity provider later without a data migration (`PRD.md` s.59).

## Non-Goals

- External identity providers, social login, SSO. The model stays compatible; nothing is built.
- Multi-factor authentication.
- Organizations, teams, or user groups above the campaign.
- Permission evaluation. This feature returns the role; feature 04 decides what a role may do.
- Player profiles, avatars, or social features.
- Mandatory email addresses or a built-in public mail server.

## Users and Context

### Primary user

A game master creating an account, then inviting players to a campaign they own.

The instance operator who controls the trusted host and can issue account-recovery tokens. This
is an installation-level responsibility, not a campaign role.

### Secondary users

A player receiving an invitation link, often minutes before a session starts, often on a phone.

## User Stories

- As a GM, I want to create an account with a username and password, so that I can own campaigns
  without configuring email delivery.
- As a GM, I want to invite players with a link, so that nobody has to create an account before
  I can plan a session.
- As a GM, I want to assign a role when inviting, so that an assistant GM and a player do not
  get the same access.
- As a player, I want to accept an invitation and land in the campaign, so that joining is one step.
- As a GM, I want to remove a member, so that a player who leaves the table loses access.
- As a user, I want to recover access to my account, so that a forgotten password does not cost
  me my campaigns.
- As an instance operator, I want to issue a recovery token without choosing the user's new
  password, so that I can restore access without learning credentials.

## Functional Requirements

### P0 — MVP

- FR-001: Account creation with username and password. Usernames are 3-32 ASCII characters, start
  with an ASCII letter or digit, and otherwise contain only ASCII letters, digits, `_`, or `-`.
  Leading/trailing ASCII whitespace is removed and uniqueness is case-insensitive within the
  instance.
- FR-002: Login and logout. Server-issued session credentials have a 30-day absolute lifetime,
  no P0 idle timeout, and immediate revocation on logout.
- FR-003: Password recovery through a single-use, expiring token issued by an instance operator
  with trusted access to the host. The operator delivers the token out of band and cannot choose
  or learn the new password. Campaign roles grant no recovery authority. The token expires after
  30 minutes; successful recovery revokes every existing session and requires a fresh login.
- FR-004: Campaign membership record binding a user to a campaign with exactly one MVP role:
  `owner`, `gm`, `assistant_gm`, or `player`. The shared `observer` value is reserved for later.
- FR-005: The campaign creator becomes `owner`. A campaign always has exactly one `owner`.
- FR-006: Invitation tokens: created by `owner` or `gm`, carry the target role, are single-use,
  and can be revoked before use by any current `owner` or `gm`. Invitations default to seven days
  and may be configured from five minutes through 30 days.
- FR-007: Accepting an invitation while logged out routes through account creation or login and
  then completes the join, without losing the invitation.
- FR-008: Membership listing for a campaign, and campaign listing for a user.
- FR-009: Membership removal by `owner` or `gm`. A `gm` cannot remove another `gm`; only the
  `owner` can do that. Removing a member revokes campaign access immediately, including on the
  sync layer (`PRD.md` s.60). A `gm` may remove their own membership; the sole `owner` may not.
- FR-010: Role change by `owner`. Ownership transfer is `owner` only, targets a current member,
  and demotes the former owner to `gm` atomically.
- FR-011: A published module API that resolves `ActorRef` for a user and campaign, consumed by
  every other feature. This is the only supported way to learn a role.

### P1 — Important

- FR-101: Session listing and remote sign-out for a user.
- FR-102: Optional email address addition, change, and verification when an outbound email
  provider is configured. Email is not an account identifier and is not required for recovery.
- FR-103: Invitation by email address when an outbound email provider is configured.

### P2 — Later

- FR-201: External identity provider integration (`PRD.md` s.59).
- FR-202: Multi-factor authentication.

## Behavioral Constraints

- Authorization decisions happen server-side (`PRD.md` s.60). A client-supplied role is never trusted.
- Membership is the only source of campaign access. No feature grants access by any other means.
- An invitation token grants membership in one campaign with one role and nothing else.
- Revoked or expired credentials must fail closed.
- Instance-operation authority is separate from campaign membership. An `owner` or `gm` cannot
  issue account-recovery tokens unless that person also has trusted host access.
- The default deployment has no outbound email dependency. Invitation and recovery links or
  codes can be delivered through a channel chosen by the people at the table.
- Public invitation preview shows only the campaign display name, target role, and expiry. It
  never reveals inviter identity, membership, or whether an unusable token was unknown, expired,
  revoked, or already used.
- Account deletion is unavailable in P0. Account, identity-binding, and current credential rows
  are retained; membership removal does not imply account deletion.
- Role resolution must work offline for an already-synced campaign, because a session must not
  stop when the network does (`PRD.md` s.5.3, s.76). The locally cached role is a read cache;
  the server remains authoritative and a revocation applied on reconnect wins.
- Removing a member must not delete content that member authored.

## Data and Privacy Considerations

- Usernames are instance-local identifiers. Optional email addresses are personal data and are
  stored only when the user enables an email-dependent P1 flow.
- Passwords are stored only as a salted hash from a current password-hashing algorithm.
  Never logged, never returned, never exported by feature 07.
- Passwords contain 15-128 Unicode code points and no more than 512 UTF-8 bytes. They are used
  exactly as entered, without trimming or Unicode normalization.
- Recovery and invitation tokens are stored hashed, are single-use, expire, and are never logged
  in plaintext after issuance.
- Membership changes emit `AuditEvent` records (feature 06). Authentication failures are logged
  without credential material.
- Feature 07 export must exclude credentials, tokens, and sessions. Only membership and display
  identity are exportable.

## Success Signals

- Account creation to first campaign screen completes in under 2 minutes, keeping the 10 minute
  activation budget reachable (`PRD.md` s.78).
- Invitation link to joined campaign completes in under 1 minute for a new user.
- `PRD.md` s.87 Test 1 passes: GM creates a campaign, players join by invitation, memberships,
  roles, and permissions resolve, initial synchronization succeeds.
- Zero instances of a feature reading membership tables directly, verified by the guard in
  feature 00 FR-009.

## Rollout

Wave 1, Track A. Ships before any feature needs a real role, and other features run against
the fixture actor set until then. No migration concerns; this is the first persisted feature.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Offline role cache diverges from a server revocation | A removed member keeps reading a cached campaign | Server authoritative on reconnect; feature 03 drops the local database for a campaign when membership is revoked |
| Invitation link leaked or forwarded | Unintended person joins the campaign | Single-use, expiring, revocable tokens; GM sees who accepted |
| Rolling a custom auth implementation | Security defects in a non-differentiating area | Use a well-established hashing and session approach; keep the boundary thin so an external provider can replace it |
| Host access is compromised | An attacker can issue account-recovery tokens | Restrict recovery issuance to trusted local administration; tokens are short-lived, single-use, hashed at rest, and audited |
| Operator is unavailable | A user cannot recover a forgotten password immediately | Users retain active sessions; the private table coordinates recovery with the trusted host operator |
| Optional email provider is unavailable | Email invitations and notifications fail | Core signup, link invitations, login, and operator-assisted recovery remain available |

## ADR Candidates

- Session credential strategy: server-side opaque sessions versus stateless tokens, given that
  revocation must reach the sync layer immediately (`PRD.md` s.60).
- Single-role membership versus multi-role, given `assistant_gm` exists.

## Open Questions

- Optional outbound email has no selected provider and is not required for MVP. Development may
  use local mail capture for P1 email-flow testing.
- `observer` is deferred beyond MVP. Its shared contract value remains reserved for forward
  compatibility and cannot be assigned to an MVP membership.
- Feature 02 must select the database-enforced mechanism that guarantees exactly one active owner
  for every committed campaign.
- Feature 03 must define membership-tombstone acknowledgment and purge safety. Feature 01 retains
  tombstones indefinitely until that decision exists.
