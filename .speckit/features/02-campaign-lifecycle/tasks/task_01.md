# Task 01: Public campaign contracts and manifest-driven rules

Status: pending. Depends on feature 08 publishing an approved catalog/manifest contract or compatible fixture.

## Scope

- Create `packages/campaigns` and its public TypeBox request/result/context schemas.
- Define `SystemCatalog`, `CampaignContextResolver`, setting registry, and owner participant ports.
- Implement pure wizard-step, mode/option/module validation with no system-ID branch.
- Add focused contract/unit tests using the non-MVP fixture system.

## Acceptance Criteria

- Context includes campaign ID, exact `SystemRef`, mode, module pins, and settings.
- Unknown modes/options/modules and unregistered setting namespaces fail closed.
- No implementation type from feature 08 or another feature leaks through the public entry point.

## Verification

```bash
bun test packages/campaigns
bun run typecheck
bun run guard
```

