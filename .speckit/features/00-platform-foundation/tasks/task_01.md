# Task 01: Repository and Tooling Baseline

## Goal

A working Bun monorepo with strict TypeScript, Biome, and a test runner, where the four
verification scripts every later task depends on exist and pass on an empty tree.

## Dependencies

- none. This task blocks every other task in the feature.

## Context

- PRD: `../_prd.md` (FR-001, FR-002)
- TechSpec: `../_techspec.md` (Current State, Proposed Architecture)
- Stack is already decided: `PRD.md` s.63, s.91 and `docs/SPEC_GUIDELINE.md`. Do not re-open it.
- The repository is **not** currently a git repository. `git init` is part of this task.

## Scope

### Change

- `git init`, `.gitignore`.
- Root `package.json` with Bun workspaces covering `apps/*`, `packages/*`, `tools/*`.
- `packages/config/`: shared strict `tsconfig`, Biome configuration, test configuration.
- Root scripts: `check` (Biome), `typecheck` (tsc `--noEmit` across workspaces), `test`, `build`.
- Directory skeleton only for what this feature creates: `apps/`, `packages/`, `tools/`, `spike/`.

### Do Not Change

- Do not create the other packages listed in `PRD.md` s.64. Each is created by its owning feature.
- Do not add React, Fastify, TypeBox, or PowerSync here. Tasks 03, 07, and 10 add their own.
- Do not write any contract, fixture, or application code.

## Acceptance Criteria

- [ ] Repository is a git repository with a first commit.
- [ ] `bun install` succeeds from a clean clone.
- [ ] All four verification scripts exist and exit zero on the empty tree.
- [ ] TypeScript is strict. `any` is a lint error, not a warning (`docs/SPEC_GUIDELINE.md`).
- [ ] Workspace resolution works: a package can import another workspace package by name.
- [ ] Two open decisions are made and recorded in the commit message or a short note:
      Bun Workspaces alone or with Turborepo, and Vitest or Bun Test.

## Verification

```bash
bun install && bun run check && bun run typecheck && bun test && bun run build
```

## Notes

- Keep this task short. It is on the critical path for all five other work streams, and every
  hour here is an hour three developers are partially blocked.
- The two tooling decisions are reversible and local. Pick one, record it, move on. Do not
  escalate them.
