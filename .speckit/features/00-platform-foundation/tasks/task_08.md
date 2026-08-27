# Task 08: Local Development Stack

## Goal

PostgreSQL and MinIO available from one documented command, so features 03, 05, and the spike do
not each invent their own environment.

## Dependencies

- Task 01

## Context

- PRD: `../_prd.md` (FR-010)
- `PRD.md` s.54 (PostgreSQL as shared relational persistence), s.32 (MinIO as the default local
  S3-compatible implementation), s.91.
- Feature 05 depends on this for object storage; feature 03 and task 10 depend on it for PostgreSQL.

## Scope

### Change

- Container stack definition providing PostgreSQL and MinIO.
- One documented command to start it and one to stop it.
- Documented connection configuration through environment variables, with development defaults.
- A short section in the repository documentation covering start, stop, and reset.

### Do Not Change

- No schema, no migrations, no tables. Feature 01 creates the first migration in wave 1.
- No buckets beyond what the spike needs. Feature 05 owns the object storage layout.
- No production or deployment configuration. Nothing is deployed in the MVP wave plan.
- Do not add PowerSync services here. Task 10 adds whatever it needs inside `spike/` and throws it
  away; feature 03 decides what becomes permanent.

## Acceptance Criteria

- [ ] One command starts both services from a clean machine.
- [ ] PostgreSQL accepts a connection using the documented development configuration.
- [ ] MinIO is reachable and its console or API responds.
- [ ] Data survives a stop and start; a documented reset command discards it.
- [ ] Ports and environment variable names are documented, not implied. `docs/SPEC_GUIDELINE.md`
      forbids inventing them elsewhere, so this task is where they become real.

## Verification

```bash
docker compose up -d && docker compose ps
```

Adjust to whichever runner this task selects, and record the actual command in the repository
documentation so later tasks and features cite it rather than guessing.

## Notes

- This is on the critical path to the spike, which is the long pole of the wave. Do it early, keep
  it minimal, and resist configuring anything the spike does not need.
