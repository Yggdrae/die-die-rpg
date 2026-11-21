# BDD: Visibility and Authorization

Source: `_prd.md`, `../00-platform-foundation/freeze-decisions.md`,
`packages/contracts/src/{visibility,actor,error,entity,audit}.ts`,
`../01-identity-and-membership/_bdd.md`, `../03-offline-sync-platform/_bdd.md`.

Three settled facts the scenarios below assume, rather than re-deciding:

- `Visibility` is a frozen discriminated union: `gm_only`, `everyone`, `party` with a non-empty
  `partyIds`, `players` with a non-empty `playerIds`. A targeted grant with nobody in it is not
  representable.
- `ActorRef` is `{ userId, campaignId, role }`, resolved by feature 01 from authoritative
  membership and never supplied by a client.
- `observer` is deferred beyond MVP with no capabilities (`freeze-decisions.md`, feature 01 BDD).
  The PRD risk row calling it read-only on everyone-visible content is stale; FR-001 and the PRD
  open question both say it fails closed, and these scenarios follow that.

"Decision" below means one call to the published decision point, taking an actor, a resource
class, and a record's visibility. "Local database" means the synchronized copy on the device, as
in feature 03. No scenario names a sync provider or a storage engine.

---

## The Decision Point

### Scenario: A decision is an outcome plus a reason

**Given** an actor with role `gm` in campaign A  
**And** a record of a registered resource class in campaign A with visibility `gm_only`  
**When** a read decision is requested  
**Then** the result is allow  
**And** it carries a reason identifying the rule that allowed it  
**And** a denial carries a reason in the same shape

### Scenario: The decision depends on its declared inputs alone

**Given** the same actor, resource class, and record visibility  
**When** the decision is evaluated on the server and again on a device with no network  
**Then** both evaluations produce the same outcome  
**And** neither evaluation reads a request object, a header, a cookie, or a session

### Scenario: A role supplied by the client does not change the decision

**Given** an authenticated user whose resolved role in campaign A is `player`  
**When** the user submits a request whose body or headers claim role `gm`  
**Then** the decision uses the resolved role `player`  
**And** the claimed role changes no outcome

### Scenario Outline: Unusable input fails closed

**Given** a decision is requested with `<defect>`  
**When** the decision is evaluated  
**Then** the result is deny  
**And** no fallback grants access

| defect |
| --- |
| a resource class that is not registered |
| a role outside the declared set |
| role `observer` |
| a record with no visibility value |
| a `party` visibility whose party grouping cannot be resolved |
| an actor whose `campaignId` differs from the record's `campaignId` |

### Scenario: Authority does not cross campaigns

**Given** a user has role `owner` in campaign A and role `player` in campaign B  
**When** a decision is requested for a `gm_only` record in campaign B  
**Then** the result is deny  
**And** the role held in campaign A is not consulted

---

## Roles and Capabilities

### Scenario Outline: GM roles read preparation content, players do not

**Given** a record in a campaign has visibility `gm_only`  
**And** an actor has role `<role>` in that campaign  
**When** a read decision is requested  
**Then** the result is `<outcome>`

| role | outcome |
| --- | --- |
| owner | allow |
| gm | allow |
| assistant_gm | allow |
| player | deny |
| observer | deny |

### Scenario Outline: Member-management authority matches feature 01

**Given** an actor has role `<role>` in a campaign  
**When** a manage-members decision is requested for that campaign  
**Then** the result is `<outcome>`

| role | outcome |
| --- | --- |
| owner | allow |
| gm | allow |
| assistant_gm | deny |
| player | deny |

### Scenario: A player cannot change what anyone may see

**Given** an actor has role `player` in a campaign  
**When** a reveal decision is requested for any campaign content in that campaign  
**Then** the result is deny

### Scenario: A player-authored private note is not readable by a GM role

**Given** a player authored a private note in a campaign  
**And** an actor has role `gm` or `owner` in that campaign  
**When** a read decision is requested for that note  
**Then** the result is deny  
**And** the note is absent from that actor's local database

---

## Visibility Levels

### Scenario Outline: Each visibility mode decides one way

**Given** a record in a campaign has visibility `<visibility>`  
**And** `<actor>` is a current member of that campaign  
**When** a read decision is requested  
**Then** the result is `<outcome>`

