# TechSpec: Platform Foundation and Shared Contracts

Source: `.speckit/features/00-platform-foundation/_prd.md`.
Related: `.speckit/features/_index.md` (Definition of Ready, track split, independence rules).
No `_bdd.md`, `_domain.md`, or `_db.md` — this feature has no user-observable behavior, no domain
rules, and owns no persistence.

## Executive Summary

The smallest thing that lets three developers work in parallel without colliding: two published
packages, minimal application shells, CI, an architecture guard, and a throwaway spike.

Feature 00 ships no runtime behavior. Its deliverable is a frozen contract surface plus evidence
that the assumptions twenty features are about to be written against actually hold. Everything
here is judged by one question: does it let a developer build a feature without reading another
developer branch.

Two constraints shape every decision below:

- `packages/contracts` must stay types and validators only. The moment it holds behavior, every
  feature change becomes a three-way merge, which is the failure this feature exists to prevent.
- The spike must be able to invalidate the contracts *before* the freeze tag. It is sequenced
  in parallel with contract drafting, not after it.

## Current State

Verified facts about the repository as it stands:

- Not a git repository. `git init` is a prerequisite for CI and for the freeze tag.
- No code. No `package.json`, no source tree, no lockfile, no CI configuration.
- Present: `AGENTS.md`, `CLAUDE.md`, `PRD.md`, `docs/` (`SPEC_GUIDELINE.md`, `AGENT_KIT.md`,
  `KIT_CHANGELOG.md`), `agent-kit/`, `.agents/skills/`, `.claude/skills/`,
  `.speckit/features/` (21 PRDs plus the index).
- Stack decisions are already recorded in `PRD.md` s.91 and `docs/SPEC_GUIDELINE.md`. This
  techspec does not re-open them.

Everything below is proposed, not existing.

## Proposed Architecture

Create only what a wave-0 or wave-1 feature needs. `PRD.md` s.64 lists the full eventual monorepo;
creating those directories now would produce fifteen empty packages nobody owns.

```text
apps/
├── api/            Fastify shell, health route only
└── web/            React + Vite + PWA shell

packages/
├── contracts/      TypeBox shapes + validators. Zero runtime dependencies beyond TypeBox.
├── fixtures/       Sandbox campaign, fixture character schema, fixture rules tree.
└── config/         Shared tsconfig, Biome config, test config.

tools/
└── guard/          Architecture guard, runs in CI.

spike/              Throwaway. Deleted at the freeze tag.
```

Every other package and every `systems/` entry is created by its owning feature, in its own wave.

Dependency rules, enforced by `tools/guard`:

- `packages/contracts` depends on TypeBox only. Not on Fastify, React, PowerSync, PostgreSQL,
  MinIO, or any other package in the repository.
- `packages/fixtures` depends on `packages/contracts` only.
- `apps/*` may depend on packages. Packages must not depend on apps.

## Interfaces and Contracts

The frozen surface. Expressed in TypeBox so the runtime validator and the TypeScript type stay
aligned (`docs/SPEC_GUIDELINE.md`, validation).

### Core shapes

