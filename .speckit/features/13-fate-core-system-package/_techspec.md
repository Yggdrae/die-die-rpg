# TechSpec: Fate Core System Package

Source: `_prd.md`, `PRD.md` s.9, s.10, s.14, s.15, s.22, s.27, s.89; feature 08 contract; feature 11 kinds. P0 only.

Mechanics were read from the official Fate SRD pages (dice and ladder, four actions, resolving attacks) and its licensing page
on 2026-11-01. Nothing in the package reproduces that text.

## Decisions (open PRD questions closed; delegated by the owner, 2026-11-01)

- **D-01 One JSON file: `systems/fate-core/system.json`,** on the same terms as feature 12 D-01.
- **D-02 No rules text ships in version 1,** on the same reasoning as feature 12 D-02. External documentation is declared
  honestly. The CC BY 3.0 attribution travels in the licence manifest, and feature 14 must show it.
- **D-03 Stress fits the contract (open question 1).** `shape: 'track'` expresses boxes, each with a value. Feature 08 needed no
  change for this, which is the question the PRD called most valuable. Boxes three and four are declared with labels naming
  the skill they need, because the rating that unlocks them is the table's reading of the sheet.
- **D-04 Consequences compose (open question 2).** A repeater with `slots` carries severity 2, 4, and 6, and each slot holds
  free text that plays as an aspect. No new primitive. The extreme consequence replaces an aspect, a sheet edit the table makes.
- **D-05 Game modes (open question 3): GM + Players, Theatre of the Mind.**
- **D-06 Style is three shifts.** The rules pages show three or more shifts in their examples without stating a threshold. Recorded
  as this package's reading. The outcome labels make it visible at the table.
- **D-07 Hits are offered, never applied (FR-010, `PRD.md` s.27).** A hit is a `choice`: mark physical stress, mark mental stress,
  take a consequence, taken out, or concede. Which box and which slot are selections at that moment. How many shifts a
  box or slot absorbs is the table's arithmetic, since a hit can spread across several.
- **D-08 Aspects created in play are sheet edits.** Creating an advantage or a boost writes free text the table composes, and the
  outcome label says what was earned. Feature 15 owns that surface.
- **D-09 Brand use stays `review-required`.** The trademark notice travels in the attribution. Owner action at the final audit.

## Mechanics As Declared

| Mechanic | Declaration |
| --- | --- |
| Roll | `4dF + skill`, `skill` picked from a repeater entry's `rating` |
| Margin | `prompts: opposition`, `derived: margin = roll - opposition` |
| Degrees | Ordered: `margin >= 3`, `margin >= 1`, `margin == 0`, otherwise failure |
| Aspects | Repeater with `entryTypes`: high concept, trouble, character, situation, boost |
| Skills | Repeater, `rating` on the ladder `adjectives`, -2 to +8 |
| Fate points | Spendable pool; refresh at `session_start` by `refresh - fate_points`, which never takes points away |
| Stress | Two tracks, cleared at `conflict_end` |
| Consequences | Three severity slots, cleared by `recover_consequence` |

## Findings Escalated To Feature 08

- **Actions with no roll,** shared with feature 12.
- **Picks, prompts, and derived values** (feature 11 D-07). Without them, `skill` and `margin` could not be declared at all.

## Test Strategy

`systems/packages.test.ts`: conformance with every engine; each row played through the real planner; a hit never applied on the
table's behalf; a filled slot refused; the last point not spent twice; refresh never reducing.

## Out of Scope

Stunt examples, guided creation, the Accelerated and Condensed variants, invocation tracking across a scene.
