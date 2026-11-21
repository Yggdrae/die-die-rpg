# BDD: Action and Effect Engine

Source: `_prd.md`, `PRD.md` s.19, s.22, s.23, s.27, s.57, s.76. P0 only. "Target" is whatever carries the
state an effect changes. "Plan" is the inspectable value produced before anything is written.

## Executing a Declared Action

### Scenario: A roll-under action decides its outcome from the declaration

**Given** a system declaring a save: roll `1d20`, succeed when `roll <= attribute`, with `attribute` picked
from three fields  
**When** the actor picks a field holding 11 and the roll comes up 11, then 12  
**Then** the first plan says success and the second says failure  
**And** no application code named the action

### Scenario: A roll-plus-modifier action reads a margin

**Given** a system declaring an attack: roll `4dF + skill`, `margin` derived as `roll - opposition`, and an
outcome when `margin > 0`  
**When** the actor picks a skill rated 3, enters opposition 2, and the dice total +1  
**Then** the margin is 2 and the matching outcome is selected  
**And** its options are offered, with none applied

### Scenario: The first matching outcome wins, in declared order

**Given** outcomes with `when` conditions and a last one with none  
**When** several could match  
**Then** the first true one is selected, and the one with no condition catches the rest

### Scenario Outline: A plan that cannot be built says why

**When** an action is prepared with <defect>  
**Then** it fails with `<code>` and rolls nothing

| defect | code |
| --- | --- |
| an unknown action key | unknown_action |
| a pick left out | missing_pick |
| a pick outside its declared fields | invalid_pick |
| a prompt left out with no default | missing_prompt |
| a named value the action does not declare | unknown_identifier |

## Plan Then Apply

### Scenario: Planning writes nothing

**When** an action is planned and previewed  
**Then** every change appears with its before and after values  
**And** no state and no queue has changed

### Scenario: Declining applies nothing and records nothing

**Given** a plan a GM declines entirely  
**When** the decision is resolved  
**Then** there is nothing to apply and no record exists

### Scenario: A GM can edit or partly apply a plan

**Given** a plan with two effects  
**When** the GM changes an amount and declines the other  
**Then** only the edited effect applies, recomputed from the new amount  
**And** the record says it was edited, which the authority allows only for GM roles

### Scenario: A choice needs a choice

**Given** an outcome the table decides  
**When** it is resolved with no option, or an unknown one  
**Then** it is refused, and nothing is applied on the table's behalf

## Effect Kinds

### Scenario Outline: Each supported kind becomes semantic operations

**When** a plan holds <kind>  
**Then** it emits <operations>

| kind | operations |
| --- | --- |
| apply_damage on a pool | delta, then clamp to declared bounds |
| apply_damage on a pool with temporary points | delta on temporary first, then the remainder on current |
| heal | delta, then clamp |
| gain_resource | delta, then clamp |
| spend_resource | delta guarded by at least that amount, then clamp |
| modify_field with an amount | delta, then clamp to the field's bounds |
| modify_field with a value on a non-numeric field | set |
| add_condition with stacking count | delta |
| add_condition with stacking single | delta, then clamp to 0..1 |
| remove_condition | delta, then clamp at 0 |
| mark_box | set the box, guarded by unmarked |
| clear_box | set the box |
| fill_slot | set the slot, guarded by empty |
| clear_slot | set the slot |
| move_inventory_item | set the item's slot |

### Scenario: A numeric resource change is never an absolute write

**Given** any effect on a pool, a counter, or a numeric field  
**Then** its operations contain no `set`

### Scenario Outline: A deferred kind fails loudly

**Given** a package declaring <kind>  
**Then** the package loads  
**And** the plan marks it unsupported  
**And** applying it is refused unless explicitly declined, and never silently skipped

| kind |
| --- |
| advance_clock |
| trigger_event |
| reveal_knowledge |

### Scenario: Execute roll asks for another action

**Given** an effect that requests another action  
**When** the plan is resolved  
**Then** that action is returned to run next, and no state changes for it

### Scenario Outline: A package with a bad effect is refused at load