| Contract | Shape | Consumed by |
| --- | --- | --- |
| `Visibility` | `gm_only` \| `everyone` \| `party` \| `players`, with `partyIds?`, `playerIds?` | 04 and every content feature |
| `Role` | `owner` \| `gm` \| `assistant_gm` \| `player` \| `observer` | 01, 04 |
| `ActorRef` | `userId`, `role`, `campaignId` | every authorized operation |
| `EntityEnvelope` | `id`, `campaignId`, `type`, `name`, `tags[]`, `metadata`, `visibility`, `version:int`, `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `deletedAt?` | 15, 16, 17, 18, 19 |
| `ApiError` | `code`, `message`, `details?` | every HTTP boundary |
| `Result<T, E>` | discriminated union, business failures without exceptions | 03, 04, 10, 11 |
| `SemanticOp` | `delta` \| `set` \| `clamp`, with `path`, `value`, `reason?` | 11, 15, 19 |
| `AttachmentRef` | `attachmentId`, `mime`, `size`, `status` | 05, 16, 17 |
| `AuditEvent` | `actor`, `action`, `targetType`, `targetId`, `before?`, `after?`, `at`, `campaignId`, `sessionId?`, `private:boolean` | 06, every mutating feature |
| `SystemRef` | `systemId`, `version` | 02, 08 |
| `CapabilityKey` | branded string, closed registry owned by 08 | 08, 15, 18, 19 |

`version` and `deletedAt` on `EntityEnvelope` are not optional design choices. Feature 03 cannot
retrofit conflict detection or tombstones onto records that never carried them, so every
persisted entity carries both from the first commit.

### Repository contract

`SyncedRepository<T>` with `get`, `list`, `upsert(value, expectedVersion)`,
`softDelete(id, expectedVersion)`. A stale `expectedVersion` returns a typed conflict through
`Result`, never an overwrite.

### Registry contracts

Three registries, each with one host feature and many independent contributors. This is the
mechanism that keeps features 07, 20, and 18 from depending on the features they aggregate.

| Registry | Host | Contributors |
| --- | --- | --- |
| `ExportableModule` — `moduleId`, `export(campaignId)`, `import(chunk)` | 07 | 05, 06, 15, 16, 17, 18, 19 |
| `SearchIndexer` — `moduleId`, `index(campaignId): SearchDoc[]` | 20 | 14, 15, 16, 17 |
| `SessionQuickAction` — `id`, `label`, `capability?`, `invoke()` | 18 | 16, 17, 19, later clocks |

`SearchDoc`: `id`, `type`, `title`, `body`, `campaignId`, `visibility`.

### Local reference implementation

`packages/contracts` also ships an in-memory `SyncedRepository` implementation.

This is implied by the wave plan rather than stated in the PRD, and it is made explicit here
because it is what lets waves 1 and 2 build before feature 03 exists. It is a test and development
double, not a product path: no persistence across process restart, no sync, no network. Feature 03
replaces it, and consuming features change one import.

### Decisions recorded at freeze

Two values published alongside the types, per PRD FR-012 and FR-013:

- Long-text concurrency for MVP: single-writer, or optimistic concurrency with the shared conflict
  surface. Yjs stays V1 either way (`PRD.md` s.57).
- Local database size budget for a typical synchronized campaign. Features 03, 06, and 09 each
  pick their own retention inside it, independently.

## API

Effectively N/A. The Fastify shell exposes one unauthenticated health route so that the app shell,
the build, and the container stack can be verified end to end. It carries no domain data.

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/health` | none | — | `{ status, version }` |

Feature 01 adds the first real route and the authentication boundary.

## Authorization and Visibility

N/A as behavior. Feature 00 publishes the `Role`, `Visibility`, and `ActorRef` shapes and nothing
that enforces them. Enforcement is feature 01 (identity) and feature 04 (decision and sync rules).

One forward constraint the contracts encode: `Visibility` is a required field on
`EntityEnvelope`, not an optional one. A record with no visibility cannot be created, which
removes the most likely path to an accidental leak before any feature is written.

## Data and Persistence

- Source of truth: none. Feature 00 owns no tables and no migrations.
- Persistence changes: none. The local development stack provisions PostgreSQL and MinIO so that
  features 03 and 05 do not each invent their own, and so the spike has somewhere to write.
- `_db.md`: not required.

## Offline and Synchronization

- Offline behavior: N/A for this feature.
- Sync strategy: N/A. Feature 00 publishes `SyncedRepository` and the in-memory double; feature 03
  implements the real one.
- Conflict strategy: the contract mandates optimistic concurrency via `expectedVersion` and
  semantic operations via `SemanticOp` (`PRD.md` s.57, s.80). Enforcing them is feature 03; making
  them unavoidable is this feature, by putting `version` in the envelope and a required
  `expectedVersion` in the repository signature.

## Realtime

N/A. Ephemeral realtime is V1 (`PRD.md` s.56).

## Blob Storage

N/A as behavior. MinIO runs in the local development stack for feature 05. Feature 00 publishes
`AttachmentRef` and nothing else.

## Error Handling

| Failure mode | Behavior |
| --- | --- |
| Contract validation fails | Typed validation error naming the field path. Never a partial object. |
| Fixture fails its own contract validation | CI fails. A fixture that does not validate is worse than no fixture, because features build against it. |
| Architecture guard finds a violation | CI fails with the offending file and rule. |
| Spike cannot complete the sync round trip | Not an error. It is the go/no-go output, and it blocks the freeze tag pending a contract redraft. |
| Business failure in consuming features | `Result`, not exceptions (`docs/SPEC_GUIDELINE.md`). |

## Observability

Minimal and deliberately so. Feature 00 has no runtime to observe.