| visibility | actor | outcome |
| --- | --- | --- |
| everyone | player Casey | allow |
| everyone | assistant_gm | allow |
| gm_only | player Casey | deny |
| players naming Casey | player Casey | allow |
| players naming Casey | player Rowan | deny |
| players naming Casey | gm | allow |
| party naming the Vanguard | player in the Vanguard | allow |
| party naming the Vanguard | player in no party | deny |

### Scenario: `everyone` means everyone in that campaign

**Given** a record in campaign A has visibility `everyone`  
**And** a user has no current membership in campaign A  
**When** the user requests the record  
**Then** access is denied  
**And** no actor resolves for that user in campaign A

### Scenario: A grant naming a removed member grants nothing

**Given** a record has visibility `players` naming Casey  
**And** Casey's membership in that campaign is removed  
**When** a decision is requested for Casey  
**Then** the result is deny  
**And** the stale grant does not restore access

---

## Default Visibility

### Scenario: GM-authored preparation defaults to GM-only

**Given** a GM creates a record of a resource class whose declared default is preparation content  
**When** the create request supplies no visibility  
**Then** the stored record has visibility `gm_only`  
**And** no player receives it

### Scenario: A record cannot exist without an answer to who may see it

**Given** a resource class declares no default visibility  
**When** a record of that class is created without an explicit visibility  
**Then** the create is rejected  
**And** no record is stored

---

## Changing Visibility

### Scenario: Reveal to named players grants exactly those players

**Given** a record has visibility `gm_only`  
**And** Casey and Rowan are players in the campaign  
**When** a GM reveals the record to Casey  
**Then** a read decision allows Casey  
**And** a read decision denies Rowan  
**And** GM roles still read the record

### Scenario: Revealing is additive

**Given** a record is revealed to Casey  
**When** a GM reveals the same record to Rowan  
**Then** both Casey and Rowan are allowed  
**And** Casey's access was not replaced by Rowan's

### Scenario: Repeating a reveal changes nothing

**Given** a record is revealed to Casey  
**When** a GM reveals the same record to Casey again  
**Then** the recipient list contains Casey exactly once  
**And** the effective decision for every actor is unchanged

### Scenario: Un-revealing the last recipient does not leave an empty grant

**Given** a record has visibility `players` naming only Casey  
**When** a GM removes Casey from the grant  
**Then** the stored visibility is `gm_only`  
**And** no targeted visibility with an empty recipient list is stored

### Scenario: Un-reveal removes future access without un-telling

**Given** a record was revealed to Casey and reached Casey's device  
**When** a GM un-reveals it  
**Then** a read decision denies Casey  
**And** the record is removed from Casey's local database on the next synchronization  
**And** the product makes no claim that Casey did not read it

### Scenario: Every visibility change is audited

**Given** a record has visibility `gm_only`  
**When** a GM changes it, and later changes it back  
**Then** each change emits an `AuditEvent` naming the actor, the record, and the visibility before
and after  
**And** both the reveal and the un-reveal are present in the log

### Scenario: An unauthorized visibility change leaves the record untouched

**Given** an actor has role `player` in a campaign  
**When** the actor submits a visibility change for any record  
**Then** the change is rejected  
**And** the stored visibility is unchanged  
**And** no reveal audit event is emitted

### Scenario: A grant cannot name a non-member

**Given** a user is not a current member of the campaign  
**When** a GM attempts to reveal a record to that user  
**Then** the change is rejected  
**And** the stored visibility is unchanged

### Scenario: Concurrent visibility changes do not silently drop a grant

**Given** two GM roles hold the same record at version 4  
**And** each submits a different visibility change based on version 4  
**When** both reach the server  
**Then** exactly one change is accepted  
**And** the other is reported as a version conflict  
**And** the rejected grant is not applied without the actor resubmitting it

---

## Server-Side Enforcement

### Scenario: Hiding a control is not a control

**Given** an interface offers a player no way to open a `gm_only` record  
**When** the player issues the request directly to the API  
**Then** the request is denied server-side  
**And** the denial does not depend on what the interface rendered

### Scenario: A player cannot change another member's character resource

**Given** Casey and Rowan are players with their own characters  
**When** Casey submits a change to a resource on Rowan's character  
**Then** the change is rejected server-side  
**And** Rowan's character is unchanged  
**And** Casey may still change the same resource on Casey's own character

### Scenario: A content route without a decision fails the build

**Given** an API route reads or writes campaign content  
**And** the route reaches no authorization decision on any path  
**When** the repository architecture check runs  
**Then** the check fails and names the route

### Scenario: A hidden record's attachment is not reachable through storage

