# BDD: Campaign Lifecycle

Source: `_prd.md`, `../00-platform-foundation/_prd.md`,
`../00-platform-foundation/freeze-decisions.md`, `../08-system-package-contract/_prd.md`,
`../01-identity-and-membership/_bdd.md`.

Three PRD open questions affect what is assertable. The scenarios below take these positions:

- **The party step creates invitations only**, never character records. This is the leaning already
  recorded in the PRD, and it is what keeps this feature from owning character data (feature 15).
- **What "review changes" shows is not asserted.** Feature 08 FR-102, the manifest changelog, is
  P1. The scenarios assert that the choice is offered and that no update happens without it.
- **Enabling a module after creation is not asserted either way.** No scenario here permits or
  forbids it; see Open Questions.

"The system" below always means the manifest-declared package resolved from the registry
(feature 08). No scenario names Cairn or Fate: `PRD.md` s.89 forbids this feature from knowing
either exists, so a scenario that named one would be asserting the wrong thing.

---

## System Selection

### Scenario: The selection list renders from the system summary alone

**Given** the registry holds installed systems  
**When** a GM opens system selection  
**Then** each installed system is listed once with its declared name, short description,
complexity, documentation status, a rules entry point, and a select action  
**And** the list renders with only `SystemSummary` available and no other part of the manifest loaded

### Scenario: A system this feature has never seen renders unchanged

**Given** the registry holds the fixture system, which is neither MVP system  
**When** a GM opens selection and selects it  
**Then** it is listed and selectable like any other system  
**And** the architecture guard reports no branch on a system identifier in this feature

### Scenario: Text search narrows the list to declared fields

**Given** the registry holds several installed systems  
**When** the GM searches for a term appearing in one system's declared name or short description  
**Then** only systems whose declared summary fields match the term are listed  
**And** clearing the search restores the full list

### Scenario: Every integration status is shown, including the unsupported ones

**Given** a system declares mechanics supported, character sheet supported, rules text not
integrated, compendium not integrated, and external documentation available  
**When** the GM views that system  
**Then** all five statuses are presented separately with their declared values  
**And** the two unsupported statuses are shown as unsupported rather than omitted

### Scenario: Mechanical support is not presented as documentation rights

**Given** a system declares mechanics supported and rules text not integrated  
**When** the GM opens that system's rules entry point from the selection screen  
**Then** the entry point leads to the declared external documentation  
**And** no integrated rules text is presented for that system

### Scenario: Rules are reachable before a campaign exists

**Given** a system declares integrated rules text  
**When** the GM opens its rules entry point from the selection screen and returns  
**Then** the rules were reachable without creating a campaign  
**And** no campaign was created  
**And** the GM's selection state is unchanged

---

## The Creation Wizard

### Scenario: Only the game modes the chosen system declares are offered

**Given** the chosen system declares a set of game modes  
**When** the GM reaches the game mode step  
**Then** exactly the declared modes are offered  
**And** no mode defined by this feature is added to them  
**And** the wizard cannot be completed with a mode outside that set

### Scenario Outline: A step with nothing declared is skipped, not shown empty

**Given** `<condition>`  
**When** the GM advances through the wizard  
**Then** the `<step>` step is not shown  
**And** the wizard advances to the next step that has something to show

| step | condition |
| --- | --- |
| configure system | the chosen system declares no options |
| choose modules | no installed module declares compatibility with the chosen system |

### Scenario: System options render from their declarations

**Given** the chosen system declares options with types, defaults, and constraints  
**When** the GM reaches the configure system step  
**Then** each declared option is rendered from its declaration with its declared default preselected  
**And** a value violating a declared constraint blocks completion of the step  
**And** no option is recognized by name by this feature

### Scenario: Module choices are limited to declared compatibility

**Given** installed modules where some declare compatibility with the chosen system and some do not  
**When** the GM reaches the choose modules step  
**Then** only the compatible modules are offered  
**And** selecting one records its identifier  
**And** no module behavior is executed at any point in creation

### Scenario: Changing the system clears choices that depended on it

**Given** a GM has chosen a system, a game mode, option values, and modules  
**When** the GM goes back and chooses a different system  
**Then** the game mode, option values, and module selections not declared by the new system are cleared  
**And** the wizard cannot be completed carrying any of them

### Scenario: Campaign details collect a name and a description and nothing else

**Given** a GM reaches the campaign details step  
**When** the step is rendered  
**Then** it collects a campaign name and a description and no other field  
**And** creation is rejected when the name is empty, leaving no campaign

### Scenario: Abandoning the wizard persists nothing

**Given** a GM has completed several wizard steps  
**When** the GM leaves without completing creation  
**Then** no campaign exists for that GM  
**And** no partial campaign, system pin, module pin, or membership was persisted

### Scenario: A failure during creation persists nothing

