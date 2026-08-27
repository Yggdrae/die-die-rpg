# PRD: Platform Foundation and Shared Contracts

Source: `PRD.md` s.4, s.16, s.61, s.62, s.63, s.64, s.75, s.82, s.91.
Track: shared. Owner: all three developers, then frozen.

## Problem

Three developers must build twenty features in parallel on an empty repository. Every feature
in the source PRD touches the same primitives: an entity with visibility and a version, a role,
a roll, a formula, an attachment reference, an audit event. If each developer defines those
locally, the first integration collapses into a rewrite. If one developer defines them while
the other two wait, the team runs at one third speed.

The foundation exists to remove that choice: define the shared vocabulary once, freeze it,
and let every other feature proceed without reading another feature branch.

## Goals

- Every other feature PRD in `.speckit/features/` is startable on day 3 without depending on
  an unfinished feature.
- A feature can be developed, tested, and demonstrated against fixtures alone.
- Zero business logic lives in this feature. Contracts and scaffolding only.
- Contract breakage after freeze is a visible, reviewed event, not a silent merge conflict.

## Non-Goals

- Any domain rule, any system rule, any UI screen.
- Sync implementation. This feature only publishes the repository contract; feature 03 implements it.
- Auth implementation. This feature only publishes `ActorRef` and `Role`; feature 01 implements them.
- A shared "core" package that grows into a god module. Contracts are types and validators only.
- Generic abstractions with a single planned implementation, beyond the three named registries.

## Users and Context

### Primary user

The three developers. The foundation is developer-facing infrastructure with no end-user surface.

### Secondary users

Future system authors and content authors (`PRD.md` s.6) inherit these contracts. That is a
consequence, not a requirement to design for now.

## User Stories

- As a developer, I want the shared entity and visibility shape frozen, so that my feature and
  a teammate feature persist compatible records without a meeting.
- As a developer, I want fixture data for a full campaign, so that I can build and test my UI
  before the backend for it exists.
- As a developer, I want a written contract-change process, so that a teammate cannot silently
  break my feature.
- As a developer, I want CI gates from commit one, so that integration failures surface in
  minutes rather than at the end of a wave.

## Functional Requirements

### P0 — MVP

- FR-001: Monorepo skeleton per `PRD.md` s.64: `apps/web`, `apps/api`, `packages/*`, `systems/*`.
  Directories are created only when a feature needs them. Empty placeholder packages are not created.
- FR-002: Runtime and tooling wired per `docs/SPEC_GUIDELINE.md`: Bun, strict TypeScript, Biome,
  test runner, React + Vite + PWA shell, Fastify app shell, TypeBox.
- FR-003: `packages/contracts` publishes the frozen shared contracts, expressed in TypeBox so
  runtime validation and TypeScript types stay aligned:
  - `EntityEnvelope`: `id`, `campaignId`, `type`, `name`, `tags[]`, `metadata`, `visibility`,
    `version` (integer, optimistic concurrency), `createdAt`, `createdBy`, `updatedAt`,
    `updatedBy`, `deletedAt` (tombstone).
  - `Visibility`: `gm_only` | `everyone` | `party` | `players`, with `partyIds` / `playerIds`.
  - `Role`: `owner` | `gm` | `assistant_gm` | `player` | `observer`.
  - `ActorRef`: `userId`, `role`, `campaignId`.
  - `ApiError`: `code`, `message`, `details?`. Single HTTP error shape, no internal leakage.
  - `Result<T, E>` for business failures.
  - `SemanticOp`: `delta` | `set` | `clamp` with `path`, `value`, `reason?`, for counter and
    resource mutation (`PRD.md` s.57).
  - `SyncedRepository<T>`: `get`, `list`, `upsert(expectedVersion)`, `softDelete(expectedVersion)`.
  - `AttachmentRef`: `attachmentId`, `mime`, `size`, `status`.
  - `AuditEvent`: `actor`, `action`, `targetType`, `targetId`, `before?`, `after?`, `at`, `private`.
  - `SystemRef`: `systemId`, `version`. Full manifest shape is owned by feature 08.
- FR-004: Three registry contracts, each with exactly one host and many independent contributors:
  - `ExportableModule` for feature 07;
  - `SearchIndexer` and `SearchDoc` for feature 20;
  - `SessionQuickAction` slot for feature 18.
- FR-005: `packages/fixtures` publishes the sandbox campaign "The Missing Caravan"
  (`PRD.md` s.82): 5 locations, 6 NPCs, 5 items, party of 2, one GM, two players, plus a
  fixture character schema and fixture rules tree that are deliberately not Cairn or Fate.
  A feature must be demonstrable against fixtures with no other feature implemented.
- FR-006: CI gates on every pull request: Biome check, typecheck, unit tests, build.
- FR-007: Code ownership file mapping each feature directory to its track, so a cross-feature
  change requires cross-track review.
- FR-008: Contract freeze process. After the foundation wave, a change to `packages/contracts`
  requires a dated contract-change note in this feature directory naming the reason, the
  affected features, and the migration, plus approval from one developer per track within one
  working day.
- FR-009: Architecture guard test: a repository-wide check that fails the build when a file
  outside `systems/` or `packages/fixtures` references a concrete system identifier
  (`PRD.md` s.89), and when a feature directory imports internals of another feature directory.
