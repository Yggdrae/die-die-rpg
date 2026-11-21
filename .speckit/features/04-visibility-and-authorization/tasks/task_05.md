# Task 05: Sync predicate compiler and equivalence suite

Status: completed. The PowerSync provider round trip was verified on 2026-10-26 (see "Provider
round trip"). `apps/api/src/runtime.ts` registers
`REGISTERED_RESOURCE_POLICIES` from `apps/api/src/modules/sync/sync-rules.ts`, the same
declarations the sync-config drift test compiles. Depends on task 02 and the feature 03 sync
adapter.

## Scope

- Define provider-neutral predicate AST and compile registered policies. **Done.**
- Implement the initial provider adapter in feature 03. **Done.** The adapter produces the
  PowerSync dialect, which the YAML drift test verifies.
- Run exhaustive API-vs-sync truth-table tests for roles, targets, ownership, deletion, and
  campaigns. **Done.** They run both in-process and as PostgreSQL SQL.
- Test reveal delivery, un-reveal removal, and absence of unseen tombstones. **Done.** These run
  on PostgreSQL with a simulated provider diff.

## Acceptance Criteria

- [x] Any application/sync outcome divergence fails CI. The in-process truth table and the YAML
  drift test need no database, so they run in CI. Mutated rules and tampered YAML are proven to
  fail. The SQL truth table runs wherever PostgreSQL is reachable; CI has no PostgreSQL.
- [x] Hidden and player-private rows never reach unauthorized local databases. This is proven at
  SQL level on simulated replicas, by the PowerSync 1.25.0 sync-rules engine on the exhaustive
  truth table, and on the live service for the replicated tables that exist today.
- [x] Party predicates deny until a resolver registers. While party targeting is inactive, no
  requester matches a party row, GM roles included. While it is active, the
  `party_includes_requester` node cannot be translated, so the provider rule set fails to compile.

## Verification

```bash
bun test packages/authorization packages/sync
bun run typecheck
```

## Evidence (2026-10-25)

### Implementation

- `packages/authorization/src/sync-predicate.ts` holds the AST and its compiler:
  - The AST node kinds are `always`, `never`, `and`, `or`, `member_role_in`,
    `visibility_mode_in`, `targets_include_requester`, `party_includes_requester` and
    `owner_is_requester`.
  - `compileSyncRule` builds a rule from a declaration, and `evaluateSyncRule` evaluates it.
  - `rowPredicate` folds the visibility clause for `campaign_wide` sources, and `simplify` cleans
    up the result.
  - `SyncPredicateCompiler.compile()` now returns `rule`, and `matches` evaluates the AST.
  - The new `SyncPredicateCompiler.rules()` returns the rules for every registered class.
- `packages/authorization/src/sync-test-kit.ts` provides `syncTruthTable`, `findSyncDivergences`
  and `truthRequester`.
  - Requesters: 9 (five roles, a second player, a removed GM, a non-member, and an
    other-campaign member).
  - Rows: 520 per targeted class (2 campaigns × 13 Visibility samples × 10 author facts ×
    live/tombstone).
- `packages/sync/src/sync-rules.ts` provides `compileProviderQueries` and `renderSyncRuleQuery`.
  - It supports the PowerSync and PostgreSQL dialects.
  - It validates identifiers, the projection and the bindings, and fails closed.
- `apps/api/src/modules/sync/sync-rules.ts` defines `CAMPAIGN_RESOURCE_POLICY`,
  `REGISTERED_RESOURCE_POLICIES` and `SYNC_RULE_BINDINGS`.
- `infra/powersync/sync-config.yaml`: the `campaign` query is now the compiled output. It adds
  `AND m.role IN ('owner', 'gm', 'assistant_gm', 'player')`; previously a member with no reading
  role (an observer) would have received campaign rows that the API denies.

### Commands

- `bun test packages/authorization packages/sync apps/api/src/modules/sync --timeout 30000`
  (with `.env`): 235 pass, 0 fail, 17,735 expect() calls, 18 files.
- New test files:

  | File | Pass | expect() calls |
  | --- | ---: | ---: |
  | `sync-predicate.test.ts` | 19 | 16,732 |
  | `sync-rules.test.ts` | 11 | 27 |
  | `sync-rules.integration.test.ts` (PostgreSQL) | 10 | 57 |
  | `sync-config.integration.test.ts` | 4 | 32 |

- With an unreachable database, the drift checks still run: 3 pass and 11 skip.
- `bun run typecheck`: 10/10 workspaces exit 0.
- `bun run check`: 238 files clean.
- `bun run guard`: 202 files, no violations.
- The PostgreSQL probe tables (`sync_rule_probe_*`) and the seeded campaigns are removed after
  the run (verified: 0 left).

## Provider round trip (2026-10-26)

PowerSync Service 1.25.0 and MongoDB 7 ran from `compose.yaml` (Docker in WSL). Details:
`docs/OFFLINE_SYNC_RUNTIME.md`, "PowerSync 1.25.0 dialect" and "Provider checks".

- The configuration written before this run was rejected by the service: tuple `IN (...)` lists
  and `concat` are unsupported, and source aliases renamed the synced tables (`c`, `s`, `h`,
  `m` instead of the client table names). The adapter now renders unaliased sources and
  JSON-array value sets (`IN '[...]'`); the YAML uses `||`. MongoDB had to run as a replica set.
- `apps/api/src/modules/sync/sync-config.powersync.integration.test.ts`: 4 pass against the
  live service (stable over 10 runs). Real `/sync/stream` protocol, HS256 tokens like the API,
  write-checkpoint barrier. Per requester (owner, gm, assistant_gm, player, removed gm,
  non-member, other-campaign owner) the delivered campaigns, settings, holds and own memberships
  equal `decide`, tombstones included. Promotion/demotion add and remove GM-only settings;
  revocation removes every campaign row and delivers the membership tombstone; hidden-setting
  churn leaves a player's ops, counts and checksums unchanged; un-reveal of a setting is a
  REMOVE. A mutated settings filter fails 3 of the 4 tests.
- `packages/sync/src/infra/powersync/sync-rules-engine.integration.test.ts`: 7 pass with
  `POWERSYNC_ENGINE_EXEC="wsl -e docker exec -i rpg-powersync"`. The service's own sync-rules
  engine evaluates the PowerSync dialect of 5 fixture classes over the exhaustive truth table
  (observer included) with no divergence from `decide`; this covers `auth.user_id() IN <json
  column>` and mixed membership/row `OR`. `sync-config.yaml` compiles with no diagnostics.
- Not live: observer memberships (feature 01 role CHECK) and reveal of a content row (no
  registered class with per-row Visibility yet) are covered by the engine and shadow-table
  checks only. Delivery into browser SQLite through the web SDK is not exercised.

## Open

- Closed 2026-10-26: PowerSync round trip. The dialect needed fixes (no tuple `IN` lists, no
  source aliases); `auth.user_id() IN <json column>` and mixed `OR` work as compiled. REMOVE on
  un-reveal and revocation, and no operation for never-matched tombstones, are observed live for
  settings and memberships and by the engine for targeted fixture classes.
- Live reveal of a content row awaits the first registered class with per-row Visibility.
- Closed 2026-10-26: `runtime.ts` registers `REGISTERED_RESOURCE_POLICIES`. The
  `campaign_settings` and `sync_long_text_holds` platform queries now carry declaration-derived
  role and class filters, with drift and PostgreSQL tests (feature 03 task 07).
