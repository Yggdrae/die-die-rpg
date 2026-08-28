# Feature Split Index

Source vision document: `PRD.md` (kept as-is, non-executable vision).
This index is the executable decomposition of that document into independent feature PRDs.

Language: English, per `docs/SPEC_GUIDELINE.md`. Source `PRD.md` remains pt-BR.

## Why this split exists

Three developers work in parallel. The source PRD describes one coupled platform.
Naive slicing (auth, then campaign, then system, then sheet, then session) serializes the team.

The split rule used here:

> A feature owns its data, its API, and its UI. Features never import each other.
> Features meet only at contracts frozen in `00-platform-foundation`.

Consequence: after the foundation wave, any developer can pull any unblocked feature
without waiting for another developer implementation, only for the contract.

## Feature list

| ID | Feature | Track | MVP | Owns (data) |
| --- | --- | --- | --- | --- |
| 00 | [platform-foundation](00-platform-foundation/_prd.md) | shared | yes | contracts, fixtures, CI |
| 01 | [identity-and-membership](01-identity-and-membership/_prd.md) | A | yes | user, credential, auth_session, invitation, campaign_membership |
| 02 | [campaign-lifecycle](02-campaign-lifecycle/_prd.md) | A | yes | campaign, campaign_system_pin, campaign_module_pin, campaign_setting |
| 03 | [offline-sync-platform](03-offline-sync-platform/_prd.md) | A | yes | local db, pending_mutation, tombstone, sync_state |
| 04 | [visibility-and-authorization](04-visibility-and-authorization/_prd.md) | A | yes | visibility_grant, permission policy, sync rules |
| 05 | [attachments-and-object-storage](05-attachments-and-object-storage/_prd.md) | A | yes | attachment, attachment_offline_state, object storage |
| 06 | [audit-log](06-audit-log/_prd.md) | A | yes | audit_event, private_audit_event |
| 07 | [campaign-import-export](07-campaign-import-export/_prd.md) | A | yes | export_job, rpgpack format |
| 08 | [system-package-contract](08-system-package-contract/_prd.md) | B | yes | system manifest schema, system registry |
| 09 | [dice-engine](09-dice-engine/_prd.md) | B | yes | roll |
| 10 | [formula-engine](10-formula-engine/_prd.md) | B | yes | none (pure) |
| 11 | [action-and-effect-engine](11-action-and-effect-engine/_prd.md) | B | yes | effect_application |
| 12 | [cairn-2e-system-package](12-cairn-2e-system-package/_prd.md) | B | yes | systems/cairn package assets |
| 13 | [fate-core-system-package](13-fate-core-system-package/_prd.md) | B | yes | systems/fate-core package assets |
| 14 | [rules-library](14-rules-library/_prd.md) | B | yes | rules_bookmark, rules_history |
| 15 | [dynamic-character-sheet](15-dynamic-character-sheet/_prd.md) | C | yes | character, character_state |
| 16 | [campaign-content-entities](16-campaign-content-entities/_prd.md) | C | yes | entity, entity_relationship, tag |
| 17 | [handouts-and-reveal](17-handouts-and-reveal/_prd.md) | C | yes | handout, handout_reveal |
| 18 | [session-mode](18-session-mode/_prd.md) | C | yes | session, session_participant, session_log_entry |
| 19 | [encounter-tracker](19-encounter-tracker/_prd.md) | C | yes | encounter, encounter_participant |
| 20 | [global-search](20-global-search/_prd.md) | C | yes | search index (derived, rebuildable) |

Tracks are a starting assignment, not a wall. Track A is platform and data, Track B is
rules and engines (pure packages, no infrastructure), Track C is campaign and play UX.

## Dependency graph

Only contract dependencies exist. No implementation dependency is allowed.

```text
                        00 platform-foundation
                                 |
   ---------------------------------------------------------------
   |                             |                               |
Track A                       Track B                         Track C
   |                             |                               |
  01 identity                 08 system-package               15 sheet
  02 campaign                 09 dice        10 formula        16 content
  03 sync                     11 action/effect                 17 handouts
  04 visibility               12 cairn       13 fate           18 session
  05 attachments              14 rules-library                 19 encounter
  06 audit                                                     20 search
  07 import/export
```

Contract-only edges (consumer to contract owner, never a code import of internals):

- 02, 15, 19 depend on `SystemRef`, `SystemSummary`, `CapabilityKey` (08)
- 11 depends on `RollRequest` / `RollResult` (09), `FormulaSource` (10), `SemanticOp` (00)
- 15, 16, 17, 18, 19 depend on `EntityEnvelope`, `Visibility` (00), enforced by 04
- 07 depends on `ExportableModule` (00), implemented once per owning feature
- 20 depends on `SearchIndexer` (00), implemented once per owning feature
- every persisted feature depends on `SyncedRepository` (00), implemented by 03

