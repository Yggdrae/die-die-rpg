# BDD: Offline-First Sync Platform

Source: `_prd.md`, `../00-platform-foundation/freeze-decisions.md`,
`../00-platform-foundation/spike-findings.md`, `../00-platform-foundation/adrs/ADR-001-optimistic-concurrency.md`.

Two of the PRD open questions were settled after it was written, and the scenarios below assume
the settled answers:

- Long text is **single-writer with explicit takeover**, not optimistic concurrency (FR-012 in
  `freeze-decisions.md`). See "Long Text".
- Feature 03 holds **10 MB** of the 60 MB per-campaign budget for tombstones and pending
  mutations (FR-013). The bound exists; the eviction policy does not yet.

"Local database" below means the synchronized copy on the device. No scenario names a sync
provider: the PRD requires provider replacement to be a change in one boundary (FR-003), so a
scenario that named one would be asserting the wrong thing.

---

## Local-First Read and Write Path

### Scenario: A write applies without waiting for the server

**Given** a member has a synchronized campaign open  
**And** the device is connected  
**When** the member changes a value on a record they may edit  
**Then** the change is readable from the local database before any server response is received  
**And** the interface reports the change as applied

### Scenario: The session survives losing connection mid-use

**Given** a GM is working in a synchronized campaign  
**When** the network becomes unavailable  
**Then** reads and writes continue to succeed against the local database  
**And** no operation reports a network error to the user

### Scenario Outline: Offline capability covers the flows the product promises

**Given** a campaign was synchronized before the network became unavailable  
**When** the user performs `<flow>` with no network  
**Then** the operation succeeds locally  
**And** the result is readable immediately

| flow |
| --- |
| open the synchronized campaign |
| view and edit a character sheet field they own |
| create a note |
| record a dice roll |
| read cached rules |
| start an encounter |
| change a resource |
| continue an in-progress session |

---

## Initial and Incremental Synchronization

### Scenario: A campaign becomes available locally on first open

**Given** a member has a campaign they have never opened on this device  
**And** the device is connected  
**When** the member opens the campaign  
**Then** the records that member is permitted to see become present in the local database  
**And** the campaign is subsequently readable with no network

### Scenario: A server-side change reaches a connected device

**Given** two members have the same campaign synchronized  
**And** both devices are connected  
**When** the first member changes a record both may see  
**Then** the second device observes the new value without a manual refresh

### Scenario: A record the actor may not see never arrives

**Given** a campaign contains a record whose visibility is GM-only  
**When** a player device synchronizes that campaign  
**Then** the record is absent from that device's local database  
**And** absence is asserted against the local database, not against what the interface renders

---

## Offline Queue

### Scenario: An offline write is queued rather than lost

**Given** the device has no network  
**When** a member makes a change the interface reports as applied  
**Then** the change is present in the local database  
**And** the change is present in the pending queue  
**And** the pending count reported to the user increases by one

### Scenario: The queue survives an application restart

**Given** a pending queue contains at least one mutation  
**And** the device still has no network  
**When** the application is closed and reopened  
**Then** the same mutations are still pending  
**And** no pending mutation was discarded

### Scenario: Queued mutations reach the server after reconnection

**Given** a member made three changes while offline: a character field, a note, and a roll  
**When** the network becomes available again  
**Then** all three reach the server  
**And** another member's device observes all three  
**And** the pending count returns to zero

### Scenario: Causally ordered mutations are applied in order

**Given** a member offline creates a record and then updates it twice  
**When** the queue drains  
**Then** the server applies the create before either update  
**And** applies the earlier update before the later one

### Scenario: A drained mutation is not applied twice

**Given** a pending mutation was uploaded and acknowledged  
**When** the connection drops and is re-established before the acknowledgement is recorded locally  
**And** the queue drains again  
**Then** the record reflects the mutation exactly once  
**And** no duplicate record is created

### Scenario: A confirmed mutation is never silently discarded

**Given** the interface reported a mutation as applied  
**When** any subsequent synchronization outcome occurs, including rejection  
**Then** the mutation is either present on the server or reported to the user as unresolved  
**And** it is never dropped without a user-visible outcome

---

## Conflicts Detected at Write Time

### Scenario: A stale write is rejected instead of overwriting

**Given** a record is at version 2 on the device  
**And** the record is at version 3 on the server  
**And** the device is connected  
**When** the member submits an update based on version 2  
**Then** the update is rejected as a conflict  
**And** the conflict reports both the expected version and the actual version  
**And** the stored record is unchanged

### Scenario: Two members updating the same record — exactly one succeeds

**Given** a GM and an assistant GM both hold a record at version 4  
**When** both submit an update based on version 4  
**Then** exactly one update is accepted  
**And** the other is reported as a conflict  
**And** the accepted value is not replaced by the rejected one

