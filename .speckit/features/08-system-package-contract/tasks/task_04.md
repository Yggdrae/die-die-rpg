# Task 04: System registry and summary projection

Status: completed (2026-10-30)

## Scope

- `registry.ts`: `SystemRegistry` with `load`, `loadAll`, `resolve`, `list`; canonical JSON comparison.
- `hasCapability`, `systemSummaryOf` (D-09), `systemDefinitionOf` (D-11).

## Acceptance Criteria

- BDD "Versions" and "Capabilities" sections.
- Numeric version order (`1.10.0` above `1.9.0`), not string order.
- One bad package among good ones is reported and the rest are served.
- Key order differences are not a version conflict; any value difference is.

## Verification

```bash
bun test packages/systems
```
