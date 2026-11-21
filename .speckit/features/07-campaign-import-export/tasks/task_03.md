# Task 03: Export registry and consistent orchestrator

Status: completed (2026-10-27).

## Scope

- Implement unique contributor registry and conformance kit.
- Orchestrate sorted contributors under one repeatable snapshot/cursor and stream ZIP output.
- Add system/module locks, attachment manifest, secret/forbidden-field scanning, and unknown chunks.
- Test contributor failure, deterministic ordering, and no internal feature imports.

## Acceptance Criteria

- A new registered contributor appears without orchestrator changes.
- Export cannot mix authority states or offer a partial file after contributor failure.
- P0 package contains no credentials, audit, binary bytes, object/sync secrets.

## Verification

```bash
bun test packages/campaign-portability
bun run guard
```

## Evidence

### Files

| File | Contents |
| --- | --- |
| `packages/campaign-portability/src/registry.ts` | `ExportRegistry` |
| `packages/campaign-portability/src/orchestrator.ts` | `ExportOrchestrator`, plus the `RulesContextSource`, `PreservedChunkSource` and `ExportConsistency` ports |
| `packages/campaign-portability/src/scanner.ts` | Forbidden-data scanner |
| `packages/campaign-portability/src/testing.ts` | Conformance kit, exported as `@rpg/campaign-portability/testing` |
| `tools/guard/src/rules.ts` | Rule 11, `no-portability-feature-imports` |

### Registry

- Validates the module id: it is a path segment.
- Refuses a duplicate module and refuses a second campaign root.
- Validates the placement: `campaign`, `entities`, `documents` or `attachments-manifest`.
- Owner-supplied `countRecords` feeds the safe summary.
- The orchestrator refuses `registry_incomplete` unless both the campaign root and an attachment
  manifest contributor are registered.

### Consistency deviation

- `_db.md` asks for "one REPEATABLE READ transaction or one authority cursor", but the frozen
  `export(campaignId)` carries no transaction.
- Online (`double_read`): every contributor and the pins are read in module order, then read again.
  Equal canonical checksums prove that no write landed between any two reads, because versions only
  increase. A differing pass is re-read, up to 3 comparisons, then `snapshot_unstable`.
- Offline (`cursor`): the replica cursor must be complete and equal before and after the reads.

### Failure and output rules

- Any contributor failure gives a safe code plus the module id, never the error text, and no
  package: `contributor_failed`, `contributor_mismatch`, or `forbidden_content` with a JSON
  pointer.
- Payloads must be canonical-serializable and within the JSON limits.
- The forbidden-data scanner refuses:
  - credential, email, object-key, signed-URL, audit, sync-queue and local-path keys;
  - signed-URL, `s3://` and password-hash values.
- It deliberately allows game words such as `secret`, `token` and `session`.
- Preserved unknown chunks are re-emitted under `unknown/<module>/<version>.json`, byte-identical
  after canonicalization.

### Tests

`orchestrator.test.ts` (17 tests) covers these `_bdd.md` scenarios:

- **Export uses contributor boundaries:**
  - a new contributor appears with no orchestrator change;
  - the registry refusals;
  - an incomplete registry;
  - a source scan proving this package imports only `@rpg/contracts`.
- **A GM exports one campaign as one file:** the members and the manifest.
- **Export preserves the pinned rules context:** exact pins, sorted; a missing campaign gives
  `campaign_unavailable`.
- **Manifest only / Secrets are excluded:** 6 leak shapes, and the game-word false positives.
- **Export cannot mix authority states:**
  - a throwing contributor, without leaking its message;
  - a chunk claiming another module or an unsafe version;
  - unserializable or too-deep payloads;
  - a write landing between two reads is detected and re-read (3 passes);
  - never-settling state gives `snapshot_unstable`;
  - cursor mode, incomplete or moving;
  - preserved chunks re-emitted unchanged.
- **Conformance kit:** a good contributor passes, and each of 6 defects of a bad one is reported.

Other evidence:

- `apps/api/src/modules/portability/composition.test.ts`: both registered P0 contributors
  (`campaign`, `attachments`) pass the conformance kit with expected record counts.
- `tools/guard/src/rules.test.ts`: +2 tests for rule 11 (fails on `@rpg/attachments`,
  `@rpg/campaigns`, `@rpg/identity/postgres` and `@rpg/sync`; passes for `@rpg/contracts`,
  external libraries and the composition root).
- `bun test packages/campaign-portability`: 58 pass.
- `bun test tools/guard`: 94 pass.
- `bun run guard`: 330 files, no violations.