**Given** a `gm_only` record has an attachment  
**When** a player requests access to that attachment  
**Then** no signed URL is issued  
**And** the denial is decided from the owning record's visibility

---

## Sync Rules and API Rules Agree

### Scenario: Both rules come from one declaration

**Given** a resource class declares its visibility rule once  
**When** the equivalence check runs for that class over every actor and visibility combination  
**Then** the API decision and the sync rule agree on every combination  
**And** a divergence fails the build

### Scenario: A GM-only record is absent from a player device

**Given** a campaign contains a `gm_only` record  
**When** a player device synchronizes that campaign  
**Then** the record is absent from that device's local database  
**And** absence is asserted against the local database and the network payload, not the interface

### Scenario: Reveal to one player delivers to that player only

**Given** a handout has visibility `gm_only`  
**And** Casey and Rowan both have the campaign synchronized  
**When** a GM reveals it to Casey  
**Then** Casey's local database contains the handout  
**And** Rowan's local database does not contain it  
**And** no network payload to Rowan's device contained its content

### Scenario: A tombstone for an unseen record does not arrive

**Given** a `gm_only` record is deleted  
**When** a player device synchronizes  
**Then** no tombstone for that record reaches the device  
**And** the deletion does not disclose that the record existed

---

## Denials Reveal Nothing

### Scenario: A denial and a miss are indistinguishable

**Given** record X exists in campaign A with visibility `gm_only`  
**And** identifier Y does not exist in campaign A  
**When** a player requests X and then requests Y  
**Then** both responses carry the `ApiError` code `not_found_or_forbidden`  
**And** both carry the same message and the same HTTP status  
**And** neither response carries details naming the record or its type

### Scenario: Counts and lists exclude hidden records

**Given** a campaign contains 10 records of one class, of which 4 are visible to a player  
**When** the player lists that class  
**Then** 4 records are returned  
**And** any total reported to the player is 4  
**And** no placeholder, gap, or masked entry represents the other 6

### Scenario: Denial summaries are not a behavioural log

**Given** several denials occurred in a campaign  
**When** a GM views the denial summary  
**Then** it reports denials at an aggregate level  
**And** it does not attribute individual attempts to individual players

---

## One Sanctioned Path

### Scenario: A feature applies the decision instead of writing one

**Given** a feature directory owns a content resource class  
**When** the repository architecture check runs  
**Then** a feature that reads membership storage directly fails the check  
**And** a feature that branches on a role literal outside the published module API fails the check

### Scenario: Every content-owning class runs the shared matrix

**Given** a feature registers a content resource class  
**When** the shared matrix test runs for that class  
**Then** the class has a declared outcome for every MVP role and every visibility mode  
**And** an undeclared combination fails the test rather than defaulting

---

## Offline

### Scenario: The device decides the same way as the server

**Given** a record is present in an actor's local database  
**And** the device has no network  
**When** the decision is evaluated locally  
**Then** the outcome matches the server outcome for the same actor, class, and visibility

### Scenario: A cached role does not outlive the server's answer

**Given** an actor's role was `gm` when the device last synchronized  
**And** the role was changed to `player` on the server while the device was offline  
**When** the device reconnects and synchronizes  
**Then** decisions use the server role `player`  
**And** records the actor may no longer see are removed from the local database

---

## Export

### Scenario: An export round trip does not widen visibility

**Given** a campaign contains records with `gm_only`, `everyone`, and targeted visibility  
**When** the campaign is exported and imported  
**Then** each record's visibility after import equals its visibility before export  
**And** no record becomes visible to an actor who was denied before the export

---

## P1 Behavior

### Scenario: Visibility targets a party

**Given** a party exists in a campaign with two player members  
**When** a GM sets a record's visibility to that party  
**Then** both party members are allowed  
**And** a player outside the party is denied  
**And** the grant follows party membership rather than a fixed player list

### Scenario: A bulk change reports what it could not do

**Given** a GM selects records, some of which the GM may not change  
**When** the GM applies one visibility change to the selection  
**Then** every record the GM may change has the new visibility  
**And** every record the GM may not change is unchanged and reported  
**And** each applied change emits its own audit event

### Scenario: Preview shows exactly what one player sees

**Given** a campaign has records at several visibility levels  
**When** a GM previews the campaign as Casey  
**Then** the previewed set equals the set of records allowed for Casey  
**And** the preview grants the GM no new access and changes no record

---

## Traceability

