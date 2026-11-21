# TechSpec: Dice Engine

Source: `_prd.md`, `_bdd.md`, `_db.md`, `PRD.md` s.20, s.21, s.34, s.76, s.79, `../_index.md`. P0 only.

## Current Facts

- `ExpressionValidators.dice` in `packages/systems/src/load.ts` waits for this feature; the package
  schema caps a dice expression at 200 characters. Declared today: `1d20`, `1d6`, `4dF + skill`.
- Feature 16 is the pattern for a replicated class: pure package root plus `/postgres`, an applier in
  `apps/api/src/modules/<feature>`, a Resource Policy, a device repository on `SyncedRepository`, a
  compiled stream, and a publication migration.
- `AuthorityMutationService` receipts make a retried mutation id return its stored outcome. The hook
  in `AuthorityMutationContext.recordAudit` also carries the access fence.
- `BrowserSyncedRepository.upsert` always queues an audit envelope.
- The freeze budget gives rolls 10 MB per campaign locally, projected at 4 800 rolls
  (`00-platform-foundation/freeze-decisions.md`).
- `_index.md`: "Where do roll records live? Owned by 09. Features 06 and 18 read through the 09 API.
  Duplicate storage is forbidden by rule 1."

## Decisions (open PRD questions closed; delegated by the owner, 2026-10-31)

- **D-01 Package `@rpg/dice`, with a pure core.** `packages/dice/src/engine/` depends on
  `@rpg/contracts` only, enforced by a guard rule, and is also exported as `@rpg/dice/engine`. The root
  adds records, policy, and the device repository. `@rpg/dice/postgres` holds tables and the service.
  It never imports `@rpg/formula`, by the same rule.
- **D-02 Grammar (open question 1).** Below. The smallest grammar that covers `PRD.md` s.20 and the
  paradigm packages. Notation grows with the system that needs it (PRD risk table).
- **D-03 Ordering and rounding (open question 3).** Integers only, addition and subtraction only, left
  to right. There is no multiplication or division, so **no rounding exists**. Dice roll in source order,
  and a term's dice in sequence. Keep selection breaks ties by earlier die, so the same faces always give
  the same kept set.
- **D-04 Natural and modified.** Natural is the signed sum of kept dice, or the success count with a
  success clause. Modified is natural plus every literal and named modifier.
- **D-05 Success clause is exactly one dice term and nothing else.** `2d6+1 success>=6` could mean three
  different things, so it is refused (`invalid_success`). Each kept die meeting the threshold counts one.
- **D-06 Names.** `[A-Za-z_][A-Za-z0-9_]*`, at most 64 characters, resolved by the caller (FR-004).
  Reserved, so an expression cannot be misread: `d<digits>`, `dF`, `success`, `kh<digits>`, `kl<digits>`,
  `__proto__`, `constructor`, `prototype`. `d20` alone is therefore a syntax error, not a name. Only the
  caller's own data properties are read, as in feature 10.
- **D-07 Limits (FR-011).** Expression length 200 (matches the package schema); 100 dice in the whole
  expression; 16 terms; literal and input magnitude 1 000 000. Totals therefore stay safe integers.
- **D-08 Where roll records live (open question 2): their own store, `dice_rolls`.** Not the audit log
  and not the session log. Features 06 and 18 read through this feature's API. A roll is not an audit
  event: no envelope is queued, the applier refuses one, and no feature 06 row is written. This resolves
  feature 06's own open question on the same point. `repository({ audited: false })` is an additive option
  on the browser repository.
- **D-09 Rolls are immutable.** Insert only, `version` always 1, no tombstone, no update, no reveal.
  Correcting a roll would change the fiction. Rows leave only with the campaign (`_db.md`).
- **D-10 Exactly once.** The record id is generated on the device before queueing. A retried mutation
  returns its receipt. A resend under a new mutation id compares the stored row: identical is accepted as
  the same roll, anything else is refused with the one indistinguishable `not_found_or_forbidden`.
- **D-11 Visibility mapping.** FR-008's value is stored as `roll_visibility`, beside the standard feature
  04 columns that the stream filters on. One pure function maps them:

  | `roll_visibility` | feature 04 Visibility | Reaches |
  | --- | --- | --- |
  | `public` | `everyone` | Every reader |
  | `gm_only` | `gm_only` | GM roles |
  | `blind` | `gm_only` | GM roles. Distinct label: rolled on behalf of `target_ref`, shown to no one else |
  | `player_only` | `players:[actor]` | The roller and GM roles |
  | `whisper` | `players:[actor, ...recipients]` | The roller, recipients, and GM roles |

  GM roles read targeted rows by the standard feature 04 rule, so a player's `whisper` to the GM names no
  recipient beyond the GM: `whisper` requires one named recipient, and a private roll visible to the GM is
  `player_only`. A database CHECK ties the label to the columns.
