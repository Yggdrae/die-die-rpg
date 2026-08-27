# PRD: Campaign Import and Export

Source: `PRD.md` s.65, s.66, s.68, s.88.
Track: A. Depends on: `ExportableModule` registry contract from feature 00. Every content-owning
feature contributes its own serializer.

## Problem

A campaign represents months of preparation. If it exists only inside one deployment of this
application, the GM has handed their work to a product that might change, break, or disappear.
`PRD.md` s.65 names the four reasons this matters: backup, sharing, migration, preservation.

The dependency trap is obvious: an export feature that knows how to serialize characters,
entities, handouts, sessions, and encounters is a feature that depends on five other features
and blocks on all of them. Inverting it removes the block entirely.

## Goals

- A GM exports a campaign to a single portable file and can restore it.
- Export completeness grows as features land, without this feature changing.
- The exported file records the pinned system and module versions, so a restored campaign plays
  by the same rules (`PRD.md` s.66).
- No feature waits on this one, and this one waits on no feature.

## Non-Goals

- A published, stable, documented interchange format for third parties. MVP is basic
  (`PRD.md` s.68 says import/export basic).
- Cross-system conversion. A Cairn campaign does not import as Fate.
- Marketplace or content distribution (`PRD.md` s.73).
- Selective or partial export in MVP. Whole campaign only.
- Merging an import into an existing campaign. Import creates a new campaign.

## Users and Context

### Primary user

A GM who wants a backup before a risky change, or who is moving between deployments, or who
wants to hand a prepared campaign to another GM.

### Secondary users

The development team, which gains a reproducible way to move a real campaign into a test
environment, and future preservation of user work.

## User Stories

- As a GM, I want to export my campaign to a file, so that my preparation is mine.
- As a GM, I want to import that file and get my campaign back, so that the backup is real
  rather than theoretical.
- As a GM, I want the export to record which system version it used, so that an import does not
  silently change my rules.
- As a GM, I want to be told what an import could not restore, so that I know what to redo.
- As a developer, I want to contribute my feature data to the export without touching the export
  feature, so that neither of us blocks the other.

## Functional Requirements

### P0 — MVP

- FR-001: `.rpgpack` container per `PRD.md` s.65 with `manifest.json`, `campaign.json`,
  `entities/`, `documents/`, `attachments-manifest/`, `system.lock`, `modules.lock`.
- FR-002: `manifest.json` records format version, application version, export timestamp, exporting
  user, and the list of contributing modules with their chunk versions.
- FR-003: `ExportableModule` registry: each content-owning feature registers a serializer and a
  deserializer for its own data, keyed by module id. This feature orchestrates and never reads
  another feature data model.
- FR-004: Export produces a single downloadable file for a campaign the actor owns or game-masters.
- FR-005: `system.lock` and `modules.lock` record the pinned `system-id@version` and module
  versions from feature 02 (`PRD.md` s.66).
- FR-006: Import validates the manifest with TypeBox before any write (`PRD.md` s.16). An invalid
  package is rejected whole; nothing partial enters the domain.
- FR-007: Import creates a new campaign owned by the importing user, with new identifiers, and
  reports what was restored per module.
- FR-008: Import reports unknown module chunks and unavailable system versions as explicit warnings
  rather than failing silently or discarding data without saying so.
- FR-009: Visibility values are preserved through export and import, so a restored secret is still
  a secret (`PRD.md` s.34).
- FR-010: Credentials, tokens, sessions, and other user secrets are never exported (feature 01).
- FR-011: Attachments are exported as a manifest with checksums and metadata (`PRD.md` s.65).
  Binary inclusion is decided in the open question below.
- FR-012: Export runs against locally synchronized data where possible, so a GM can back up
  before a session without connectivity.

### P1 — Important

- FR-101: Binary attachment inclusion as an option, with a size warning.
- FR-102: Import into an existing campaign for selected modules.
- FR-103: Import preview showing counts per module before committing.

### P2 — Later

- FR-201: A documented, versioned public format with a compatibility policy.
- FR-202: Migration of a package across a breaking system version (`PRD.md` s.66).

## Behavioral Constraints

- This feature contains zero knowledge of characters, entities, handouts, sessions, or encounters.
  Any type from another feature appearing here is a design failure.
- Import is all-or-nothing at the campaign level. A failure leaves no partial campaign.
- Package content is untrusted input and is validated strictly, like a system package
  (`PRD.md` s.75). Import must not be a path around validation or authorization.
- A module chunk the current application version does not recognize is preserved in the file and
  reported, not silently dropped, so a round trip through a newer version does not destroy data.
- Import does not resurrect membership. Members are re-invited through feature 01.
- Export of a campaign requires GM or owner role; a player cannot export a campaign.

## Data and Privacy Considerations

- An export contains everything the campaign holds, including GM-only secrets. Handing the file
  to a player hands them the secrets. The interface must state this plainly at export time.
- Exports contain user content and identifiers of members; member personal data is limited to
  display identity, never credentials or email where avoidable.
- An exported file has no access control once it leaves the application. That is the point, and
  it is also the risk.
- Audit log inclusion is an open question, since it contains actor history.

## Success Signals

- A campaign in the validation set exports and imports with equal entity counts per module and
  no visibility downgrades.
- A GM completes an export in under 1 minute for a typical campaign.
- Adding a new content feature requires zero changes in this feature to be included in the export.
- `PRD.md` s.88 acceptance: the GM can export a campaign.

## Rollout

Wave 4, Track A, deliberately last. The registry contract is frozen in wave 0, so features
implement their serializer while they build, not afterwards. This feature ships whenever it ships
and picks up whatever has registered; nothing is blocked either way.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Export knows about other feature internals | This feature blocks on five others and breaks on their changes | `ExportableModule` registry (FR-003); architecture guard from feature 00 FR-009 |
| Import used as a path around authorization or validation | Untrusted data enters the domain | Strict TypeBox validation before write (FR-006); import runs as the importing user with normal permissions |
| Partial import leaves a broken campaign | User loses trust in backup entirely | All-or-nothing at campaign level (FR-006, FR-008) |
| Unknown module chunks dropped on round trip | Silent data loss through a newer export | Preserve and report unknown chunks (FR-008) |
| GM shares an export not knowing it contains secrets | Campaign spoiled | Explicit warning at export; contents summary before download |
| Large attachment binaries make exports unusable | Feature is technically present and practically unused | Manifest-only default (FR-011), binaries opt-in in P1 |

## ADR Candidates

- Registry-based export contribution, versus a central serializer that knows all features. The
  alternative is simpler to write and is what creates the dependency the team is trying to avoid.

## Open Questions

- TODO: Whether binaries are included in `.rpgpack` or only referenced by manifest.
  `PRD.md` s.65 lists `attachments-manifest/`, which reads as manifest only; confirm before FR-011.
- TODO: Whether the audit log (feature 06) is part of the export.
- TODO: Container format and compression for `.rpgpack`.
- TODO: Behaviour on import when the pinned system version is not installed: block, import in a
  read-only state, or offer the nearest version.