### Scenario: A conflict is presented, never resolved automatically

**Given** an update was rejected as a conflict  
**When** the conflict reaches the user  
**Then** both the submitted version and the current version are available to compare  
**And** the outcome is not applied until the user chooses one  
**And** no version is discarded before that choice

### Scenario: Clock differences do not decide the outcome

**Given** two devices have clocks that disagree by several minutes  
**And** both submit updates to the same record  
**When** the conflict is resolved  
**Then** the outcome is determined by record version and server ordering  
**And** the device clocks do not change which update is accepted

---

## Conflicts Detected After the Fact

Established by the wave 0 spike: an offline write succeeds locally and is only checked against
the server version on upload, so a successful write is not proof the server accepted it
(`spike-findings.md`, Finding 1).

### Scenario: A write accepted offline is rejected on upload

**Given** a member updates a record while offline  
**And** the interface reports the change as applied  
**And** another member changes the same record on the server in the meantime  
**When** the offline member reconnects and the queue drains  
**Then** the write is rejected by the server  
**And** a deferred conflict is raised naming the record, the expected version, and the actual version  
**And** the user is told the change they were shown as applied did not take effect

### Scenario: A feature learns about a deferred conflict without polling

**Given** a feature has subscribed to deferred conflicts  
**When** a queued write is rejected on upload  
**Then** the subscriber receives the conflict  
**And** unsubscribing stops further delivery

### Scenario: A deferred conflict does not silently revert local state

**Given** a deferred conflict was raised for a record  
**When** the user has not yet chosen an outcome  
**Then** the local value is not replaced by the server value without that choice  
**And** the record is marked as having an unresolved conflict

---

## Semantic Operations

### Scenario: Concurrent damage and healing both survive

**Given** a resource is at 6 on the server  
**And** a GM offline applies damage of −3  
**And** a player online applies healing of +2  
**When** both changes reach the server  
**Then** the resource is 5  
**And** neither change is reported as a conflict

### Scenario: A bounded resource stays within its declared range

**Given** a resource has a declared minimum of 0 and is at 2  
**When** two concurrent changes of −3 and −1 are applied  
**Then** the stored value is 0  
**And** the value is never stored below the declared minimum

### Scenario: An absolute write to a counter is not treated as a merge

**Given** two members concurrently set the same field to different absolute values  
**When** both reach the server  
**Then** the second is reported as a conflict rather than merged  
**And** the first value is not overwritten silently

---

## Long Text — Single Writer

Per FR-012 in `freeze-decisions.md`. Collaborative merge is V1; MVP avoids the conflict rather
than resolving it badly.

### Scenario: A second editor sees long text as held

**Given** one member is editing a long-text field  
**When** a second member opens the same field  
**Then** the field is presented as held by the first member  
**And** the second member cannot type into it without taking over

### Scenario: Takeover is explicit and the previous holder is told

**Given** a long-text field is held by one member  
**When** a second member takes over the field  
**Then** the hold transfers to the second member  
**And** the previous holder is told they no longer hold it  
**And** text the previous holder had already saved is retained

### Scenario: A hold does not outlive its holder's session

**Given** a member holding a long-text field disconnects without releasing it  
**When** the hold expires  
**Then** another member can acquire the field  
**And** no content saved by the previous holder is lost

---

## Deletes

### Scenario: A delete propagates rather than resurrecting

**Given** a record exists on two synchronized devices  
**When** one device deletes it and both synchronize  
**Then** the record is absent from default listings on both devices  
**And** the record does not reappear on a later synchronization

### Scenario: A delete based on a stale version conflicts

**Given** a record is at version 5 on the server  
**When** a device submits a delete based on version 4  
**Then** the delete is rejected as a conflict  
**And** the record is not deleted

### Scenario: A concurrent edit and delete is surfaced, not guessed

**Given** one member deletes a record while another edits it offline  
**When** both changes reach the server  
**Then** the outcome is reported to the editing member  
**And** the edit is not silently discarded

---

## Permission Enforcement at the Sync Boundary

### Scenario: A player cannot change a character they do not own

**Given** a player is a member of a campaign  
**When** the player submits a change to another member's character  
**Then** the server rejects the change  
**And** rejection does not depend on the interface having hidden the control

### Scenario: Revoked membership ends access on reconnection

**Given** a member has a campaign synchronized locally  
**When** their membership is revoked while their device is offline  
**And** the device reconnects  
**Then** the server refuses further synchronization for that campaign  
**And** the local copy of that campaign is removed from the device  
**And** pending mutations for that campaign are not applied

### Scenario: Signing out clears synchronized campaign data

**Given** a user has one or more campaigns synchronized on a device  
**When** the user signs out  
**Then** campaign content and pending mutations are removed from that device