## Suggested wave plan

Waves sequence risk, they are not gates. A developer who finishes early pulls the next
unblocked feature from any track.

| Wave | Dev A | Dev B | Dev C |
| --- | --- | --- | --- |
| 0 | 00 foundation, all three together, then freeze | 00 | 00 |
| 1 | 01 identity | 08 system-package, 09 dice | 15 dynamic-character-sheet |
| 2 | 02 campaign, 04 visibility | 10 formula, 11 action/effect | 16 campaign-content-entities |
| 3 | 03 offline-sync-platform | 12 cairn, 13 fate | 17 handouts, 18 session-mode |
| 4 | 05 attachments, 06 audit, 07 import/export | 14 rules-library | 19 encounter, 20 search |

Wave 3 for Dev A is the largest single risk in the plan. Features built in waves 1-2 run
against a local repository implementation of `SyncedRepository`; wave 3 swaps the
implementation without changing feature code. If that assumption is wrong it is wrong for
everyone at once, so it is validated by a spike inside wave 0.

## Definition of Ready — the freeze gate

The three tracks start on the same day. From that day, no developer should ever stop and wait for
an answer that lives outside their own track. That is the whole gate, and it is met when every
line below is true.

**Contracts frozen** (00 FR-003, FR-004)

- Cross-cutting shapes: `EntityEnvelope`, `Visibility`, `Role`, `ActorRef`, `ApiError`, `Result`,
  `SemanticOp`, `SyncedRepository`, `AttachmentRef`, `AuditEvent`, `SystemRef`, `CapabilityKey`.
- Registry contracts: `ExportableModule`, `SearchIndexer`, `SessionQuickAction`.
- Long-text concurrency semantics for MVP: single-writer or optimistic concurrency.
- Local database size budget, from which 03, 06, and 09 each pick their own retention independently.

**Spike answered** (00 FR-011)

- Offline write in SQLite/WASM reaches PostgreSQL through PowerSync and back: go or no-go.
- SQLite/WASM full-text search available: yes or no. Gates 14 and 20.

**Environment and gates** (00 FR-001, FR-002, FR-006, FR-007, FR-009, FR-010)

- Monorepo, Bun, strict TypeScript, Biome, test runner, Vite/PWA shell, Fastify shell.
- CI running Biome, typecheck, tests, build on every pull request.
- PostgreSQL and MinIO from one documented command.
- Architecture guard failing the build on system-identity checks and cross-feature imports.
- Code ownership mapping each feature directory to its track.

**Fixtures** (00 FR-005)

- Sandbox campaign, fixture character schema, and fixture rules tree, none of them Cairn or Fate.

**Product decisions made** — not developer calls, and not in 00 scope. See the table below.

**Specs generated** — all techspecs and tasks, produced in one pass after the tag, when the
contracts they describe are real.

Not part of the gate: `00` FR-101 and FR-102 are P1 and land after the tracks are already running.
Feature 00 is never complete at the tag, and it is not supposed to be.

### Product decisions made during wave 0

| Decision | Outcome | Track |
| --- | --- | --- |
| Cairn 2e and Fate Core licensing | Official SRD-derived text/data only, with required Creative Commons attribution and share-alike compliance; no book artwork, layout, logos, or trademarks without separate permission | B |
| Can a GM read player-authored notes? | No; those notes are private to their author | C |
| Is `observer` in MVP scope? | No; deferred while the contract value remains reserved | A |
| What players see in Session Mode and encounters | Only revealed/public information, their own character/state, and permitted party summaries; never GM notes, hidden rolls, unrevealed entities, or enemy statistics | C |
| Maximum file size and MIME allowlist | 25 MB; PDF, JPEG, PNG, and WebP only | A |

## Artifacts per feature

Each developer generates their own artifacts for the features they own, after the
`00-platform-foundation` freeze tag. Full flow per feature:

```text
PRD (done) -> BDD -> Domain -> TechSpec -> DB -> Tasks -> Execute -> Verify
```

`docs/SPEC_GUIDELINE.md` gates `_bdd.md`, `_domain.md`, and `_db.md` on whether they are
meaningful. They are not meaningful everywhere. Recommended per feature:

| Feature | BDD | Domain | DB |
| --- | --- | --- | --- |
| 01, 02, 05, 15, 16, 17, 18, 19 | yes | — | yes |
| 03, 04 | yes | yes | yes |
| 11 | yes | yes | — |
| 06, 07, 14, 20 | light | — | yes (06, 07) |
| 08 | light | — | — |
| 09, 10, 12, 13 | no | — | no |

