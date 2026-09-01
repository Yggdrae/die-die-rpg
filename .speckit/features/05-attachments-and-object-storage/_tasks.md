# Tasks: Attachments and Object Storage

Source: `_prd.md`, `_bdd.md`, `_db.md`, and `_techspec.md`. P0 only.

| # | Task | Depends on | Status |
| --- | --- | --- | --- |
| 01 | [Verify S3 adapter, MinIO, and browser isolation](tasks/task_01.md) | — | pending |
| 02 | [Attachment schema, storage port, and lifecycle](tasks/task_02.md) | 01 | pending |
| 03 | [Authorized upload and verified finalization](tasks/task_03.md) | 02, feature 04 | pending |
| 04 | [Authorized reads and safe rendering](tasks/task_04.md) | 02–03, feature 04 | pending |
| 05 | [Offline attachment store and campaign pinning](tasks/task_05.md) | 04, feature 03 | pending |
| 06 | [Deletion reconciliation and export manifest](tasks/task_06.md) | 02–05 | pending |
| 07 | [Attachment security and acceptance suite](tasks/task_07.md) | 03–06 | pending |

Thumbnails, individual pin/unpin, storage dashboard, malware scanning, and binary export are deferred.

Completion gates: `bun run check`, `bun run typecheck`, `bun test`, `bun run guard`, `bun run build`.

