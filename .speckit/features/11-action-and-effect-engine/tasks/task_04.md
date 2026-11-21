# Task 04: Ledger, service, and adapter port

Status: completed (2026-11-01)

## Scope

- Migration `0015_effect_applications`, records, policy, codec, `EffectLocalRepository`, `EffectApplicationService`, `EffectTargetAdapter`, `runEffectTargetContract`.

## Acceptance Criteria

- Replay, resend, collision, atomic rollback pass on PostgreSQL with a probe target.

## Verification

```bash
bun run db:migrate
bun test packages/actions
```
