# Task 05: Live sync and real-stack end-to-end

Status: completed (2026-11-06)

## Scope

- Live PowerSync: a player receives the encounter and the visible participant, never the hidden one, instance states,
  or GM notes.
- `apps/web/e2e/encounters.e2e.ts` over PostgreSQL, PowerSync, and the real API.

## Acceptance Criteria

- `PRD.md` s.78: an encounter with the party and three instances started from Session Mode in under 15 seconds.
- One-interaction damage and conditions; the player sees the label and public condition, never statistics.
- `PRD.md` s.76: a whole encounter offline, accepted on reconnect.

## Verification

```bash
bun test apps/api/src/modules/sync/sync-config.powersync.integration.test.ts
bun x playwright test apps/web/e2e/encounters.e2e.ts
```

## Evidence (2026-11-06)

- Live PowerSync: owner and assistant GM hold the encounter, the notes, both participants, and both instance states;
  player A holds the encounter and the visible participant (with its public condition) only, and nothing in the
  payload names the notes, the hidden participant, or a hit-point value. Instance-state churn sends player A nothing;
  a reveal sends the participant.
- `encounters.e2e.ts` (2 tests, real stack, dev server): "Add encounter" from Session Mode to the party and three
  bandits running in 611 to 1,024 ms alone, 3,288 ms in the full parallel run (budget 15,000 ms); one-interaction damage on an instance (others untouched) and
  on the character (write-through), a condition, an improvised enemy, a removal; the player sees labels and the
  public condition and holds no instance state or GM note; a whole encounter offline accepted on reconnect.
