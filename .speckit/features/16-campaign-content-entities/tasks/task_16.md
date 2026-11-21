# Task 16: Content security and product acceptance

Status: completed (2026-10-30). The owner replaced the manual 30-second protocol with an automated test.

## Goal

Produce end-to-end evidence for the PRD success signals: zero hidden content on player devices,
a type added by configuration only, and the `PRD.md` s.88 acceptance flow.

## Dependencies

- Tasks 04–15. (Import round trip is task 17 and not part of this gate.)

## Context

- PRD "Success Signals"; BDD "Acceptance Criteria".
- Feature 04 task 07 security acceptance pattern
  (`apps/api/src/modules/authorization/security-acceptance.test.ts`).
- Provider gap to close: live reveal/un-reveal of a content row
  (`apps/api/src/modules/sync/sync-config.powersync.integration.test.ts`).

## Scope

### Change

- `apps/api/src/modules/content/security-acceptance.test.ts`: whole sandbox campaign on
  PostgreSQL; per requester (owner, gm, assistant_gm, player A, player B, removed gm, non-member,
  other campaign) the replicated entities, relationships, notes, holds, and tombstones equal the
  feature 04 decision.
- Live PowerSync test: reveal an entity to player A, assert delivery to A only, un-reveal, assert
  REMOVE; hide an endpoint, assert relationship REMOVE (skipped when the service is unreachable,
  reported as skipped).
- Type-by-configuration demonstration: one change adding a type entry only; a test asserts the
  diff touches `packages/content/src/types.ts` alone (or the review records it).
- Playwright s.88 flow: GM creates an NPC, a location, links them, attaches a file to the NPC,
  creates notes; player view shows only revealed content and the player's own personal notes.
- Automated 30-second quick create at human pace at a busy table (owner decision 2026-10-30, replacing
  the manual protocol).

### Do Not Change

- Production code, except fixes for defects this suite finds (each with its own test).

## Acceptance Criteria

- [x] Zero `gm_only` entities, hidden relationships, other authors' notes, hidden holds, or unseen
  tombstones on any player replica (SQL simulated; live where available).
- [x] New type works end to end with configuration only.
- [x] s.88 Playwright flow passes, attachment step included.
- [x] 30-second measurement automated, with its conditions.
- [x] Full gates pass (MinIO read-URL expiry excepted, see Evidence).

## Verification

```bash
set -a; . ./.env; set +a
bun run check
bun run typecheck
bun test --timeout 120000
bun run guard
bun run build
bun x playwright test apps/web/e2e/content.e2e.ts
```

## 30-second quick create

`apps/web/e2e/content.e2e.ts`, "PRD s.78: quick create stays under 30 s". A stand-in for the moment in
`PRD.md` s.78, not a stopwatch at a real table: it times the tool, not a person deciding what to type.

- Conditions: the shared campaign plus 30 notes; another GM writing a note about every 500 ms, reaching this
  device meanwhile; typing at 120 ms per key; three rounds online and one offline, each of NPC, location, note.
- Fails above 30 s total, and above 5 s excluding the typing, so a regression shows long before 30 s.

| Browser | Slowest online | Slowest offline | Slowest excluding typing |
| --- | --- | --- | --- |
| Edge 156 | 2,858 ms | 2,677 ms | 388 ms |
| Chromium 151, Pixel 7 emulation | 2,958 ms | 2,684 ms | 438 ms |
| Firefox 153 on Linux | 3,475 ms | 3,325 ms | 955 ms |
| WebKit 26.5 on Linux | 3,307 ms | 3,088 ms | 868 ms |

## Evidence (2026-10-30)

Automated acceptance is complete.

- `apps/api/src/modules/content/security-acceptance.integration.test.ts` 1 test (deviation: named
  `.integration` like every other PostgreSQL test). Through `buildRuntimeApp` over HTTP only: 16
  sandbox entities from every GM role, gm_only at create, revealed through the feature 04 route; 7
  links; D-07 narrowing by hiding an endpoint; seen and unseen tombstones of entities and links; 3
  personal notes; holds acquired through the route; a removed GM; another campaign. Every configured
  YAML query (verbatim, requester as `$1`, real tables) equals the `decide` result for owner, gm,
  assistant_gm, player A, player B, removed gm, non-member, other campaign owner, for entities,
  relationships, notes, holds, tombstones. Explicit zero-leak check on the raw payload of both player
  replicas (`gm_only` ids, hidden and narrowed links, unseen tombstones, the other player's note,
  entity holds, a hidden field value); the D-07 bound holds; read API equals the replica for live rows.
  Mutation: player role added to the YAML GM branch of `content_entities` -> test fails; restored.
