# Task 03: Contracts — Core Shapes

## Goal

`packages/contracts` publishes the cross-cutting shapes every feature persists, expressed in
TypeBox so the runtime validator and the TypeScript type stay aligned.

## Dependencies

- Task 01

## Context

- PRD: `../_prd.md` (FR-003)
- TechSpec: `../_techspec.md` (Interfaces and Contracts, core shapes table)
- These shapes are frozen at task 11. After that, changing one costs a contract-change note and
  a reviewer per track (PRD FR-008).

## Scope

### Change

- `packages/contracts/`, depending on TypeBox and nothing else.
- `Visibility`, `Role`, `ActorRef`, `EntityEnvelope`, `ApiError`, `Result<T, E>`, `SemanticOp`,
  `AttachmentRef`, `AuditEvent`, `SystemRef`, `CapabilityKey`.
- Exported validators alongside exported types.
- Unit tests per shape, weighted toward reject paths.

### Do Not Change

- No behavior. Types and validators only. A function that decides something belongs in a feature.
- No dependency on Fastify, React, PowerSync, PostgreSQL, or MinIO.
- Do not fill the `CapabilityKey` union. Feature 08 owns the values; this task ships the branded
  type so consumers compile.
- Do not define credential, token, or session shapes. Feature 01 owns them.

## Acceptance Criteria

- [ ] `EntityEnvelope` requires `version` (integer) and permits `deletedAt`. Neither is optional
      to *include* — feature 03 cannot retrofit conflict detection or tombstones later.
- [ ] `EntityEnvelope` requires `visibility`. A record with no visibility cannot be constructed.
- [ ] `AuditEvent` carries the `private` flag, so feature 06 can separate the GM-private log
      without a migration.
- [ ] Every validator rejects: missing required field, wrong type, unknown enum member,
      and a negative or non-integer `version`.
- [ ] Package has no runtime dependency other than TypeBox, asserted by its manifest.
- [ ] Types and validators are exported from a single documented entry point.

## Verification

```bash
bun test packages/contracts && bun run typecheck
```

## Notes

- Reject-path tests matter more than accept-path tests here. This is the boundary that keeps
  invalid data out of the domain (`PRD.md` s.16), and it is only tested by what it refuses.
- Draft these shapes on paper while task 01 lands. They are the wave-0 critical thinking, not the
  wave-0 typing.
