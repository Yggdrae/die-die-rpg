---
name: execute-task
description: Implement one specified task with minimal scope, current repository evidence, focused tests, and no unrelated refactors.
---

# Execute Task

1. Read `docs/SPEC_GUIDELINE.md`, the task, linked specs, relevant ADRs, and affected code/tests.
2. Confirm the current state from the repository before editing.
3. Implement only the requested scope and required supporting changes.
4. Prefer minimal diffs. Do not rewrite unrelated files.
5. Add/update tests with the behavior they verify.
6. Run focused checks for affected scope.
7. Inspect the final diff for accidental changes, generated noise, secrets, and scope creep.
8. Update task status/checklist only with evidence from actual commands.
9. Never push automatically. Commit only when explicitly requested or project workflow requires it.

If blocked by a missing product/architecture decision, report the exact blocker. Do not invent the decision.