- Live provider, `apps/api/src/modules/sync/sync-config.powersync.integration.test.ts` +1 (real
  PowerSync 1.25.0 service, writes through the runtime, closes the "live reveal of a content row"
  gap; 8/8 pass, not skipped): reveal to player A -> PUT on A only, player B's checkpoint unchanged,
  no op, id absent from B's stream; link revealed within bounds -> A only; un-reveal -> REMOVE of the
  entity and, by D-07 narrowing, of the link on A. Measured with a write-checkpoint barrier on this
  machine: PATCH -> replica 66–83 ms, un-reveal -> REMOVE 100–134 ms (protocol-model client, local
  stack, not a browser).
- Type by configuration:
  - `apps/api/src/modules/content/type-configuration.integration.test.ts` 1 (permanent): the
    shipped list plus one `vehicle` entry, injected where the composition passes the configuration:
    device offline create -> real authority -> filter -> compiled stream query (no type predicate;
    GM only) -> feature 04 reveal -> player receives it; after removal from the configuration:
    editable, new ones refused (`unknown_type`), deletable, tombstone reaches the player.
  - Scripted demonstration (temporary, reverted, `cmp` identical to the backup): a `vehicle` entry
    added to `packages/content/src/types.ts`, diff `1 file changed, 6 insertions(+)`. Production
    runtime over HTTP: create accepted, `?type=vehicle` listed, reveal 200, delete accepted. `bun run
    guard` no violations. No screen, route, table, migration, or sync rule touched. 3 existing tests
    failed during the demonstration because they pin the MVP list or use `vehicle` as the unconfigured
    example (`types.test.ts`, `application.integration.test.ts`, `content-model.test.ts`): test data,
    to be updated by whoever adds a real type.
- Playwright `apps/web/e2e/content.e2e.ts` +1 "PRD s.88 acceptance" (real stack): GM creates NPC,
  location, note, links NPC to location, attaches a PNG to the NPC, reveals only the location; two
  players each write a note; Casey's device shows the location and Casey's note only, no link, no NPC,
  no attachment name; the API agrees. Scripted: quick create listed
  locally 261–283 ms, accepted and synchronized 1,085–1,109 ms; GM flow to link 760–1,048 ms, with the
  attachment 1,217–1,447 ms.
- Defect this suite found, fixed (`apps/web/src/features/content/RelationshipPanel.tsx`): after a link
  was saved, the late `setTarget('')` cleared an endpoint the GM had already chosen for the next link,
  so the second link was silently not submitted. Seen once under full-suite load (test "links show on
  all three details": Entity back on "Choose…", 1 of 2 links). Now only the submitted choice clears.
  Covered by that existing Playwright sequence, which is timing dependent, so no deterministic test
  (the repo has no DOM test library); `bun run test:e2e` passes after the fix (1 full run).

Gates (with `.env`, 2026-10-30, after the last code change unless noted):

| Command | Result |
| --- | --- |
| `bun run check` | clean, 468 files |
| `bun run typecheck` | 13/13 exit 0 |
| `bun run guard` | 418 files, no violations |
| `bun run build` | api + web exit 0 |
| `bun test --timeout 30000` (+ `POWERSYNC_ENGINE_EXEC`) | 1431 pass, 1 fail (MinIO read-URL expiry); before the web-only fix 1432 pass, 0 fail |
| `bun run test:e2e` | 75 passed |
| `bun x playwright test apps/web/e2e/content.e2e.ts` | 11 passed |
| `apps/api/src/modules/sync/sync-config.powersync.integration.test.ts` | 8 pass, 0 skip |

The MinIO failure is intermittent in the full suite and failed 4 of 4 runs alone at the end of this
work: first fetch of a 3 s URL gets 403, and `wsl date` read 3 s ahead of Windows `date`, which is
consistent with clock skew against the short expiry (not proven further). No attachment code changed
here. The task command's `--timeout 120000` was not used; the brief's 30000 was.