**Given** a GM submits a completed wizard  
**When** persistence fails partway through  
**Then** no campaign, system pin, module pin, or owner membership exists  
**And** the GM can resubmit without cleaning anything up

---

## Creating the Campaign

### Scenario: Creation pins the system version resolved at creation

**Given** the registry holds a system at version `1.2.0` as its newest installed version  
**When** the GM creates a campaign on that system  
**Then** the campaign's system reference records that system id and version `1.2.0`  
**And** the reference carries both the id and the version, not the id alone

### Scenario: Creation records exactly the choices made

**Given** a GM completed the wizard with a game mode, option values, two modules, a name, and a description  
**When** the campaign is created  
**Then** the campaign holds exactly those values  
**And** no module, mode, or option the GM did not choose is recorded as enabled

### Scenario: The campaign and its owner membership commit together

**Given** a GM completes the wizard  
**When** the campaign is created  
**Then** the campaign has exactly one `owner`, and that owner is the creating GM  
**And** no committed state contains a campaign with zero owners or more than one  
**And** the guarantee holds under concurrent creation attempts

### Scenario: Creation emits an audit event

**Given** a GM completes the wizard  
**When** the campaign is created  
**Then** an `AuditEvent` records the actor, the campaign, and the pinned system reference

### Scenario: Creation fits the activation budget

**Given** a GM with an account and no campaign  
**And** the chosen system is already installed  
**When** the GM completes the creation wizard  
**Then** the campaign exists within 3 minutes of GM time  
**And** the measurement covers only the wizard, not account creation or session start

---

## Version Pinning

### Scenario: A newer system version does not move an existing campaign

**Given** a campaign pinned at `1.2.0`  
**When** version `1.3.0` of the same system is installed  
**Then** the campaign's pin is still `1.2.0`  
**And** every read of campaign context returns `1.2.0`

### Scenario: Consumers resolve the pinned version, not the newest

**Given** a campaign pinned at `1.2.0`  
**And** the registry holds both `1.2.0` and `1.3.0` of that system  
**When** a feature resolves the campaign's system through the published context API  
**Then** it receives `1.2.0`  
**And** no consumer of that campaign receives `1.3.0`

### Scenario Outline: Nothing but the update flow writes the pin

**Given** a campaign pinned at `1.2.0`  
**And** version `1.3.0` is installed  
**When** `<operation>` occurs  
**Then** the pin is still `1.2.0`

| operation |
| --- |
| campaign details are edited |
| a campaign setting is written |
| a member is added, removed, or has their role changed |
| the client synchronizes |
| the application is restarted |

### Scenario: An unresolvable pin fails closed

**Given** a campaign pinned at a version the registry can no longer resolve  
**When** campaign context is requested  
**Then** the request fails with the shared `ApiError` shape  
**And** no other installed version of that system is substituted

---

## System Version Update

### Scenario: A newer version is offered, never applied

**Given** a campaign pinned at `1.2.0`  
**And** version `1.3.0` is installed  
**When** the owner opens the campaign  
**Then** the availability of `1.3.0` is surfaced with the choices review changes, update, and keep current  
**And** the pin is still `1.2.0`

### Scenario: Keeping the current version changes nothing

**Given** an available update was surfaced for a campaign pinned at `1.2.0`  
**When** the owner chooses keep current  
**Then** the pin is still `1.2.0`  
**And** no audit event records a version change

### Scenario: Updating the version is explicit and recorded

**Given** an available update was surfaced for a campaign pinned at `1.2.0`  
**When** the owner chooses update  
**Then** the pin becomes `1.3.0`  
**And** an `AuditEvent` records the actor, the previous version, and the new version  
**And** every subsequent campaign context read returns `1.3.0`

### Scenario: No path updates the pin without a human decision

**Given** a campaign pinned at `1.2.0`  
**And** version `1.3.0` is installed  
**When** the application starts, synchronizes, and runs with no human choosing update  
**Then** the pin is still `1.2.0`

### Scenario: Concurrent version updates — exactly one applies

**Given** two clients hold the same campaign at the same record version  
**When** both submit a version update  
**Then** exactly one update is accepted  
**And** the other is reported as a version conflict carrying the expected and actual versions  
**And** the accepted pin is not replaced by the rejected submission

---

## Campaign Read, Update, and Delete

### Scenario: A campaign is listed only for its current members

**Given** a user has a current membership in two campaigns and none in a third  
**When** the user lists their campaigns  
**Then** the two campaigns are returned once each  
**And** the third is absent

### Scenario: Losing membership removes the campaign from the list

**Given** a user's membership in a campaign is removed  
**When** the user lists their campaigns  
**Then** that campaign is absent  
**And** a direct read of it is denied

### Scenario: A non-member read does not reveal that the campaign exists