- **D-12 An actor can only create a roll they could read.** Client-side rolling means the roller's
  device has already seen the result, so a player cannot create `gm_only` or `blind`: that row would have
  to be on their replica, which BDD and PRD forbid. The rule is expressed through feature 04, with no role
  check: `decide(actor, 'create', facts)` and `decide(actor, 'read', facts)` must both allow, on the device
  and at the authority. A player's blind check is a GM rolling blind with the player as `target_ref`.
- **D-13 Recipients are not checked against membership.** A stream row requires a current membership, so a
  stale recipient receives nothing, and a whisper queued offline to someone who left the campaign keeps its
  place in history instead of being refused.
- **D-14 The authority replays, it does not re-roll (ADR-001).** The applier reparses the expression and
  replays stored faces through the evaluator: a record must reproduce itself exactly. That catches corrupt
  and malformed records. It does not prove fairness, and a modified client can still choose its faces: the
  product is a trust-based table tool.
- **D-15 Local retention: all rolls replicate, no window, in P0.** A measured unit test holds both MVP
  paradigms' typical record (`1d20+ATTRIBUTE_A`, `4dF + skill`, with refs, action, and session) under the
  10 MB allowance for the 4 800-roll projection, at the freeze's 2.2x overhead. Measured: 837 bytes of
  raw row for the d20 and 904 for 4dF, so 8.8 MB and 9.5 MB. That is well above the freeze's estimate of
  1.46 MB raw and leaves little margin. A many-dice roll costs more: seven dice measured 1 064 bytes, or
  11.2 MB at that volume. Trimming the verbose `result` JSON is the first lever if real sessions exceed the
  allowance; feature 18 owns that measurement, on the validation campaign.
- **D-16 Export (`ExportableModule`).** Roll history is campaign content, so it exports and imports like
  it. Names travel as `{ name, value }` pairs because the package's forbidden-key scan applies to keys.
  Actor ids, session ids, and caller refs are not exported in chunk version 1, because memberships are not
  imported and neither owner feature exists yet. Restored rolls belong to the importer. Unmapped targets
  narrow to `gm_only` per the feature 04 import rule. The offline export composition lists the rolls table
  as a replica gap until a contributor is added there.
- **D-17 No screen and no HTTP route in P0.** Rolls surface through features 15, 18, and 19, which own
  their screens. Writes go through `POST /sync/mutations`; reads come from the replica.

## Grammar

```text
expression := sum | pool-with-success
sum        := term { spaces? ('+' | '-') spaces? term }
term       := dice | integer | name
dice       := count 'd' die [ keep ]
die        := '4' | '6' | '8' | '10' | '12' | '20' | '100' | 'F'
keep       := ('kh' | 'kl') count
pool-with-success := dice spaces 'success' compare integer
compare    := '>=' | '>' | '<=' | '<' | '='
```

Spaces are U+0020 only, with none at either end and none inside a dice term. Integers have no leading zero
or sign. At least one dice term is required (`no_dice`).

## Module API

```ts
// @rpg/dice/engine: pure
export function parseRoll(source: string): Result<RollExpression, RollParseFailure>;
export function evaluateRoll(
  expression: RollExpression,
  inputs: RollInputs,
  random: RandomSource,
): Result<RollResult, RollEvaluationFailure>;
export function replayRoll(source: string, inputs: RollInputs, result: RollResult): boolean;
export function checkDiceSource(source: string): string | undefined; // ExpressionValidators.dice
export function seededRandom(seed: number): RandomSource;
export function cryptoRandom(): RandomSource;

export interface RollRequest {
  readonly expression: string;
  readonly inputs?: RollInputs;
}
export interface RollResult {
  readonly terms: readonly RollTerm[];
  readonly natural: number;
  readonly modified: number;
  readonly successes?: number;
}
export type RollTerm =
  | { kind: 'dice'; sign: 1 | -1; die: DieType; faces: readonly RolledDie[]; subtotal: number }
  | { kind: 'modifier'; sign: 1 | -1; value: number }
  | { kind: 'input'; sign: 1 | -1; name: string; value: number };
export interface RolledDie {
  readonly value: number;
  readonly kept: boolean;
  readonly success?: boolean;
}

// @rpg/dice: device API, consumed by features 11, 15, 18, 19
export class RollLocalRepository {
  roll(request: RollRequest & RollContext): Promise<Result<RollRecord, LocalRollError>>;
  get(id: string): Promise<RollRecord | undefined>;
  list(filter?: { sessionId?: string }): Promise<RollRecord[]>;
}

// @rpg/dice/postgres: authority
export class RollService {
  record(actor, input, options): Promise<RollWriteResult>;
}
```

