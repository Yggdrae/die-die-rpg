# BDD: Dice Engine

Source: `_prd.md`, `PRD.md` s.20, s.21, s.76. P0 only. "Expression" is the dice notation; "inputs" is
the value map the caller resolves; "replica" is a device's local database.

## Notation

### Scenario Outline: An expression rolls as written

**Given** a seeded randomness source  
**When** `<expression>` is evaluated with inputs `<inputs>`  
**Then** the natural result is the sum of its kept dice, or its success count  
**And** the modified result is the natural result plus its modifiers  
**And** every die rolled is reported, with kept or dropped

| expression | inputs |
| --- | --- |
| `1d20` | none |
| `2d6+3` | none |
| `4d6kh3` | none |
| `4d6kl1` | none |
| `1d20+ATTRIBUTE_A` | `ATTRIBUTE_A: 2` |
| `4dF` | none |
| `4dF + skill` | `skill: 3` |
| `6d6 success>=6` | none |

### Scenario Outline: Every die type lands in its range

**When** `<die>` is rolled many times  
**Then** every face is within `<range>`

| die | range |
| --- | --- |
| d4 | 1 to 4 |
| d6 | 1 to 6 |
| d8 | 1 to 8 |
| d10 | 1 to 10 |
| d12 | 1 to 12 |
| d20 | 1 to 20 |
| d100 | 1 to 100 |
| dF | -1 to 1 |

### Scenario Outline: An invalid expression is rejected at parse, never guessed

**When** `<expression>` is parsed  
**Then** parsing fails with `<code>`  
**And** no die is rolled

| expression | code |
| --- | --- |
| `` (empty) | syntax |
| `d20` | syntax |
| `1d7` | unknown_die |
| `1D20` | syntax |
| `0d6` | out_of_bounds |
| `4d6kh0` | out_of_bounds |
| `4d6kh5` | out_of_bounds |
| `4d6 kh3` | syntax |
| `4d6kh3kl1` | syntax |
| `2d6*2` | syntax |
| `(1d6)` | syntax |
| `-1+1d6` | syntax |
| `1d6+` | syntax |
| `3+2` | no_dice |
| `skill` | no_dice |
| `2d6+1 success>=6` | invalid_success |
| `1d6+1d6 success>=6` | invalid_success |
| `6d6success>=6` | syntax |
| `6d6 success>=x` | syntax |
| `1000d6` | out_of_bounds |
| `101d6` | out_of_bounds |
| `60d6+60d6` | out_of_bounds |
| `1d6+99999999` | out_of_bounds |
| `1d6+d20` | reserved_name |
| `1d6+success` | reserved_name |
| `1d6+constructor` | reserved_name |

### Scenario: Oversized input cannot hang a client

**Given** a pasted expression past the size limit, or a term count past the limit  
**When** it is parsed  
**Then** it fails with `out_of_bounds` in bounded time

### Scenario: The caller resolves names

**Given** an expression naming `ATTRIBUTE_A`  
**When** it is evaluated with no value for that name  
**Then** the result is a `missing_input` failure  
**And** a fractional, out-of-range, or non-numeric value is an `invalid_input` failure  
**And** the engine reads no character, system, or formula

## Determinism and Randomness

### Scenario: The same seed reproduces the same roll

**Given** a published table of seed, expression, and result  
**When** it runs in Bun and in a browser  
**Then** every result matches the table exactly

### Scenario: Production randomness is cryptographic and unbiased

**Given** the production source  
**When** a die is rolled  
**Then** the value comes from the platform's cryptographic generator  
**And** a value that would bias the die is discarded and redrawn

### Scenario: A result can be replayed against its expression

**Given** a recorded result  
**When** its faces are replayed through the evaluator  
**Then** a faithful record reproduces itself  
**And** a changed face, total, kept flag, or a face outside the die's range is refused

## Recording

### Scenario: A roll records its context

**Given** an actor rolling with a target, an action, a session, and a visibility  
**When** the roll is recorded  
**Then** the record holds actor, target, action, expression, visibility, natural result, modified result,
timestamp, and session

