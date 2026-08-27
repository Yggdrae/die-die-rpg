# Task 10: Feasibility Spike — Sync and Search

## Goal

Answer two questions with running code before twenty features are written against the answers:
does the offline sync round trip work, and does SQLite/WASM give us usable full-text search.

## Dependencies

- Task 08 (needs PostgreSQL)

## Context

- PRD: `../_prd.md` (FR-011)
- `PRD.md` s.52, s.53, s.55 (offline architecture, local database, sync layer).
- Features 14 and 20 both depend on the search answer. Feature 03 and the `SyncedRepository`
  contract depend on the sync answer.
- This is throwaway code. It is deleted at task 11.

## Scope

### Change

- `spike/`: whatever is needed, held to no quality bar beyond producing a trustworthy answer.
- **Sync question**: write a record offline in SQLite/WASM, reconnect, confirm it reaches
  PostgreSQL through PowerSync, and confirm a server-side change reaches the local database.
  Exercise OPFS, and exercise the IndexedDB-backed VFS fallback.
- **Search question**: determine whether SQLite/WASM as configured provides usable full-text
  search over a campaign-sized fixture dataset.
- A written findings note in this feature directory: what was tried, what worked, what did not,
  and the go/no-go on each question.

### Do Not Change

- Do not build feature 03. No `SyncService` boundary, no queue, no reconnect strategy, no
  production code. Producing a reusable implementation here means it will be treated as one.
- Do not let a `no` become a research project. A `no` is a valid, useful, wave-0 answer.
- Nothing in `spike/` may be imported by `apps/` or `packages/`.

## Acceptance Criteria

- [ ] Sync question answered go or no-go, with evidence, on both OPFS and the fallback path.
- [ ] Search question answered yes or no, with evidence, against a campaign-sized dataset.
- [ ] Findings note committed in `.speckit/features/00-platform-foundation/`.
- [ ] If sync is no-go: `SyncedRepository` (task 04) is redrafted **before** the freeze tag, and
      the reason is recorded.
- [ ] If search is no: features 14 and 20 are notified that a prefix index is the MVP path, and
      their PRD open questions are updated to say so.
- [ ] `spike/` is importable by nothing else, enforced by the guard from task 09.

## Verification

The verification is the findings note, not a passing test. State the question, the method, the
result, and the decision it forces.

```bash
bun test tools/guard
```

confirms nothing outside `spike/` depends on it.

## Notes

- This is the long pole of the wave and the only task whose result can invalidate another task's
  output. Start it as early as task 08 allows.
- Finding a no-go on day 3 is the entire reason this task exists in wave 0. Finding the same thing
  in wave 3 costs a redesign across every persisted feature.
- Resist making the spike nice. Its value is the answer and its timing, not its code.
