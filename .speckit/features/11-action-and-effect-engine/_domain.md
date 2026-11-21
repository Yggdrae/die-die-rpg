# Domain: Action and Effect Engine

Source: `_prd.md`, `_bdd.md`, `PRD.md` s.19, s.22, s.23, s.27, s.57.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Action | What a system declares: a roll, what counts as success, and outcomes. Data, never code. |
| Target | Whatever carries the state an effect changes. Its class has an owner feature. |
| Target state | The published shape an owner stores: fields, resources, tracks, conditions, inventory, slots. |
| Prepared action | An action with picks and prompts resolved, ready to roll. |
| Plan | The inspectable result of a roll: outcome, items, previews. Nothing has been written. |
| Item | One effect in a plan, with its operations, previews, and status. |
| Decision | What a person did with a plan: accept, decline, edit, or choose. |
| Application | One accepted decision on one target, recorded once. |
| Planned operation | A `SemanticOp`, with an optional guard. |
| Guard | A condition on current state that must hold when the operation arrives, or the application is refused. |
| Overlay | The target's state as displayed: the owner's replica plus applications the authority has not accepted. |

## Invariants

1. Planning writes nothing.
2. An application changes state only through planned operations, in recorded order.
3. All of an application's operations apply, or none do, and its record exists only if they did.
4. An application identity changes a target at most once, however often it arrives.
5. A numeric change is a delta followed by a clamp, never a `set`.
6. A person decided every application. Nothing applies on the table's behalf.
7. A kind the engine cannot execute fails loudly, unless a person explicitly declined it.
8. No behaviour branches on which system or which target class is involved.
9. A record is never more visible than its target.

## State Transitions

```text
declared -> prepared -> rolled -> planned -> resolved -> recorded locally -> accepted
                                     |           |              |
                                  declined    refused      refused by the authority
                                 (nothing)    (nothing)    (kept as a rejected mutation, reported)
```

Accepted is terminal. There is no undo in MVP (FR-202).

## Ownership

| Concern | Owner |
| --- | --- |
| Kinds, resource semantics, ordering, guards, overlay | feature 11 |
| What a system's actions mean | features 12, 13 |
| Storing target state; what one actor may touch | features 15, 19 (through the adapter) |
| Who may update a target | feature 04, on the owner's policy |
| Rolling | feature 09 |
| Formula language | feature 10 |
