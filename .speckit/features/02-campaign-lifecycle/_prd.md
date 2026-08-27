# PRD: Campaign Lifecycle

Source: `PRD.md` s.1, s.7, s.8, s.9, s.28, s.49, s.66, s.78, s.88.
Track: A. Depends on: contracts from feature 00, `SystemSummary` and `SystemRef` from feature 08.

## Problem

The whole product opens with one flow: add an RPG, choose a system, choose a game mode, choose
options, create a campaign (`PRD.md` s.1, s.7). Today that flow does not exist, and the campaign
record it produces is what every other feature scopes itself to. Without it, twenty features have
no container and no way to answer "which system is this campaign playing, at which version".

The second half of the problem is version stability. A campaign that silently follows a system
update changes its own rules mid-play. `PRD.md` s.66 requires pinning; nothing enforces it yet.

## Goals

- A GM goes from empty account to a created campaign inside the 10 minute activation budget
  (`PRD.md` s.78).
- A campaign pins `system-id@version` and never changes it without an explicit human decision.
- Every other feature resolves campaign context, system reference, and enabled modules through
  one published API.
- System selection presents honest integration status, so a GM knows what is supported before
  committing a campaign to a system (`PRD.md` s.9).

## Non-Goals

- Authoring or validating system packages. Feature 08 owns the manifest and the registry.
- Any system-specific configuration logic. Options are declared by the system package and
  rendered generically.
- Module implementations. MVP pins module identifiers; no module engine is built (`PRD.md` s.50 is V2).
- Campaign templates, duplication, or archiving beyond soft delete.
- Party or character creation. Feature 15 owns characters; this feature only records party membership intent.

## Users and Context

### Primary user

A game master starting a new campaign, usually before session zero, often while comparing two
systems they have not run before.

### Secondary users

Players, who see campaign identity and their own membership context but do not configure it.

## User Stories

- As a GM, I want to browse and search available systems with their support level, so that I do
  not discover a gap after three sessions.
- As a GM, I want to read the rules of a system before selecting it, so that selection is informed
  (`PRD.md` s.8).
- As a GM, I want a guided creation flow, so that I do not have to know the platform vocabulary.
- As a GM, I want my campaign pinned to a system version, so that an update never changes my
  rules mid-campaign.
- As a GM, I want to review what changed before updating a system version, so that the decision
  is deliberate.
- As a GM, I want to edit campaign details later, so that a working title is not permanent.

## Functional Requirements

### P0 — MVP

- FR-001: Campaign creation wizard with the steps in `PRD.md` s.7: choose system, choose game
  mode, configure system, choose modules, campaign details, party, review, create. Steps whose
  system declares nothing to configure are skipped rather than shown empty.
- FR-002: System selection screen (`PRD.md` s.8): list, text search, per-system card showing name,
  short description, documentation status, complexity, a rules entry point, and a select action.
- FR-003: Integration status displayed per system from the manifest (`PRD.md` s.9): mechanics
  supported, character sheet supported, rules text integrated, compendium integrated, external
  documentation. Mechanical support must not be presented as documentation rights.
- FR-004: Game mode selection from the modes the chosen system declares (`PRD.md` s.49). MVP set
  is whatever the MVP system packages declare; this feature adds no mode of its own.
- FR-005: System options configuration rendered generically from the option declarations in the
  system package. No option is known by name to this feature.
- FR-006: Module selection from modules declaring compatibility with the chosen system. MVP records
  the selection and pins it; no module behavior is executed.
- FR-007: Campaign details: name, description, and nothing else until a need appears.
- FR-008: Campaign persistence with `system-id@version` pinned at creation (`PRD.md` s.66).
- FR-009: Campaign list for the current user, scoped by membership (feature 01).
- FR-010: Campaign read, update of details and settings, and soft delete by `owner`.
- FR-011: System version update flow (`PRD.md` s.66): when a newer version of the pinned system
  exists, offer review changes, update, keep current. Update never happens automatically.
- FR-012: A published module API returning campaign context (`campaignId`, `SystemRef`, game mode,
  enabled module ids, settings) for every other feature. This is the only supported source of it.
- FR-013: Campaign settings storage as a namespaced key-value area, so a feature stores its own
  campaign-scoped setting without a schema change owned by another feature.

### P1 — Important

- FR-101: Filters on the system selection screen (`PRD.md` s.8): genre, complexity, narrative focus,
  tactical focus, lethality, dice used, solo, GM-less, integrated documentation, language.
- FR-102: Campaign cover image and colour identity.
- FR-103: Change of game mode after creation, where the system permits it.

### P2 — Later

- FR-201: Campaign templates and duplication (`PRD.md` s.72).
- FR-202: Migration assistance when updating across a breaking system version.

## Behavioral Constraints

- No branch on system identity anywhere in this feature (`PRD.md` s.89). The wizard renders what
  the manifest declares. A hard-coded system name fails review.
- System version is pinned at creation and changes only through FR-011. Nothing else writes it.
- Campaign creation is a single atomic outcome. A partially created campaign is never persisted.
- Campaign creation must succeed offline for a system package already available locally, and
  synchronize afterwards (`PRD.md` s.76). Invitations require connectivity and are queued.
- Access to any campaign read or write is decided by feature 04 using membership from feature 01.
- Deleting a campaign is a soft delete with a tombstone (`PRD.md` s.57), never a hard delete.

## Data and Privacy Considerations

- Campaign name and description are user content and may contain private table information.
  They are visible only to members.
- The campaign record stores module and system identifiers, never copies of system content.
- Campaign creation, deletion, member-visible setting changes, and system version updates emit
  `AuditEvent` records (feature 06).
- The campaign record is the root of the export unit in feature 07.

## Success Signals

- `PRD.md` s.78 activation: account creation to started session under 10 minutes for a new user,
  with campaign creation itself under 3 minutes.
- A GM can state, from the selection screen alone, whether a system has integrated rules text,
  without opening the system.
- Zero campaigns in test data with an unpinned or drifting system version.
- No feature other than this one reads the campaign table, verified by the guard in feature 00 FR-009.

## Rollout

Wave 2, Track A. Until it ships, other features scope to the fixture campaign from feature 00.
The published context API in FR-012 is the swap point, so consuming features change one import.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Wizard grows system-specific special cases | Breaks the central architectural criterion `PRD.md` s.89 | Guard test from feature 00 FR-009; option rendering driven only by manifest declarations |
| System registry shape not final when the wizard is built | Rework in the wizard | Build against `SystemSummary` fixtures; feature 08 freezes the summary shape in wave 1 |
| Module pinning built before any module exists | Speculative generality | MVP stores identifiers only, no engine, no lifecycle, no hooks |
| Campaign settings key-value area becomes a dumping ground | Untyped shared state | Namespaced per feature; each owning feature validates its own namespace with TypeBox |

## ADR Candidates

- System version pinning with explicit opt-in update, versus automatic update (`PRD.md` s.66).
  Registered in `PRD.md` s.91 context; worth an ADR because the alternative is plausible and the
  consequence is durable.

## Open Questions

- TODO: What "review changes" shows on a system version update. It depends on whether feature 08
  ships a changelog field in the manifest.
- TODO: Whether party composition at creation (`PRD.md` s.7 step 6) creates character records or
  only invitations. Leaning to invitations only, so this feature does not own character data.
- TODO: Whether a campaign may enable a module after creation in MVP, or only at creation.
