# Tasks: Platform Foundation and Shared Contracts

Source: [`_prd.md`](_prd.md), [`_techspec.md`](_techspec.md).
Gate this feature satisfies: the Definition of Ready in [`../_index.md`](../_index.md).

All three developers work this feature together. It is the only wave in the plan where they are
not on separate tracks.

## Task list

| # | Task | Depends on | Suggested owner |
| --- | --- | --- | --- |
| 01 | [Repository and tooling baseline](tasks/task_01.md) | — | A |
| 02 | [CI pipeline](tasks/task_02.md) | 01 | C |
| 03 | [Contracts: core shapes](tasks/task_03.md) | 01 | B |
| 04 | [Contracts: repository and registries](tasks/task_04.md) | 03 | B |
| 05 | [In-memory SyncedRepository double](tasks/task_05.md) | 04 | B |
| 06 | [Fixtures package](tasks/task_06.md) | 03 | C |
| 07 | [Application shells](tasks/task_07.md) | 01 | C |
| 08 | [Local development stack](tasks/task_08.md) | 01 | A |
| 09 | [Architecture guard and code ownership](tasks/task_09.md) | 01, 07 | C |
| 10 | [Feasibility spike: sync and search](tasks/task_10.md) | 08 | A |
| 11 | [Freeze: decisions, ADR, tag](tasks/task_11.md) | 02, 04, 05, 06, 09, 10 | all |

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