| PRD | Scenarios |
| --- | --- |
| Goal: one decision point | A decision is an outcome plus a reason; A feature applies the decision instead of writing one |
| Goal: hide, then reveal deliberately | GM-authored preparation defaults to GM-only; Reveal to one player delivers to that player only |
| Goal: apply by declaring | Both rules come from one declaration; Every content-owning class runs the shared matrix |
| Goal: testable in isolation | The decision depends on its declared inputs alone |
| FR-001 role to permission mapping | GM roles read preparation content, players do not; Member-management authority matches feature 01; A player cannot change what anyone may see; `observer` row of Unusable input fails closed |
| FR-002 visibility levels | Each visibility mode decides one way; `everyone` means everyone in that campaign |
| FR-003 pure decision function | A decision is an outcome plus a reason; The decision depends on its declared inputs alone; A role supplied by the client does not change the decision |
| FR-004 server-side enforcement | Hiding a control is not a control; A player cannot change another member's character resource; A content route without a decision fails the build; A hidden record's attachment is not reachable through storage |
| FR-005 sync rule definitions | Both rules come from one declaration; A GM-only record is absent from a player device; A tombstone for an unseen record does not arrive |
| FR-006 default visibility | GM-authored preparation defaults to GM-only; A record cannot exist without an answer to who may see it |
| FR-007 visibility change and audit | All Changing Visibility scenarios |
| FR-008 published module API | A feature applies the decision instead of writing one |
| FR-009 denials leak nothing | A denial and a miss are indistinguishable; Counts and lists exclude hidden records |
| FR-010 shared matrix test kit | Every content-owning class runs the shared matrix |
| FR-101 party grouping | Visibility targets a party; `party` rows of Each visibility mode decides one way |
| FR-102 bulk visibility change | A bulk change reports what it could not do |
| FR-103 GM preview mode | Preview shows exactly what one player sees |
| Constraint: authorization is server-side | Hiding a control is not a control |
| Constraint: sync and API rules agree | Both rules come from one declaration |
| Constraint: fail closed | Unusable input fails closed; Authority does not cross campaigns; A grant naming a removed member grants nothing |
| Constraint: no inference from shape, text, counts, or identifier gaps | A denial and a miss are indistinguishable; Counts and lists exclude hidden records; A tombstone for an unseen record does not arrive |
| Constraint: reveal is additive and audited | Revealing is additive; Repeating a reveal changes nothing; Every visibility change is audited; Un-reveal removes future access without un-telling |
| Constraint: offline evaluation over a safe cache | The device decides the same way as the server; A cached role does not outlive the server's answer; A GM-only record is absent from a player device |
| Data and privacy: grants are campaign data | A grant cannot name a non-member; A grant naming a removed member grants nothing |
| Data and privacy: denial log is not surveillance | Denial summaries are not a behavioural log |
| Data and privacy: export carries visibility | An export round trip does not widen visibility |
| `freeze-decisions.md`: player notes private to their author | A player-authored private note is not readable by a GM role |
| Success signal: `PRD.md` s.87 Test 3 | Reveal to one player delivers to that player only |
| Success signal: `PRD.md` s.87 Test 2 | A player cannot change another member's character resource |
| Success signal: zero GM-only rows in a player local database | A GM-only record is absent from a player device; A tombstone for an unseen record does not arrive |

## Not Covered Here

- Authentication, membership, invitations, and `ActorRef` resolution. Feature 01 owns them and its
  BDD covers them; the scenarios here consume an already-resolved actor.
- Sync transport, queueing, and conflict presentation. Feature 03 owns them. The scenarios here
  assert that the rules this feature declares are the rules enforced there.
- The reveal user experience, its timing budget, and handout states. Feature 17 owns them.
- Field-level editability inside a character sheet. Feature 15 owns it and defers the coarse
  owner-or-GM decision here.
- Knowledge-level visibility, where a world truth and a player belief differ (FR-202, V2).
- Advanced or custom roles and per-feature permission editors (FR-201, V2).

## Downstream Decisions and Remaining Registration Work

`_domain.md`, `_db.md`, and `_techspec.md` settle the cross-cutting choices: author-private notes use
a Resource Class ownership rule, party targeting fails closed until a resolver exists, un-reveal is
P0, and visibility changes are versioned owner-adapter mutations. Denial telemetry is aggregate by
resource class/reason/time window and never actor identity.

Each content owner must still register its exact capability matrix. Missing combinations prevent
that Resource Class from starting; they never default allow.
