---
name: create-tasks
description: Convert an approved TechSpec into small, dependency-ordered implementation tasks with explicit scope, acceptance criteria, and verification.
---

# Create Tasks

1. Read PRD, BDD, TechSpec, optional domain/data docs, ADRs, and repository conventions.
2. Split work into independently implementable tasks with clear dependency order.
3. Keep each task focused. More than about 7 files or 7 substantive subtasks is a signal to split, not a hard law.
4. Put tests with the behavior they verify. Do not create a generic final `write tests` task.
5. Include concrete verification commands/checks appropriate to the scope.
6. Avoid circular dependencies between tasks.
7. Save the index to `.speckit/features/<feature>/_tasks.md` and individual tasks to `tasks/task_<NN>.md`.

Do not invent implementation details that contradict the TechSpec.
