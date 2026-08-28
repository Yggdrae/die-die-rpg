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

## Goals

- A GM creates an account and reaches campaign creation without friction, inside the 10 minute
  activation budget (`PRD.md` s.78).
- A player joins a campaign from an invitation and receives exactly one role.
- Any feature can resolve `ActorRef` for a request without knowing how authentication works.
- The model admits an external identity provider later without a data migration (`PRD.md` s.59).

## Non-Goals

- External identity providers, social login, SSO. The model stays compatible; nothing is built.
- Multi-factor authentication.
- Organizations, teams, or user groups above the campaign.
- Permission evaluation. This feature returns the role; feature 04 decides what a role may do.
- Player profiles, avatars, or social features.

## Users and Context

### Primary user

A game master creating an account, then inviting players to a campaign they own.

### Secondary users

A player receiving an invitation link, often minutes before a session starts, often on a phone.

## User Stories

- As a GM, I want to create an account with an email and a password, so that I can own campaigns.
- As a GM, I want to invite players with a link, so that nobody has to create an account before
  I can plan a session.
- As a GM, I want to assign a role when inviting, so that an assistant GM and a player do not
  get the same access.
- As a player, I want to accept an invitation and land in the campaign, so that joining is one step.
- As a GM, I want to remove a member, so that a player who leaves the table loses access.
- As a user, I want to recover access to my account, so that a forgotten password does not cost
  me my campaigns.

## Functional Requirements

### P0 — MVP

- FR-001: Account creation with email and password. Email uniqueness enforced server-side.
- FR-002: Login and logout. Server-issued session credential with expiry and revocation.
- FR-003: Password recovery through a single-use, expiring token sent to the registered email.
- FR-004: Campaign membership record binding a user to a campaign with exactly one MVP role:
  `owner`, `gm`, `assistant_gm`, or `player`. The shared `observer` value is reserved for later.
- FR-005: The campaign creator becomes `owner`. A campaign always has exactly one `owner`.
- FR-006: Invitation tokens: created by `owner` or `gm`, carry the target role, are single-use,
  expire, and can be revoked before use.
- FR-007: Accepting an invitation while logged out routes through account creation or login and
  then completes the join, without losing the invitation.
- FR-008: Membership listing for a campaign, and campaign listing for a user.
- FR-009: Membership removal by `owner` or `gm`. Removing a member revokes campaign access
  immediately, including on the sync layer (`PRD.md` s.60).
- FR-010: Role change by `owner`. Ownership transfer is `owner` only.
- FR-011: A published module API that resolves `ActorRef` for a user and campaign, consumed by
  every other feature. This is the only supported way to learn a role.

### P1 — Important

- FR-101: Session listing and remote sign-out for a user.
- FR-102: Email change with confirmation on both addresses.
- FR-103: Invitation by email address rather than link only.

### P2 — Later

- FR-201: External identity provider integration (`PRD.md` s.59).
- FR-202: Multi-factor authentication.

## Behavioral Constraints

- Authorization decisions happen server-side (`PRD.md` s.60). A client-supplied role is never trusted.
- Membership is the only source of campaign access. No feature grants access by any other means.
- An invitation token grants membership in one campaign with one role and nothing else.
- Revoked or expired credentials must fail closed.
- Role resolution must work offline for an already-synced campaign, because a session must not
  stop when the network does (`PRD.md` s.5.3, s.76). The locally cached role is a read cache;
  the server remains authoritative and a revocation applied on reconnect wins.
- Removing a member must not delete content that member authored.

## Data and Privacy Considerations

- Email addresses are personal data. Store only what login and recovery require.
- Passwords are stored only as a salted hash from a current password-hashing algorithm.
  Never logged, never returned, never exported by feature 07.
- Recovery and invitation tokens are stored hashed, are single-use, and expire.
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
| Email delivery not available in development | Recovery and invitation flows untestable | Local mail capture in the development stack; link surfaced in logs |

## ADR Candidates

- Session credential strategy: server-side opaque sessions versus stateless tokens, given that
  revocation must reach the sync layer immediately (`PRD.md` s.60).
- Single-role membership versus multi-role, given `assistant_gm` exists.

## Open Questions

- TODO: Transactional email provider for recovery and invitations. Not decided anywhere in the
  repository. Development can proceed with local mail capture.
- `observer` is deferred beyond MVP. Its shared contract value remains reserved for forward
  compatibility and cannot be assigned to an MVP membership.
- TODO: Account deletion and data retention policy.