`RandomSource` is `{ nextInt(bound): number }`, returning `0 <= n < bound`. `seededRandom` is mulberry32
with rejection sampling, integer arithmetic only, so it reproduces on every engine. `cryptoRandom` draws
`crypto.getRandomValues` with the same rejection sampling. Neither is read by the engine at module level.

## Mutation Applier

`DiceRollSyncMutationApplier` (feature `dice`, table `dice_rolls`):

1. `operation = insert`, `expectedVersion = null`, no audit envelope, payload matches
   `RollReplicaSchema`, ids bound to the mutation, actor equals the uploader. Otherwise `invalid_payload`.
2. `RollService.record`, inside one transaction: `checkRollRecord` (parse, label and Visibility agree,
   replay), both `decide` calls (D-12), then `recordAudit(tx)` for the access fence, then insert. The
   hook writes no audit event because no envelope exists.
3. An existing id compares rows (D-10). A persistence fault is `authority_unavailable`, retryable.

Error codes: `invalid_payload`, `invalid_roll`, `not_found_or_forbidden` (all terminal).

## Authorization, Offline, Sync

- **Authorization:** Resource Policy `dice_roll` below. Observers have no capability (deferred role).
- **Offline:** the device repository writes the replica and the queue in one local transaction, so the
  result is visible at once. Sync runs when connected.
- **Sync:** compiled stream `authorized_rolls`, with per-row predicates and no join but the membership row.
- **Conflicts:** none. Rolls are never updated. Identity collisions are refused (D-10).
- **Realtime, blobs:** N/A.

```ts
export const DICE_ROLL_POLICY: ResourcePolicy = {
  resourceClass: 'dice_roll',
  capabilities: ['read', 'create'],
  roleCapabilities: {
    owner: ['read', 'create'], gm: ['read', 'create'], assistant_gm: ['read', 'create'],
    player: ['read', 'create'], observer: [],
  },
  defaultVisibility: 'explicit',
  sync: { kind: 'replicated', source: 'dice_rolls', campaignColumn: 'campaign_id',
    visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
    deletedAtColumn: null },
};
```

## Paradigm Findings

Every declared expression parses in the final grammars, with no change to the fixtures.

- `4dF + skill`: `skill` is a named input. `inputs: ['skills']` names the repeater field, and `skill` is the
  rating feature 11 binds from it. Not a contract defect, and feature 11 owns the binding.
- `roll <= attribute`, `margin > 0`, `level + 3`: formula names bound at run time (feature 10 D-09).

## Test Strategy

- Unit: grammar and evaluator per BDD outline; determinism vectors in Bun and browser; seeded distribution;
  rejection sampling with a stub generator; adversarial input; replay tampering; source scan.
- Device: `RollLocalRepository` on the `SyncedRepository` double: immediate write, no audit, hidden refused.
- PostgreSQL: CHECKs, `RollService`, applier through the real composition root, retry and resend.
- Sync: drift gate, API and sync truth tables, PostgreSQL rendering, simulated replicas for every requester.
- Live PowerSync: exact rows per requester, zero hidden rolls, unchanged player checkpoint under hidden churn.
- E2E: offline roll in the browser replica through the production `BrowserSyncSession`, synchronized once;
  player browser replica holds zero hidden rolls.
- Mutation checks: tampered stream queries are reported, as feature 16 does.

## Affected Modules

- New: `packages/dice`, `apps/api/src/modules/dice`, `apps/web/src/features/dice`, migration
  `0014_dice_rolls`.
- `apps/api/src/runtime.ts`, `apps/api/src/modules/sync/sync-rules.ts`, `apps/api/src/modules/portability`.
- `infra/powersync/sync-config.yaml`, `drizzle.config.ts`, `docs/OFFLINE_SYNC_RUNTIME.md`.
- `packages/sync/src/browser.ts`: additive `audited` option.
- `apps/web/src/features/sync/useBrowserSync.ts`: replica table.
- `tools/guard/src/rules.ts`: engine purity, persistence entry point.

## Out of Scope

Formula evaluation (10). Success and outcome decisions (11). Screens (15, 18, 19). Animation. Everything P1
and P2 in the PRD.