Reasoning for the exclusions, so nobody adds ceremony back:

- `09`, `10` are pure functions with no persistence. Unit tests are the specification.
- `12`, `13` are declarative data, not behavior. The conformance kit (08 FR-013) is their test.
- `03`, `04`, `11` carry real domain rules — conflict strategy, permission resolution, effect
  application — and are the three features where a `_domain.md` earns its cost.
- `00` needs none of them: no user-observable behavior, no domain rules, no persistence of its own.

## Rules that keep features independent

1. A feature never reads or writes tables owned by another feature. It calls the owner module API.
2. A feature never imports internal modules of another feature. Contracts only.
3. No generic page, service, or component branches on system identity.
   A check on a system id fails review. Read `system.capabilities` instead (`PRD.md` s.89).
4. Cross-feature UI composition uses slot registration owned by the host feature, not imports.
5. Cross-cutting concerns use a registry contract so each owner contributes independently:
   export (`ExportableModule`), search (`SearchIndexer`), audit (`AuditEvent`), session quick actions (slots).
6. Contract changes after freeze require a written contract-change note in `00-platform-foundation/`
   and review from one developer per track, within one working day.
7. Until a dependency ships, build against `@rpg/fixtures`. Never against a branch owned by another developer.

## Resolving a question that spans two features

A question that spans features is never settled by negotiation between developers. A negotiation
is a synchronous coordination point, and enough of them rebuild the serialization this split
exists to remove. Convert the question into a contract owned by one feature instead. In order:

1. **Is it data?** The owner named in the feature list table owns it. Every other feature calls
   that owner module API and stores nothing of its own. This is rule 1 restated, and it settles
   most apparent conflicts with no conversation at all.
2. **Is it a shape two tracks must agree on?** It becomes a published contract: `00` for
   cross-cutting shapes, `08` for system-domain shapes. The upstream feature publishes it early,
   the downstream feature consumes it. Normal dependency direction, no negotiation.
3. **Is it inside one track?** That track developer decides alone and records the decision in
   their techspec. No other developer needs to know.

Only a genuinely new cross-cutting shape found mid-flight escalates, and it escalates through
rule 6: a written note, one reviewer per track, same working day. Asynchronous, never a meeting.

Worked examples, all four resolved without coordination:

| Question | Path | Resolution |
| --- | --- | --- |
| Where does inventory live? | data | Character state, owned by 15. Feature 11 mutates it through the 15 API, as it already does for damage and heal. |
| Where do roll records live? | data | Owned by 09 per the feature list. Features 06 and 18 read through the 09 API. Duplicate storage is forbidden by rule 1. |
| Are conditions tags or structured state? | shape | A condition is a system concept. `08` owns the `Condition` contract and publishes it early in wave 1; 11, 15, 19 consume it. |
| Single-writer or optimistic concurrency for long text? | shape | `SyncedRepository` semantics, so a `00` decision, settled at the freeze before parallel work starts. |

## Deferred features

Deferred from the MVP split. No PRD written until demonstrated need (`docs/SPEC_GUIDELINE.md`, YAGNI).
Source sections listed for traceability.

| Deferred feature | Source | Target |
| --- | --- | --- |
| Clocks | `PRD.md` s.40, s.50 | V1 |
| Clues and clue redundancy | s.38, s.85 | V1 |
| Secrets and knowledge visibility | s.37, s.39, s.84 | V1 |
| Events and timeline | s.41, s.42 | V1 |
| Contextual rules suggestions | s.27 | V1 |
| Collaborative notes (Yjs) and document storage | s.57, s.58 | V1 |
| Presence and ephemeral realtime (WebSocket) | s.56 | V1 |
| Knowledge graph UI | s.36, s.70 | V1 |
| Hidden mechanics / hidden intervention module | s.48, s.86 | V1/V2 |
| Module engine and module manifest | s.50, s.51 | V2 |
| Systems P1/P2/P3 | s.11, s.12, s.13 | V1/V2 |
| Custom system builder, module builder, SDK, marketplace | s.73, s.74 | V3 |

MVP ships two forward-compatibility hooks so the deferred list does not force a rewrite:
`CapabilityKey` (08) and module pinning on the campaign (02). Nothing else is built ahead of need.

## Validation

The sandbox campaign "The Missing Caravan" (`PRD.md` s.81 to s.87) ships as fixture data in
feature 00 and is the shared test corpus for every feature. Multiplayer test scenarios
s.87.1 to s.87.8 map to features 01, 15, 17, 03, deferred (Yjs), 03, deferred (clock), and 14.