**Given** an effect with <defect>  
**When** the registry loads the package  
**Then** loading fails naming the path

| defect |
| --- |
| a kind outside the closed set |
| a required parameter missing |
| a parameter the kind does not take |
| a resource, field, condition, or inventory the package does not declare |
| a kind used on the wrong resource shape |
| a fractional amount |

## Resource Semantics

### Scenario: Several effects on one resource apply in declared order

**Given** a plan that deals 3 and then heals 2 on a pool at 4 of 5  
**Then** the preview reads 4 to 1 to 3

### Scenario: Damage past the pool reports its overflow

**Given** a pool at 2 taking 5  
**Then** it clamps at the minimum  
**And** the plan reports an overflow of 3, leaving what happens next to the declaration

### Scenario: Spending what is not there is refused

**Given** a spendable pool at 1  
**When** a plan spends 2  
**Then** the item is refused, and applying it is refused

### Scenario: Recovery follows the declared rule

**Given** recovery rules with a trigger, with and without an amount  
**When** recovery runs for that trigger  
**Then** a pool gains the amount, or returns to its maximum, as a plan like any other

### Scenario: A maximum can be a formula

**Given** a pool whose maximum is `level + 3`  
**Then** clamping uses the value computed from the target's own state

## Offline and Concurrency

### Scenario: Applying works with no network

**Given** a device with no connection  
**When** a member applies a plan  
**Then** it is recorded locally at once, and the target's displayed state includes it  
**And** it reaches the authority once connected

### Scenario: Concurrent offline changes merge

**Given** a pool at 10, a device applying 3 damage and another healing 2, both offline  
**When** both upload, in either order  
**Then** the pool is at 9, with no conflict and no overwrite

### Scenario: A replayed application never doubles

**Given** an accepted application  
**When** its mutation is retried, or the same record is resent under a new mutation  
**Then** the target changes once, and one record exists  
**And** a different record claiming that identity is refused and changes nothing

### Scenario: A guard failing at the authority refuses the whole application

**Given** two offline devices each spending the last point  
**When** both upload  
**Then** the second is refused, and the point is not spent twice  
**And** the device reports the refusal rather than a silent loss

## Atomicity, Authorization, Audit

### Scenario: All effects apply or none do

**Given** a plan whose later operation fails, or whose target write faults  
**Then** no state changed and no record exists

### Scenario Outline: Who may apply

**When** <actor> applies to <target>  
**Then** the result is <result>

| actor | target | result |
| --- | --- | --- |
| a GM role | any target in the campaign | accepted |
| a player | a target they own | accepted |
| a player | a target they do not own | refused, indistinguishable from missing |
| a player | a GM-only target | refused, indistinguishable from missing |
| a player | a path the target's owner denies them | refused |
| a former member | any target | refused |

### Scenario: Every application is audited with before and after values

**When** an application is accepted  
**Then** one audit event records each path's before and after, in the same transaction

### Scenario: A record never shows more than its target

**Given** an application on a GM-only target, or touching a GM-only resource  
**Then** a player's replica never receives the record

### Scenario: A plan shown to a player carries only what they may see

**Given** a plan touching a resource declared GM-only  
**When** it is prepared for a player  
**Then** that item's values are absent

## Generic Targets

### Scenario: Any target works, with no system conditional

**Given** two targets of different classes, and the two invented systems  
**When** each action runs through the same engine  
**Then** every one plans and applies with no branch on system or class

## Traceability

| PRD | Scenarios |
| --- | --- |
| FR-001, FR-002 | Executing a Declared Action |
| FR-003, FR-009 | Plan Then Apply |
| FR-004 | Effect Kinds |
| FR-005 | Resource Semantics |
| FR-006 | A numeric resource change is never an absolute write; Concurrent offline changes merge |
| FR-007 | All effects apply or none do |
| FR-008 | Any target works |
| FR-010 | Every application is audited |
| FR-011 | Applying works with no network |
| FR-012 | A replayed application never doubles |
| FR-013 | Published API in `_techspec.md` |
