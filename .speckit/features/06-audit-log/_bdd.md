# BDD: Audit Log

Source: `_prd.md`, `../00-platform-foundation/freeze-decisions.md`,
`../03-offline-sync-platform/_bdd.md`, and `../04-visibility-and-authorization/_bdd.md`.

This is intentionally a light BDD. It covers the trust, privacy, ordering, and failure rules that
cannot be left to implementation tests. Event-type formatting details remain contributor tests.

## Recording

### Scenario: A significant mutation records one event

**Given** an authorized mutation changes campaign state  
**When** the mutation is accepted  
**Then** one audit event records its actor, action, target, campaign, before and after values, and time  
**And** the mutated entity remains the source of truth

### Scenario: Audit failure does not reject play

**Given** audit storage is temporarily unavailable  
**When** an otherwise valid campaign mutation is accepted  
**Then** the mutation succeeds  
**And** the audit event is retained for retry  
**And** the degradation is observable to operators without exposing event content

### Scenario: Retrying an event does not duplicate it

**Given** an event was accepted but its acknowledgement was lost  
**When** the same event identifier is submitted again  
**Then** exactly one audit event is stored

### Scenario: Application code cannot change history

**Given** an audit event exists  
**When** application code attempts to update or delete it outside the retention process  
**Then** the operation is unavailable or rejected  
**And** the event remains unchanged

## Privacy Boundaries

### Scenario Outline: An event is routed to one physical store

**Given** a mutation produces an event whose privacy is `<privacy>`  
**When** the event is recorded  
**Then** it exists only in `<store>`

| privacy | store |
| --- | --- |
| campaign-visible | campaign audit store |
| GM-private | GM-private audit store |

### Scenario: Private events never reach a player device

**Given** a campaign contains GM-private audit events  
**When** a player synchronizes the campaign  
**Then** no private event row, payload, count, or tombstone reaches the player's local database  
**And** absence is asserted below the interface layer

### Scenario: Audit data cannot reveal a hidden target

**Given** an event refers to a target a player may not see  
**When** that player reads the campaign audit log  
**Then** the event and its before and after values are absent  
**And** totals do not disclose the hidden event

### Scenario: A removed member loses future audit access

**Given** a member previously synchronized visible audit events  
**When** their campaign membership is revoked and the device reconnects  
**Then** campaign audit data is removed with the campaign replica  
**And** no later audit event reaches that device

## Ordering and Offline Behavior

### Scenario: Campaign order does not depend on client clocks

**Given** two devices have clocks that disagree  
**When** their events are accepted by the authority  
**Then** each event receives a stable campaign order from the authority  
**And** every connected reader sees the same reverse-chronological order

### Scenario: An offline mutation and event synchronize together

**Given** a member performs an auditable mutation offline  
**When** the mutation is recorded locally  
**Then** its audit event is recorded in the same local atomic unit  
**And** after reconnection no observer can receive only one of the mutation and event

### Scenario: A rejected offline mutation does not become accepted history

**Given** an offline mutation and its event are pending  
**When** the authority rejects the mutation  
**Then** its event is not published as an accepted state change  
**And** conflict handling retains enough correlation to explain the rejection

## Reading and Rendering

### Scenario: Campaign and session views are newest first

**Given** a campaign has events across multiple sessions  
**When** a GM opens the campaign log or one session log  
**Then** only events in that scope are returned  
**And** they are ordered newest first by stable authority order

### Scenario Outline: Filters narrow without widening visibility

**Given** an actor may read part of a campaign audit log  
**When** they filter by `<filter>`  
**Then** only already-visible matching events are returned

| filter |
| --- |
| actor |
| target |

### Scenario: A registered renderer explains an event

**Given** an event type has a registered renderer from its owning feature  
**When** a member reads that event  
**Then** it is rendered as a human-readable state change  
**And** raw field differences are not the only explanation

### Scenario: An unregistered event remains safe

**Given** an event type has no available renderer  
**When** an authorized member reads it  
**Then** a generic safe description is shown  
**And** raw hidden values or internal errors are not exposed

## Volume

### Scenario: No event is produced for incidental activity

**Given** a member types, renders a view, or retries an unchanged read  
**When** no meaningful campaign state changes  
**Then** no audit event is recorded

### Scenario: Local audit storage respects its allocation

**Given** a campaign has a long audit history  
**When** its local audit stores are measured  
**Then** their combined storage remains within feature 06's 10 MB campaign allocation  
**And** eviction never moves a private event into the campaign-visible store

## Traceability

| PRD requirement | Covered by |
| --- | --- |
| FR-001 append-only | Application code cannot change history |
| FR-002 event shape | A significant mutation records one event |
| FR-003 separate stores | An event is routed to one physical store; Private events never reach a player device |
| FR-004 recording API | Recording and retry scenarios |
| FR-005 required contributors | Contributor contract tests; see Not Covered Here |
| FR-006 human-readable rendering | Registered and unregistered renderer scenarios |
| FR-007 scoped and filtered views | Campaign and session views; Filters narrow without widening visibility |
| FR-008 atomic offline path | Offline mutation and event synchronize together; Rejected offline mutation |
| FR-009 non-blocking recording | Audit failure does not reject play |
| Stable ordering constraint | Campaign order does not depend on client clocks |
| Visibility/privacy constraints | All Privacy Boundaries scenarios |
| Bounded volume constraint | No incidental event; Local audit storage respects its allocation |

## Not Covered Here

- Undo, tamper evidence, and grouped events are later scope.
- The exhaustive event-type list is verified by each contributing feature against the recorder
  contract; duplicating every feature's mutation scenarios here would not add behavior coverage.
- P1 export and archival policy are deferred. The DB and TechSpec still define the P0 local bound
  needed to protect the frozen 60 MB campaign budget.

