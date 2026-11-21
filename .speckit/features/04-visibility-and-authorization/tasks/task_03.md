# Task 03: Versioned visibility mutation service

Status: completed (2026-10-25). Depends on tasks 01–02.

## Scope

- Implement owner-adapter mutation flow, target membership checks, normalization, and expected versions.
- Support additive reveal, idempotent duplicate reveal, and un-reveal to `gm_only` when empty.
- Enqueue audit events through the mutation envelope.
- Add adapter contract and PostgreSQL normalization/concurrency tests.

## Acceptance Criteria

- [x] Non-member targets and unauthorized actors leave records unchanged.
- [x] Concurrent mutations produce explicit conflict and never lose a grant silently.
- [x] Accepted before/after Visibility is normalized and audited once.

## Verification

```bash
bun test packages/authorization
bun run typecheck
```

## Evidence (2026-10-25)

- `bun test packages/authorization` (with `.env`, PostgreSQL integration suite running): 80 pass,
  0 fail, 463 expects, 5 files.
- `bun run typecheck`: 10/10 workspaces exit 0. `bun run check`: 214 files clean.
  `bun run guard`: 178 files, no violations.
- `bun test apps/api packages/sync packages/audit --timeout 30000`: 199 pass, 0 fail.

## Implementation

- `packages/authorization/src/visibility.ts`: `VisibilityService.change(actorUserId, change)` runs
  `_db.md` Visibility Mutation Transaction: resolve Actor (identity `ActorResolver` shape), load
  declaration + owner facts, decide `reveal`, compare expected version, check reveal targets are
  current members (after the decision, so an unauthorized actor learns nothing), set-union or
  set-subtract, normalize (sorted unique, empty targeted -> `gm_only`), then the owner adapter
  writes with a compare-and-set and calls `recordAudit(tx)`, which enqueues the feature 06 event
  through `DurableAuditRecorder.recordWithin` in the same transaction. A duplicate reveal returns
  `unchanged` (no write, version bump, or audit). A conflict is returned, never retried.
- `VisibilityWrite.recordAudit` added to the task 02 adapter contract (`registry.ts`).
- `packages/authorization/src/adapter-test-kit.ts`: `runVisibilityAdapterContract` (10 checks,
  including same-transaction audit rollback and a concurrent single-winner race).
- `visibility.integration.test.ts`: test-scoped PostgreSQL table with the `_db.md` standard columns
  and CHECK constraints (created and dropped per run), the reference owner adapter, real feature 06
  stores.

## Gaps

- No content-owner table exists, so there is no production adapter and no migration. The first
  reveal-capable owner must ship equivalent CHECK constraints and run the adapter contract.
- Atomicity of audit relies on the adapter calling `recordAudit`; if it does not, the service
  records post-commit with the same origin ID and signals `auditOutsideTransaction`.
- Party targets always reject (`party_unresolved`) until a party resolver exists (P1).
- Audit target visibility for visibility-change events is `gm_only` (plus `authorUserId` under an
  Ownership Rule) until feature 06 task 03 defines history read rules.
- HTTP route and public error collapse are task 04.
