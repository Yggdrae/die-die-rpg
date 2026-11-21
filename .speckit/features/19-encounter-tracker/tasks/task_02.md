# Task 02: Authority service, appliers, target adapter, sync stream, and audit

Status: completed (2026-11-06)

## Scope

- `EncounterService` and `EncounterSyncMutationApplier` (one per writable table), registered in the runtime.
- `encounterParticipantTargetAdapter` registered with feature 11; `runEffectTargetContract` passes.
- Stream `authorized_encounters` compiled from the policies; holds branches; publication allow-list; audit contributor
  row built.

## Acceptance Criteria

- Players are refused every write; an ended encounter refuses every change; a stale change is a conflict.
- Damage on an instance merges, its record is `gm_only`, and a resend changes nothing.
- Each lifecycle and participant event is audited once.

## Verification

```bash
bun test apps/api/src/modules/encounters apps/api/src/modules/sync apps/api/src/modules/audit
```

## Evidence (2026-11-06)

`encounters.integration.test.ts` (3): lifecycle audited once on retry, crafted envelope and player start refused,
stale update a conflict, end final; participants and states (three distinct instances), two offline damages merge,
records `gm_only`, resend no second change, player and character-participant effects refused, reveal one-way and
audited, removal after damage not a conflict, effects refused after the end, player stream without states, notes,
or the hidden participant; `runEffectTargetContract` passes.