### Scenario: Rolling works with no network

**Given** a device with no connection  
**When** a member rolls  
**Then** the result and the record exist at once in the replica  
**And** the record reaches the authority once connected

### Scenario: A roll is recorded exactly once

**Given** a queued roll  
**When** its upload is retried, including after a lost acknowledgement, or resent under a new mutation  
**Then** the authority holds exactly one record for that roll  
**And** a different roll claiming an existing identity is refused and changes nothing

### Scenario: A record cannot be edited or removed

**When** an update or a delete of a roll is uploaded  
**Then** it is refused

### Scenario Outline: The authority refuses a malformed roll

**When** a member uploads a roll with <defect>  
**Then** it is refused and nothing is stored

| defect |
| --- |
| another member named as its actor |
| an expression that does not parse |
| a result that does not replay from its expression and inputs |
| a visibility value inconsistent with its stored Visibility |
| an audit envelope (rolls are not audit events) |

## Visibility

### Scenario Outline: Who receives a roll

**Given** a roll by <actor> with visibility <visibility>  
**Then** GM roles receive it  
**And** the roller receives it when <roller>  
**And** a named recipient receives it when <recipient>  
**And** any other player's replica never receives it

| actor | visibility | roller | recipient |
| --- | --- | --- | --- |
| GM | public | yes | everyone |
| GM | gm_only | yes | no |
| GM | blind | yes | no |
| GM | player_only | yes | no |
| GM | whisper | yes | yes |
| player | public | yes | everyone |
| player | player_only | yes | no |
| player | whisper | yes | yes |

### Scenario: A public roll reaches every player

**Given** a public roll  
**Then** every current player's replica receives it

### Scenario Outline: A player cannot create a roll hidden from themself

**Given** a player  
**When** they roll with visibility <visibility>, on the device or by a crafted upload  
**Then** it is refused and nothing is stored, because rolling on their own device would already
have shown them the result

| visibility |
| --- |
| gm_only |
| blind |

### Scenario: A hidden roll is absent from a player replica, not filtered

**Given** GM-only and blind rolls among public rolls in a campaign  
**When** a player's replica synchronizes  
**Then** the replica holds zero hidden rolls, asserted against its stored rows  
**And** no checkpoint or payload to that player changes while hidden rolls are written

### Scenario: Former and foreign members receive nothing

**Given** a removed member, a non-member, or the owner of another campaign  
**When** they synchronize  
**Then** they receive no roll of this campaign

## Retention and Export

### Scenario: Roll history travels with the campaign

**Given** a campaign with public and hidden rolls  
**When** it is exported and imported  
**Then** the rolls are restored with their results  
**And** a roll targeted at an unmapped member narrows to GM-only, with a warning, and never widens

### Scenario: Roll storage stays inside its local budget

**Given** the validation campaign's projected 4 800 rolls  
**When** their stored size is measured  
**Then** it stays inside the feature's 10 MB local allowance

## At Package Load

### Scenario: A bad dice expression refuses a system package

**Given** a package with an expression the engine rejects  
**When** the registry loads it through the engine's validator  
**Then** loading fails with `invalid_expression` at that path

### Scenario: Both paradigm packages load

**Given** the two invented systems, including `4dF + skill`  
**When** the registry loads them through the engines' validators  
**Then** they load with no engine change specific to either

## Traceability

| PRD | Scenarios |
| --- | --- |
| FR-001 | Every die type lands in its range |
| FR-002, FR-003 | An expression rolls as written; An invalid expression is rejected |
| FR-004 | The caller resolves names |
| FR-005 | An invalid expression; A bad dice expression refuses a package |
| FR-006 | An expression rolls as written; A result can be replayed |
| FR-007 | A roll records its context |
| FR-008 | Who receives a roll; A player cannot create a roll hidden from themself |
| FR-009 | Rolling works with no network; exactly once; absent from a player replica |
| FR-010 | Determinism and Randomness |
| FR-011 | Oversized input; out_of_bounds rows |
| FR-012 | Published API in `_techspec.md`; Rolling works with no network |