**Given** a campaign exists  
**When** a user with no membership reads it by identifier  
**Then** the denial uses the shared `ApiError` shape  
**And** the response does not distinguish a campaign that exists from one that does not

### Scenario: Editing details leaves the pin and modules untouched

**Given** a campaign with a pinned system version and enabled modules  
**When** the owner changes the campaign name and description  
**Then** the new name and description are stored  
**And** the system reference and enabled module ids are unchanged

### Scenario Outline: A player changes nothing about the campaign

**Given** a user is a `player` in a campaign  
**When** the user attempts to `<operation>`  
**Then** the campaign is unchanged  
**And** the denial uses the shared `ApiError` shape

| operation |
| --- |
| edit the campaign name or description |
| update the pinned system version |
| soft delete the campaign |

### Scenario: Deletion is a tombstone, not a removal

**Given** a campaign with content exists  
**When** the `owner` deletes it  
**Then** the campaign record carries a deletion marker  
**And** it is absent from default listings for every member  
**And** the record is not removed from storage  
**And** an `AuditEvent` records the deletion with its actor

### Scenario: A deleted campaign resolves no context

**Given** a campaign has been soft deleted  
**When** a feature requests its context through the published API  
**Then** no context is returned  
**And** the failure uses the shared `ApiError` shape

---

## Campaign Context API

### Scenario: Context carries the full published shape

**Given** an authorized member of a campaign  
**When** a feature resolves campaign context through the published module API  
**Then** the result contains the campaign id, the `SystemRef`, the game mode, the enabled module
ids, and the campaign settings  
**And** no consumer needs any other source to obtain them

### Scenario: No other feature imports this feature's internals

**Given** the repository-wide architecture guard from feature 00 FR-009  
**When** a file outside this feature imports the internals of this feature's package  
**Then** the build fails  
**And** the published context API remains reachable through the package entry point

### Scenario: Context resolution requires campaign access

**Given** a user has no current membership in a campaign  
**When** campaign context is resolved for that user and campaign  
**Then** no context is returned  
**And** access is denied by the feature 04 decision rather than by a rule this feature invents

### Scenario: Context resolves offline for a synchronized campaign

**Given** a campaign was synchronized to a device  
**And** the device is offline  
**When** a feature resolves campaign context on that device  
**Then** the pinned system reference, game mode, enabled module ids, and settings are returned
from the local copy  
**And** the values match what the server held at the last synchronization

---

## Campaign Settings

### Scenario: A write touches only its own namespace

**Given** two features hold values in their own campaign setting namespaces  
**When** one feature writes its setting  
**Then** its namespace holds the new value  
**And** the other namespace is unchanged

### Scenario: A value failing its owning namespace's schema is rejected

**Given** a namespace whose owning feature declares a TypeBox schema  
**When** a value violating that schema is written  
**Then** the write is rejected with the shared `ApiError` shape  
**And** the stored value is unchanged

### Scenario: An unowned namespace is not created on write

**Given** a namespace with no registered owning feature  
**When** a value is written to it  
**Then** the write is rejected  
**And** no namespace is created

### Scenario: A member-visible setting change is audited

**Given** a setting whose value is visible to campaign members  
**When** an authorized member changes it  
**Then** an `AuditEvent` records the actor, the namespace, and the before and after values

---

## Offline Creation

### Scenario: A campaign is created offline against a locally available system package

**Given** the device has no network  
**And** the chosen system package is present locally  
**When** the GM completes the creation wizard  
**Then** the campaign is created and readable from the local database with its pinned version  
**And** after reconnection the server holds the same campaign with the same identifiers and the
same pinned version

### Scenario: Party invitations are queued, not reported as sent

**Given** a GM created a campaign offline and entered party invitations at the party step  
**When** the device is still offline  
**Then** no invitation is reported as delivered  
**And** after reconnection the invitations are created on the server for that campaign

### Scenario: The party step creates no character records

**Given** a GM completes the party step during creation  
**When** the campaign is created  
**Then** invitations exist for the entered party members  
**And** no character record was created by this feature

---

## P1 Behavior

### Scenario Outline: Filters narrow the list by declared summary fields

**Given** the registry holds systems declaring different values for `<filter>`  
**When** the GM applies a value for `<filter>` on the selection screen  
**Then** only systems whose declaration matches that value are listed  
**And** systems that declare nothing for `<filter>` are excluded rather than assumed to match

| filter |
| --- |
| genre |
| complexity |
| narrative focus |
| tactical focus |
| lethality |
| dice used |
| solo |
| GM-less |
| integrated documentation |
| language |

### Scenario: Game mode changes after creation where the system permits it

**Given** a campaign whose pinned system declares more than one game mode and permits changing it  
**When** the owner changes the campaign to another declared mode  
**Then** campaign context returns the new mode  
**And** a mode the pinned system does not declare is rejected

