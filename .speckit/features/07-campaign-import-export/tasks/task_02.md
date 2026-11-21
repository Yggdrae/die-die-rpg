# Task 02: Bounded rpgpack format and package inspector

Status: completed (2026-10-27).

## Scope

- Create `packages/campaign-portability` and TypeBox schemas for manifest, locks, reports, and chunks.
- Implement deterministic ZIP writer/reader abstraction and every `_db.md` size/path/checksum limit.
- Reject malformed/duplicate/traversal/symlink/bomb/deep JSON input before extraction/write.
- Add property/fuzz fixtures and canonical checksum tests.

## Acceptance Criteria

- Valid package layout/checksums are deterministic.
- Every invalid-package BDD defect changes no domain state.
- Untrusted entry names/content never become filesystem paths or executable data.

## Verification

```bash
bun test packages/campaign-portability
bun run typecheck
```

## Evidence

### Files

All under `packages/campaign-portability/src/`.

| File | Contents |
| --- | --- |
| `zip.ts` | Writer and reader. |
| `canonical.ts` | Canonical JSON, SHA-256, bounded JSON parse. |
| `limits.ts` | The `_db.md` limits. |
| `paths.ts` | The closed layout and the safe-path rule. |
| `schemas.ts` | TypeBox `Manifest`, `SystemLock`, `ModulesLock`, `ChunkFile`, `ContributorSummary`. |
| `format.ts` | `buildPackage`. |
| `inspector.ts` | `inspectPackage`. |
| `test-fixtures.ts` | Test fixtures, including a hostile raw ZIP builder. |

### Design

- **Dependencies.** No new external dependency. ZIP is hand-written:
  - stored entries, plus raw deflate through the web-standard `CompressionStream` /
    `DecompressionStream`;
  - the same code runs in Bun and in the browser.
- **Determinism.**
  - The writer emits canonical JSON, entries sorted by path, and fixed DOS timestamps.
  - Stored is the default, so equal logical content gives identical bytes.
  - With deflate, an entry falls back to stored whenever its ratio would exceed the reader's
    100:1 limit, so a package always passes its own inspector.
- **Inspector.** `inspectPackage` is a pure function of the bytes: no write port and no
  filesystem.
  1. It validates the central directory before decompressing anything. Strict checks:
     - exactly one end record and no comment;
     - no prepended or trailing bytes; entries tile the archive with no gaps or overlap;
     - every local header matches its central record;
     - no ZIP64, encryption, unsupported method, or non-UTF-8 name.
  2. Symlinks, directories, and unknown or undeclared entries are refused.
  3. Paths: no duplicates (compared case-folded), and no absolute, backslash, drive or colon,
     `..`/`.`, empty-segment or control-character path.
  4. Limits:
     - 250 MB package, 500 MB total, 10,000 entries, 50 MB per entry, 100:1 ratio per entry;
     - inflation is bounded by the declared size while it streams.
  5. Integrity: CRC check, then a SHA-256 for every entry against the manifest and the
     contributor record.
  6. JSON is parsed only after a raw nesting-depth pre-scan. Limits on string, array, keys and
     nodes; `__proto__`, `constructor` and `prototype` keys are refused.
  7. Schemas: TypeBox manifest (format version checked), lock schemas, and chunk envelopes whose
     module and version agree with the manifest.
- **Failures.** A failure is a safe code. The failing path or module is included only after it
  has been validated, never as raw input.

### Tests

`bun test packages/campaign-portability` passed: 58 tests, 0 fail. Task 02 files:

- **`format.test.ts`** (11 tests): canonical JSON, a known SHA-256, the bounded parser, the
  layout and unsafe paths, byte-identical output for reordered input, sorted entries and the
  manifest, a single-entry checksum change, deflate parity, and the build refusals.
- **`inspector.test.ts`** (17 tests): every `_bdd.md` "Invalid package input changes nothing"
  defect, plus extras.
  - BDD defects: malformed container (6 variants), missing required member (5 members), manifest
    schema (5 variants plus unsupported version), duplicate module and duplicate or case-folded
    entry, checksum mismatch (entry, contributor record, CRC), and path traversal (9 names, never
    echoed).
  - Non-file entries: symlink, directory, undeclared or unsupported entry, encryption, method.
  - Limits: each one, and the exact boundary.
  - Zip bomb (1 MB of zeros, more than 100:1) and lying sizes.
  - JSON: deep nesting (10,000 levels), malformed, invalid UTF-8, a `__proto__` key; envelope and
    lock mismatches.
  - Fuzzing: 400 seeded byte-flip and truncation mutations of a valid package, plus 200 garbage
    buffers. None throws, and none passes as a different package.
- **Gates:** `bun run typecheck` 12/12 workspaces exit 0.