- Logs: Fastify shell request logging, default configuration.
- Metrics: none. Feature 18 owns the first real measurement, the `PRD.md` s.79 cold-start budget.
- Traces: none.

## Testing Strategy

- **Unit**: every contract validator against valid and invalid payloads. Reject-path coverage
  matters more than accept-path here, since these validators are the boundary that keeps invalid
  data out of the domain (`PRD.md` s.16).
- **Integration**: fixtures validate against the contracts they claim to satisfy. The in-memory
  `SyncedRepository` double is tested for the conflict path specifically, because every feature in
  waves 1 and 2 depends on that behavior being right.
- **Architecture**: guard tests with fixtures that should fail — a file referencing a system
  identifier outside `systems/`, a cross-feature internal import, a package importing an app.
  A guard that has never failed has not been tested.
- **E2E**: N/A. No user flow exists yet. Playwright arrives when a feature has one.

## Implementation Sequence

Ordered by dependency, and parallelizable across the three developers who are all on this feature.

1. Repository and tooling baseline. Blocks everything.
2. In parallel from there:
   - **Contracts path**: core shapes, then repository and registry contracts, then the in-memory double.
   - **Environment path**: local stack (PostgreSQL, MinIO), then the spike.
   - **Scaffolding path**: CI, application shells, fixtures, architecture guard.
3. Reconcile: spike results against the contract draft. A `no-go` redrafts `SyncedRepository`.
4. Record the freeze decisions, write the concurrency ADR, tag.

## Impacted Areas

Everything is new. No existing code is modified.

- `package.json`, `bun.lock`, workspace configuration, `.gitignore` — new
- `packages/config/`, `packages/contracts/`, `packages/fixtures/` — new
- `apps/api/`, `apps/web/` — new
- `tools/guard/` — new
- `spike/` — new, deleted at freeze
- CI workflow, `CODEOWNERS` — new
- `.speckit/features/00-platform-foundation/adrs/` — new

`PRD.md` and the twenty other feature PRDs are not modified by this work.

## Risks and Tradeoffs

- **Freezing contracts on day three, before any feature has exercised them.** Accepted
  deliberately: the alternative is three developers waiting or three developers inventing
  incompatible primitives. Mitigated by keeping the contract-change process cheap and same-day
  (PRD FR-008), and by the spike being able to invalidate the largest contract before the tag.
- **The in-memory repository double diverging from feature 03 behavior.** If the double is more
  permissive than the real implementation, waves 1 and 2 build against behavior that does not
  exist. Mitigated by testing the double specifically on the conflict path, which is where
  divergence would hurt.
- **`packages/contracts` accreting behavior.** The failure is gradual and only visible once every
  change is a three-way merge. Mitigated by the guard and by review, not by good intentions.
- **Fixtures shaped like Cairn or Fate.** Would let Track C build hidden system assumptions that
  pass every test until wave 3. Mitigated by the fixture schema being deliberately neither
  (PRD FR-005).
- **Scope creep into P1.** `FR-101` and `FR-102` are explicitly not part of the freeze gate. If
  wave 0 threatens three days, they are the cut.

## ADRs

One decision here is durable, has a live alternative, and is about to constrain twenty features.
Write it during wave 0, in `adrs/`:

- **ADR-001: Optimistic concurrency with an explicit version field, plus semantic operations for
  counters.** Alternative is last-write-wins, which is simpler, is what most sync layers default
  to, and silently violates `PRD.md` s.80. The reasoning needs to survive the first developer who
  finds `expectedVersion` inconvenient.

Not worth an ADR now: the stack choices, already recorded in `PRD.md` s.91 and
`docs/SPEC_GUIDELINE.md`; the feature-owned-data split, already recorded in `_index.md`.

## Open Questions

Resolved during wave 0 by the developers, not blocking this techspec:

- TODO: Bun Workspaces alone, or Bun Workspaces plus Turborepo. `docs/SPEC_GUIDELINE.md` permits
  either "when present"; nothing is present. Affects CI wiring only.
- TODO: Vitest or Bun Test. Guideline permits either when consistent with existing configuration,
  and there is no existing configuration.
- TODO: Seed values for the `CapabilityKey` registry. Feature 08 owns the union and fills it in
  wave 1; wave 0 needs only the branded type so consumers compile.
- TODO: Concrete value for the local database size budget (FR-013). Needs the fixture campaign
  measured, so it lands late in wave 0 rather than early.
