---
name: final-verify
description: Verify implementation claims with fresh command evidence. Use before declaring a task, feature, PR, or merge ready.
---

# Final Verify

Never claim `done`, `passing`, `green`, or equivalent from stale evidence.

## Task Verification

Run the smallest set that proves the changed scope:
- formatting/lint/check for affected files/workspace;
- affected typecheck;
- related unit/integration tests;
- affected build when relevant.

## PR / Merge Verification

Run repository-defined full gates, normally:
- lint/check;
- typecheck;
- tests;
- build;
- critical E2E when applicable.

## Report

Use compact evidence:

```text
PASS  <command>
FAIL  <command> — <short cause>
SKIP  <check> — <reason>
```

Do not hide warnings or failures. Do not paste large successful logs unless requested.
