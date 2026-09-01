# BDD: Campaign Import and Export

Source: `_prd.md`, `../00-platform-foundation/_techspec.md`,
`../02-campaign-lifecycle/_bdd.md`, `../04-visibility-and-authorization/_bdd.md`, and
`../05-attachments-and-object-storage/_bdd.md`.

This is intentionally a light BDD. It fixes package safety, atomicity, authorization, portability,
and round-trip behavior without duplicating contributor-specific schemas.

## Export

### Scenario: A GM exports one campaign as one file

**Given** an actor is the campaign `owner` or `gm`  
**When** the actor exports the campaign  
**Then** one `.rpgpack` file is produced  
**And** it contains a manifest, campaign data, system lock, module lock, attachment manifest, and
one versioned chunk for every registered contributing module  
**And** the interface warns that the file contains GM secrets and has no access control after download

### Scenario: A player cannot export a campaign

**Given** an actor is a `player`, `assistant_gm`, `observer`, or non-member  
**When** the actor requests a campaign export  
**Then** no package is produced  
**And** the response does not disclose hidden campaign content

### Scenario: Export uses contributor boundaries

**Given** a new content feature registers an exportable module  
**When** a campaign is exported  
**Then** the module's chunk is included without a change to the export orchestrator  
**And** the orchestrator does not import the feature's internal type or persistence model

### Scenario: Export preserves the pinned rules context

**Given** a campaign is pinned to a system version and module versions  
**When** it is exported  
**Then** `system.lock` and `modules.lock` contain those exact identifiers and versions  
**And** no newer installed version is substituted

### Scenario: P0 attachment export is manifest only

**Given** a campaign has finalized attachments  
**When** it is exported with P0 behavior  
**Then** attachment metadata and checksums are present in the attachment manifest  
**And** attachment binary bytes are absent from the package

### Scenario: Secrets are excluded

**Given** campaign members have credentials, sessions, recovery tokens, invitations, or email metadata  
**When** the campaign is exported  
**Then** none of those secrets or credential records are present  
**And** member identity is limited to the display identity required by exported content

### Scenario: A synchronized campaign can be exported offline

**Given** the complete P0 export dataset for a campaign is available locally  
**And** the device has no network  
**When** a GM exports the campaign  
**Then** the package is produced from local data  
**And** it reports attachment binaries as manifest-only rather than unavailable

## Validation Before Import

### Scenario Outline: Invalid package input changes nothing

**Given** a package has `<defect>`  
**When** a user attempts to import it  
**Then** validation rejects the package before any campaign write  
**And** no campaign, membership, chunk, or object is created

| defect |
| --- |
| malformed container |
| missing required manifest member |
| manifest failing its TypeBox schema |
| duplicate module identifier |
| checksum mismatch |
| path traversal entry |
| entry exceeding a declared limit |

### Scenario: An unavailable pinned system blocks before write

**Given** a valid package pins a system version unavailable to this installation  
**When** a user attempts to import it  
**Then** import stops before any write  
**And** the unavailable system id and version are reported explicitly  
**And** no nearby or newer version is substituted

### Scenario: Unknown chunks are reported and preserved

**Given** a valid package contains a module chunk the installation does not recognize  
**When** the package is imported  
**Then** the import report identifies the unknown module and chunk version  
**And** the opaque chunk is preserved with the new campaign for a later round trip  
**And** the unknown payload is never executed or treated as trusted domain data

## Atomic Import

### Scenario: Import creates a new campaign with a new owner

**Given** a valid package can be restored by every required contributor  
**When** an authenticated user imports it  
**Then** one new campaign is created with new identifiers  
**And** the importing user is its sole `owner`  
**And** original memberships are not restored  
**And** the report states what each module restored

### Scenario: A contributor failure rolls back the whole import

**Given** package validation succeeded  
**And** one registered contributor cannot restore its chunk  
**When** import executes  
**Then** no imported campaign or contributor data remains committed  
**And** the failure report identifies the contributor without exposing internal details

### Scenario: Retrying a completed import does not mutate the first campaign

**Given** a package was imported successfully  
**When** the user deliberately imports the same file again  
**Then** a second new campaign is created  
**And** the first imported campaign is unchanged

## Round Trip

### Scenario: Visibility does not widen

**Given** a campaign contains `gm_only`, `everyone`, and targeted records  
**When** the campaign is exported and imported  
**Then** each restored record has equivalent visibility  
**And** no actor gains access because of the round trip

### Scenario: Contributor counts and versions survive

**Given** a validation campaign has data from registered modules  
**When** it is exported, imported, and exported again  
**Then** each recognized module reports equal logical record counts  
**And** its chunk version remains compatible with the contributor that restored it  
**And** preserved unknown chunks remain byte-for-byte unchanged

### Scenario: Export meets the typical-campaign target

**Given** the agreed typical campaign fixture is fully synchronized  
**When** a GM exports it on the reference device  
**Then** the downloadable package is ready within one minute

## Traceability

| PRD requirement | Covered by |
| --- | --- |
| FR-001 container members | A GM exports one campaign as one file |
| FR-002 manifest metadata | A GM exports one campaign; Contributor counts and versions survive |
| FR-003 registry | Export uses contributor boundaries |
| FR-004 authorization | A GM exports one campaign; A player cannot export |
| FR-005 lock files | Export preserves the pinned rules context |
| FR-006 validation and atomic rejection | Invalid package input; Contributor failure rolls back |
| FR-007 new campaign and report | Import creates a new campaign with a new owner |
| FR-008 unknown/unavailable dependencies | Unavailable pinned system; Unknown chunks |
| FR-009 visibility | Visibility does not widen |
| FR-010 secret exclusion | Secrets are excluded |
| FR-011 attachment manifest | P0 attachment export is manifest only |
| FR-012 offline export | A synchronized campaign can be exported offline |
| Success signals | Contributor counts and versions survive; Export meets target |

## Not Covered Here

- Binary attachment inclusion, selective restore, import preview, public format guarantees, and
  cross-version migrations are later scope.
- Each contributor owns validation and identifier remapping for its chunk. This feature verifies
  the registry contract and campaign-level atomic outcome.
- Audit data is excluded from P0 export. Feature 06 may contribute it when FR-101 is implemented.