---

## Synchronization Status

### Scenario Outline: The user can tell what state synchronization is in

**Given** a member has a campaign open  
**When** the synchronization state is `<state>`  
**Then** the interface reports `<reported>`

| state | reported |
| --- | --- |
| connected, queue empty | synchronized |
| connected, queue draining | pending count |
| no network | offline, with pending count |
| upload rejected or transport failing | error, with pending count preserved |

### Scenario: Pending work is visible before a session ends

**Given** pending mutations exist  
**When** the GM views synchronization status  
**Then** the number of unsynchronized changes is stated  
**And** the status does not read as synchronized

---

## Storage and Startup

### Scenario: Session Mode opens quickly from a warm local database

**Given** an installed application with a synchronized typical campaign  
**And** the device has no network  
**When** the application is opened cold and the user navigates to Session Mode  
**Then** Session Mode is usable within 2 seconds at p95  
**And** the measurement excludes attachment download

### Scenario: The campaign stays inside its storage budget

**Given** a typical campaign is synchronized  
**When** local storage use is measured  
**Then** it remains within the 60 MB per-campaign budget  
**And** tombstones plus pending mutations remain within the 10 MB allocated to this feature

### Scenario: Persistence works where the preferred storage backend is unavailable

**Given** a browser where the preferred local storage backend is unavailable  
**When** a campaign is synchronized and the application is restarted  
**Then** the campaign is still present locally  
**And** offline reads and writes behave as they do on the preferred backend

---

## Traceability

| PRD | Scenarios |
| --- | --- |
| FR-001 local database with fallback | Persistence works where the preferred storage backend is unavailable |
| FR-002 server store of record | A server-side change reaches a connected device |
| FR-003 provider-neutral boundary | No scenario names a provider — asserted by the absence |
| FR-004 initial synchronization | A campaign becomes available locally on first open |
| FR-005 incremental synchronization | A server-side change reaches a connected device |
| FR-006 durable queue | An offline write is queued rather than lost; The queue survives an application restart |
| FR-007 reconnect and drain | Queued mutations reach the server after reconnection; Causally ordered mutations are applied in order; A drained mutation is not applied twice |
| FR-008 optimistic concurrency | A stale write is rejected instead of overwriting; Two members updating the same record; Clock differences do not decide the outcome |
| FR-009 conflict surface | A conflict is presented, never resolved automatically; all three deferred-conflict scenarios |
| FR-010 semantic operations | Concurrent damage and healing both survive; A bounded resource stays within its declared range; An absolute write to a counter is not treated as a merge |
| FR-011 tombstones | A delete propagates rather than resurrecting; A delete based on a stale version conflicts; A concurrent edit and delete is surfaced |
| FR-012 status indicator | The user can tell what state synchronization is in; Pending work is visible before a session ends |
| FR-013 sync rules enforce visibility | A record the actor may not see never arrives; A player cannot change a character they do not own |
| FR-014 drop local database on revocation | Revoked membership ends access on reconnection |
| FR-015 offline flows | Offline capability covers the flows the product promises |
| Goal: local read/write path | A write applies without waiting for the server; The session survives losing connection mid-use |
| Goal: p95 under 2 s (`PRD.md` s.79) | Session Mode opens quickly from a warm local database |
| Goal: zero silent overwrites (`PRD.md` s.80) | A confirmed mutation is never silently discarded; A deferred conflict does not silently revert local state |
| `freeze-decisions.md` FR-012 long text | All three Long Text scenarios |
| `freeze-decisions.md` FR-013 budget | The campaign stays inside its storage budget |
| `spike-findings.md` Finding 1 | All three Conflicts Detected After the Fact scenarios |
| `PRD.md` s.87 Test 2 | A player cannot change a character they do not own |
| `PRD.md` s.87 Test 4 | Queued mutations reach the server after reconnection |
| `PRD.md` s.87 Test 6 | Two members updating the same record — exactly one succeeds |

## Not Covered Here

- Collaborative text merge (Yjs, V1). The Long Text scenarios describe the MVP behavior that
  replaces it, per FR-012 in `freeze-decisions.md`.
- Presence, cursors, typing indicators (V1).
- Attachment binary synchronization — feature 05.
- Which visibility rules exist. Feature 04 defines them; this feature enforces them, and the
  scenarios here assert enforcement rather than the rule set.

## Downstream Decisions and Remaining Blockers

`_db.md` and `_techspec.md` settle hold expiry (120 seconds, renewed every 30 seconds), queue/tombstone
capacity behavior, mutation-envelope causal order, conflict resolution, and watermark retention.

Two blockers remain explicit in `_tasks.md`: ratify the provider-neutral revocation/purge contract,
and document/prove the browser/device performance matrix including the IndexedDB-backed fallback.
