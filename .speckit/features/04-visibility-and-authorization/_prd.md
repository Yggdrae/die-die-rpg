# PRD: Visibility and Authorization

Source: `PRD.md` s.34, s.37, s.60, s.75, s.87 Tests 2, 3.
Track: A. Depends on: `ActorRef` and `Role` from feature 01, `Visibility` contract from feature 00,
enforcement point in feature 03.

## Problem

A tabletop application is unusual: most of its content is deliberately hidden from most of its
users, and the hiding is the product. A secret the players can read in a network response is not
a secret. `PRD.md` s.34 states the rule and the failure mode together: enforce in the backend and
the sync layer, never only in the interface.

Nineteen features need visibility. If each implements its own check, the platform has nineteen
chances to leak a GM-only record, and no single place to test.

## Goals

- One authorization decision point for role-based permissions and content visibility.
- A GM can hide any content and reveal it deliberately, with confidence it was never on the
  player device before the reveal.
- Any feature applies visibility by declaring it, not by implementing it.
- Visibility is testable in isolation: given an actor and a record, the decision is a pure function.

## Non-Goals

- Authentication and membership. Feature 01 owns them.
- The reveal user experience for handouts. Feature 17 owns it and calls this feature.
- Sync transport. Feature 03 owns it and enforces the rules this feature defines.
- Field-level permissions inside a character sheet beyond owner and GM. Feature 15 owns editability
  of its own fields and defers the coarse decision here.
- Fine-grained custom roles or per-feature permission editors (`PRD.md` s.72 lists advanced
  permissions as V2).

## Users and Context

### Primary user

The GM, who decides what exists and what is known. Visibility is a preparation tool as much as a
security control.

### Secondary users

Players, who must never receive hidden content, and developers, who must not be able to leak it
by accident.

## User Stories

- As a GM, I want content to default to GM-only, so that a half-written secret is never exposed
  by forgetting a setting.
- As a GM, I want to reveal content to the whole table or to specific players, so that partial
  knowledge is possible (`PRD.md` s.37).
- As a GM, I want an assistant GM to see preparation material, so that co-running a table works.
- As a player, I want to see only what I have been given, so that the game is not spoiled by the tool.
- As a developer, I want a single call to decide access, so that I do not invent my own rule.

## Functional Requirements

### P0 — MVP

- FR-001: Role to permission mapping for the four MVP roles: `owner`, `gm`, `assistant_gm`, and
  `player`. The reserved `observer` role fails closed until its post-MVP permissions are defined. Permissions are declared as capability verbs
  (read, create, update, delete, reveal, manage members) per resource class.
- FR-002: Content visibility levels per `PRD.md` s.34: GM only, everyone, specific party,
  specific players.
- FR-003: A pure decision function taking `ActorRef`, resource class, and record visibility, and
  returning an allow or deny with a reason. No input from a request object.
- FR-004: Server-side enforcement on every API route touching campaign content. A route without
  an authorization decision fails review.
- FR-005: Sync rule definitions per resource class, consumed by feature 03, so a client never
  receives records it cannot see (`PRD.md` s.34, s.60).
- FR-006: Default visibility per resource class, GM-only for anything a GM authors as preparation.
- FR-007: Visibility change API, including reveal to named players, emitting an `AuditEvent`
  (feature 06).
- FR-008: A published module API so any feature applies the decision without reimplementing it.
- FR-009: Denials return the consistent `ApiError` shape from feature 00 and do not reveal whether
  the hidden record exists.
- FR-010: Test kit: a shared matrix test that every content-owning feature runs against its own
  resource class, so coverage is uniform rather than per-developer discretion.

### P1 — Important

- FR-101: Party grouping, so visibility can target a party rather than a player list
  (`PRD.md` s.34 lists specific party).
- FR-102: Bulk visibility change across selected content.
- FR-103: A GM preview mode showing what a specific player currently sees.

### P2 — Later

- FR-201: Advanced and custom permissions (`PRD.md` s.72).
- FR-202: Knowledge-level visibility, where a world truth and a player belief differ per player
  (`PRD.md` s.37, deferred with the knowledge graph).

## Behavioral Constraints

- Authorization is server-side (`PRD.md` s.60). A client-side filter is presentation, never control.
- Sync rules and API authorization must agree. A divergence is a leak, so both derive from the
  same declaration rather than being written twice.
- Fail closed. An unknown resource class, an unknown role, or a missing visibility value denies.
- Hidden content must not be inferable from response shape, error text, counts, or identifier gaps.
- Revealing is additive and audited. Un-revealing is possible but does not un-know; the audit log
  records both.
- A visibility decision must be evaluable offline against locally cached data, and the local cache
  must only ever contain what the actor was already allowed to receive.

## Data and Privacy Considerations

- This feature is the control that makes every other feature safe to store locally, because
  feature 03 puts synchronized data on the user device permanently.
- Visibility grants naming specific players are personal-data-adjacent and belong to the campaign.
- Denial events are logged for the GM at a summary level; they must not become a surveillance log
  of player behaviour.
- Export in feature 07 must carry visibility with the content, or an export round trip becomes a leak.

## Success Signals

- `PRD.md` s.87 Test 3: reveal to player A gives player A the handout and gives player B nothing,
  verified in the network payload and in the player local database, not only in the interface.
- `PRD.md` s.87 Test 2: a player without permission cannot change another character resource,
  rejected server-side.
- Zero GM-only rows present in a player local database across the validation campaign.
- Every content-owning feature passes the shared matrix test from FR-010.

## Rollout

Wave 2, Track A, alongside campaign lifecycle. Features built earlier declare visibility on their
records from the start, because feature 00 froze the `Visibility` field, and switch to real
enforcement when this feature ships. Enforcement must land before any external validation session,
since a leak during play cannot be undone.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| API rules and sync rules drift apart | Content leaks through the sync path while the API looks correct | Single declaration source for both; a test asserts equivalence per resource class |
| Feature authors add their own ad hoc checks | Inconsistent, untestable, unauditable access control | Published module API is the only sanctioned path; architecture guard from feature 00 FR-009 |
| Default visibility set to everyone for convenience | A GM secret exposed by omission | GM-only default for authored preparation content (FR-006); default asserted by test |
| Observer role semantics undefined | Ambiguous access for a role nobody specified | Treated as read-only on everyone-visible content until a concrete need appears |
| Performance of per-record decisions on large campaigns | Slow lists, s.79 regression | Decision is pure and cheap; sync rules filter in the database, not per record in application code |

## ADR Candidates

- Single declarative source generating both API authorization and sync rules, versus maintaining
  them separately. The failure mode of the alternative is a silent leak, which makes it worth recording.

## Open Questions

- TODO: Exact permission verbs per resource class. Depends on the resource classes features
  15 to 19 register; the matrix is filled as they land.
- `observer` is deferred beyond MVP and has no MVP capabilities.
- TODO: Whether party is a first-class grouping in MVP or specific-players only, given
  `PRD.md` s.34 lists both.
- TODO: Whether un-reveal is supported in MVP, and what it means for data already on a player device.