- FR-010: Local development environment: PostgreSQL and MinIO available through a single
  documented command, since features 03 and 05 need them and nobody should invent their own.
- FR-011: Feasibility spike inside this wave. Throwaway code, two questions to answer:
  - Sync: prove that a record written offline in SQLite/WASM reaches PostgreSQL through PowerSync
    and back. Output is a go/no-go on the `SyncedRepository` contract before twenty features are
    written against it.
  - Search: prove whether SQLite/WASM as configured provides usable full-text search. Features 14
    and 20 both depend on it, and a `no` found in wave 4 costs a redesign of both. A `no` is an
    acceptable answer; it moves both features to a simpler prefix index.
- FR-012: Long-text concurrency decision for MVP, recorded with the contracts: single-writer, or
  optimistic concurrency with the shared conflict surface. It is `SyncedRepository` semantics, so
  it is settled here rather than negotiated later between features 03, 15, and 16. Yjs remains V1
  either way (`PRD.md` s.57).
- FR-013: Local database size budget for a typical synchronized campaign, published with the
  contracts. Features 03, 06, and 09 each choose their own retention policy inside it and never
  need to agree with each other. The budget exists because the `PRD.md` s.79 cold-start target
  is measured against total local database size, and three features growing independently is the
  way that target is missed.

### P1 — Important

- FR-101: Shared UI primitives package for tokens, layout, and form controls, extracted from
  real duplication after two features exist. Not written speculatively.
- FR-102: Seed command that loads the sandbox campaign into a running local stack.

### P2 — Later

- FR-201: Contract versioning and deprecation policy, once an external system author exists
  (`PRD.md` s.73).

## Behavioral Constraints

- Contracts contain no behavior. A validator and a type are allowed; a decision is not.
- `packages/contracts` must not depend on Fastify, React, PowerSync, PostgreSQL, or MinIO
  (`docs/SPEC_GUIDELINE.md`, architecture).
- Every structured entity carries `version`. Any update path that ignores `expectedVersion`
  is a defect, because feature 03 cannot retrofit conflict detection onto records that never had it.
- Every deletable entity carries `deletedAt`. Hard deletes are not part of the synced model
  (`PRD.md` s.57).
- Fixtures are deliberately disposable and must not resemble a real campaign (`PRD.md` s.81).

## Data and Privacy Considerations

- Fixture data contains no real user data and no content from a real campaign.
- `AuditEvent.private` exists from day one so feature 06 can separate the GM-private log without
  a later migration (`PRD.md` s.67).
- No credential or token shape is defined here; feature 01 owns them.

## Success Signals

- Day 3: every other feature PRD can start; no feature lists another unfinished feature as a blocker.
- A new feature branch renders its UI against fixtures with the API stack stopped.
- Contract-change notes after freeze: fewer than one per week. A higher rate means the freeze
  happened too early and the wave plan needs a pause, not more notes.
- Integration merges do not produce entity-shape conflicts.

## Rollout

Single wave, all three developers together, target 2 to 3 working days. Freeze is a commit tag,
announced. Parallel feature work starts immediately after the tag. The spike in FR-011 runs in
parallel with contract drafting and can invalidate FR-003 `SyncedRepository` before freeze.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Contracts frozen too early, wrong shape | Twenty features carry a bad primitive | FR-011 spike before freeze; contract-change process kept cheap and same-day |
| Foundation grows into a shared god package | Every change becomes a three-way merge | Contracts are types and validators only; FR-009 guard; behavior lives in features |
| Fixtures diverge from real system packages | Track C builds against a schema shape nobody ships | Fixture schema validated by the same validator feature 08 ships; fixture is not Cairn or Fate, so shape coupling stays honest |
| Wave 0 slips past 3 days | The whole plan slips | Cut FR-101 and FR-102; ship contracts, fixtures, CI, spike only |
| PowerSync assumption fails | Feature 03 redesign, contracts change late | FR-011 spike; `SyncedRepository` deliberately provider-neutral (`PRD.md` s.55) |
| SQLite/WASM full-text search unavailable | Features 14 and 20 both redesigned in wave 4, the latest possible moment | FR-011 spike answers it in wave 0; prefix index is a viable fallback for both |
| Three features grow local storage independently | `PRD.md` s.79 cold-start target missed with no single feature at fault | Size budget published at freeze (FR-013); 03, 06, 09 pick retention inside it |

## ADR Candidates

`PRD.md` s.91 already registers the stack decisions and states they may become ADRs during
tech spec work. Write ADRs only for the decisions that have a live alternative at that point:

- Optimistic concurrency with an explicit `version` field on all structured entities, versus
  last-write-wins (`PRD.md` s.57, s.80).
- Semantic operations for counters and resources, versus absolute writes.
- Feature-owned data with no cross-feature table access, versus a shared schema.

## Open Questions

- TODO: Bun Workspaces alone, or Bun Workspaces plus Turborepo. `docs/SPEC_GUIDELINE.md` allows
  either "when present"; nothing is present yet. Decide in wave 0, it affects CI wiring only.
- TODO: Test runner choice, Vitest or Bun Test. Guideline allows either when consistent.
- TODO: Exact `CapabilityKey` union seed values. Feature 08 owns the union; wave 0 needs only
  the branded type so consumers compile.