---

## Traceability

| PRD source | Covered by |
| --- | --- |
| Goal: 10 minute activation, campaign creation under 3 minutes | Creation fits the activation budget |
| Goal: pin never changes without a human decision | Version Pinning and System Version Update scenarios |
| Goal: one published API for campaign context | Campaign Context API scenarios |
| Goal: honest integration status | Every integration status is shown; Mechanical support is not presented as documentation rights |
| FR-001 wizard steps and skipping | The Creation Wizard scenarios, including the step-skipping outline |
| FR-002 selection screen | The selection list renders from the system summary alone; Text search narrows the list; Rules are reachable before a campaign exists |
| FR-003 integration status | Every integration status is shown; Mechanical support is not presented as documentation rights |
| FR-004 game mode selection | Only the game modes the chosen system declares are offered |
| FR-005 generic option rendering | System options render from their declarations |
| FR-006 module selection and pinning | Module choices are limited to declared compatibility; Creation records exactly the choices made |
| FR-007 campaign details | Campaign details collect a name and a description and nothing else |
| FR-008 persistence with a pinned version | Creation pins the system version resolved at creation; Consumers resolve the pinned version |
| FR-009 campaign list scoped by membership | A campaign is listed only for its current members; Losing membership removes the campaign from the list |
| FR-010 read, update, soft delete | Editing details leaves the pin and modules untouched; A player changes nothing about the campaign; Deletion is a tombstone |
| FR-011 version update flow | All five System Version Update scenarios |
| FR-012 published context API | All four Campaign Context API scenarios |
| FR-013 namespaced settings | All four Campaign Settings scenarios |
| FR-101 selection filters | Filters narrow the list by declared summary fields |
| FR-102 cover image and colour identity | Not covered — see Not Covered Here |
| FR-103 game mode change after creation | Game mode changes after creation where the system permits it |
| Constraint: no branch on system identity (`PRD.md` s.89) | A system this feature has never seen renders unchanged; System options render from their declarations; asserted by the feature 00 FR-009 guard |
| Constraint: only FR-011 writes the pin | Nothing but the update flow writes the pin |
| Constraint: creation is atomic | Abandoning the wizard persists nothing; A failure during creation persists nothing; The campaign and its owner membership commit together |
| Constraint: offline creation, queued invitations | Offline Creation scenarios |
| Constraint: access decided by feature 04 | A non-member read does not reveal that the campaign exists; Context resolution requires campaign access |
| Constraint: soft delete with a tombstone (`PRD.md` s.57) | Deletion is a tombstone, not a removal |
| Data and privacy: members-only visibility | A non-member read does not reveal that the campaign exists |
| Data and privacy: identifiers only, never system content | Creation records exactly the choices made; Consumers resolve the pinned version |
| Data and privacy: audit events | Creation emits an audit event; Updating the version is explicit and recorded; Deletion is a tombstone; A member-visible setting change is audited |
| Success signal: zero unpinned or drifting versions | A newer system version does not move an existing campaign; No path updates the pin without a human decision |
| Success signal: integration status readable from selection alone | Every integration status is shown |
| Success signal: no other feature reads the campaign table | No other feature imports this feature's internals — partial, see Open Questions |
| Feature 01 `_bdd.md` external dependency: exactly one owner per committed campaign | The campaign and its owner membership commit together |

## Not Covered Here

- **FR-102 cover image and colour identity.** Purely presentational, with no rule to verify beyond
  storing a value. It becomes assertable if a size, format, or attachment lifecycle appears, at
  which point it belongs to feature 05.
- **Which authorization rule allows a read or write.** Feature 04 defines the matrix; the scenarios
  here assert that this feature defers to it and fails closed, not what the rules are.
- **Membership, invitation token, and ownership-transfer mechanics.** Feature 01 owns them and its
  `_bdd.md` covers them. This feature asserts only the creation-time owner invariant.
- **Sync queue, conflict presentation, and tombstone propagation mechanics.** Feature 03 owns them.
  The offline and concurrency scenarios here assert that this feature's records behave correctly
  through that machinery, not the machinery itself.
- **Manifest validity, registry loading, and multi-version storage.** Feature 08 owns them.
- **FR-201 templates and duplication, FR-202 migration assistance.** P2.

## Downstream Decisions and Remaining Dependency

`_db.md` and `_techspec.md` settle the implementation-facing questions: P0 module pins are immutable
after creation; owner alone updates the system pin; incompatible option declarations block an update;
setting namespaces register in code with TypeBox schemas; drafts are not persisted; and task 08 adds
the missing campaign-table guard rule.

Feature 08 remains responsible for the exact review content and unavailable-package model. Until it
publishes changelog metadata, the update flow may show the exact from/to versions and compatibility
errors but cannot claim richer change details.
