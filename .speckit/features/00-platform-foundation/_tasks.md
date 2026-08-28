# Tasks: Platform Foundation and Shared Contracts

Source: [`_prd.md`](_prd.md), [`_techspec.md`](_techspec.md).
Gate this feature satisfies: the Definition of Ready in [`../_index.md`](../_index.md).

All three developers work this feature together. It is the only wave in the plan where they are
not on separate tracks.

## Task list

| # | Task | Depends on | Owner | Status |
| --- | --- | --- | --- | --- |
| 01 | [Repository and tooling baseline](tasks/task_01.md) | — | agent | done |
| 02 | [CI pipeline](tasks/task_02.md) | 01 | agent | done except branch protection; CI verified red on a deliberate defect (PR #1) |
| 03 | [Contracts: core shapes](tasks/task_03.md) | 01 | agent | done |
| 04 | [Contracts: repository and registries](tasks/task_04.md) | 03 | agent | done |
| 05 | [In-memory SyncedRepository double](tasks/task_05.md) | 04 | agent | done |
| 06 | [Fixtures package](tasks/task_06.md) | 03 | agent | done |
| 07 | [Application shells](tasks/task_07.md) | 01 | agent | done |
| 08 | [Local development stack](tasks/task_08.md) | 01 | agent | done; PostgreSQL 17.11 + MinIO verified healthy, persistence across restart, `wal_level=logical` |
| 09 | [Architecture guard and code ownership](tasks/task_09.md) | 01, 07 | agent | done; `CODEOWNERS` handles are placeholders |
| 10 | [Feasibility spike: sync and search](tasks/task_10.md) | 08 | agent | done; **GO on both**, see [spike-findings.md](spike-findings.md). Forced a contract change (task 04) |
| 11 | [Freeze: decisions, ADR, tag](tasks/task_11.md) | 02, 04, 05, 06, 09, 10 | you | ready — see Remaining below |

Verified: `check` (50 files clean), `typecheck` (5 workspaces), `test` (106 passing), `guard`
(34 files, no violations), and `build` all pass.

## CI, verified

PR #1 proved the pipeline blocks a defect: `bun run check` failed on a deliberate `any`, the
job exited 1, the merge was blocked. Install took 1.3 s and lint 81 ms, so the pipeline is fast
enough to stay in the way rather than be routed around.

That first run stopped at the first failing gate, so only one of the three deliberately broken
gates was demonstrated. Gates now run independently (`if: always()`), and the branch was
re-pushed to prove the rest in a single run.

## Remaining for task 11

Settled since:

- **FR-013 done.** Budget 60 MB per synchronized campaign, measured — see
  [freeze-decisions.md](freeze-decisions.md). Reproduce with
  `bun run --filter @rpg/guard measure`.
- **ADR-001 written**, in [adrs/](adrs/).

Still open, none of it code:

1. **Ratify FR-012.** Recommendation is single-writer with explicit takeover, not optimistic
   concurrency. Reasoning in [freeze-decisions.md](freeze-decisions.md).
2. **Branch protection** on `main` requiring the `gates` job. The only unmet criterion left in
   task 02.
3. **Real handles** in `.github/CODEOWNERS` (`@track-a`, `@track-b`, `@track-c`, `@all-devs`).
4. **The five product decisions** in `../_index.md`. The Cairn and Fate licence question is the
   long pole and gates features 12, 13, and the scope of 14.

Then close PR #1, delete the `ci/prove-gates-catch-failures` branch, delete `spike/`, and tag.

## Parallel plan

```text
day 1        A: 01 ─────────────┐
                                ├─> B: 03 ─> 04 ─> 05 ──────┐
                                ├─> C: 02, 07 ─> 06, 09 ────┼─> 11 freeze
                                └─> A: 08 ─> 10 (spike) ────┘
```

Task 01 blocks everyone and is short. While it lands, B drafts the contract shapes on paper
against `_techspec.md`, and A plans the spike. Nobody waits idle for a full day.

## Critical path

`01 -> 08 -> 10 -> 11`. The spike is the long pole and the only task whose result can change
another task's output: a sync `no-go` sends task 04 back for a redraft before the tag.

Start task 10 as early as its dependency allows. Finding a `no-go` on day 3 is the entire reason
it exists; finding it on day 5 costs the wave.

## Not in this feature

`FR-101` (shared UI primitives) and `FR-102` (seed command) are P1 and deliberately land after the
tracks are running. If wave 0 threatens three days, they are already cut — there is nothing else
to cut without breaking the gate.

## Verification scripts

Task 01 defines these. Every later task uses them.

```bash
bun run check
```

```bash
bun run typecheck
```

```bash
bun test
```

```bash
bun run build
```
