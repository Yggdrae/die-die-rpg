# Tasks: Identity and Membership

Source: [`_prd.md`](_prd.md), [`_bdd.md`](_bdd.md), [`_techspec.md`](_techspec.md), and
[`_db.md`](_db.md).

P0 only. P1 session management and optional email flows remain deferred.

## Blocking gate

Task 01 resolves every item under `_db.md` "Blocking TODOs Before Implementation Tasks" that is
owned by feature 01. Tasks 03 onward must not start until its decisions are approved. Campaign
owner enforcement additionally waits for feature 02 (task 07); sync tombstone purge waits for
feature 03 and therefore is not implemented here (task 12 keeps tombstones indefinitely).

## Task list

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Freeze security, lifecycle, and persistence decisions](tasks/task_01.md) | — | completed |
| 02 | [Identity package contracts and domain rules](tasks/task_02.md) | 01 | completed |
| 03 | [PostgreSQL tooling and core identity migration](tasks/task_03.md) | 01, 02 | completed |
| 04 | [Account creation, login, authentication, and logout](tasks/task_04.md) | 03 | completed |
| 05 | [Operator-issued password recovery](tasks/task_05.md) | 03, 04 | completed |
| 06 | [Membership persistence and actor resolution](tasks/task_06.md) | 03, feature 02 campaign table | pending |
| 07 | [Atomic campaign ownership integration](tasks/task_07.md) | 06, feature 02 campaign persistence | pending |
| 08 | [Invitation lifecycle and acceptance](tasks/task_08.md) | 04, 06 | pending |
| 09 | [Membership listing and administration](tasks/task_09.md) | 06, 07 | pending |
| 10 | [Fastify identity routes and request security](tasks/task_10.md) | 04, 05, 08, 09 | completed |
| 11 | [Web account and invitation flows](tasks/task_11.md) | 10 | completed |
| 12 | [Audit and sync revocation boundaries](tasks/task_12.md) | 09; feature 03 and 06 contracts | pending |
| 13 | [Architecture guard and P0 acceptance suite](tasks/task_13.md) | 07, 10, 11, 12 | pending |

## Dependency flow

```text
01 -> 02 -> 03 -> 04 -> 05
               |      \
               v       -> 10 -> 11 -> 13
              06 -> 08 -/       /
               |              12
               -> 07 -> 09 ----/
```

Tasks 02 and the non-campaign portions of 03 can begin before features 02, 03, and 06 ship.
Tasks 07 and 12 make the cross-feature integration points explicit rather than importing their
internals.

## Deferred

- FR-101 session listing and remote sign-out.
- FR-102 optional email management and verification.
- FR-103 invitation delivery by email.
- Account deletion is unavailable in P0; adding it requires a future product and retention policy.
- Finite membership-tombstone retention is externally blocked until feature 03 defines sync-safe
  purge acknowledgment.

## Feature completion gates

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
```

Task 13 also runs the identity Playwright suite and PostgreSQL concurrency tests using the
repository's documented local stack.
