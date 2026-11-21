# Task 01: Contract additions and effect validation

Status: completed (2026-11-01)

## Scope

- `@rpg/systems`: `picks`, `prompts`, `derived`; semantic checks; `effects` port; `invalid_effect`; paradigm packages on the final kinds.
- `@rpg/actions` engine: kinds, `checkEffectKind`, `checkSystemEffects`; composition validators.

## Acceptance Criteria

- BDD "A package with a bad effect is refused at load" passes.
- Both paradigm packages and the fixture load with every validator.

## Verification

```bash
bun test packages/systems packages/actions apps/api/src/modules/systems
```
