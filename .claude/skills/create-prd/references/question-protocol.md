# Question Protocol

Ask only when missing information materially blocks a correct artifact and cannot be inferred from repository context.

## Prefer repository evidence first

Check, in order when relevant:
1. existing feature artifacts;
2. ADRs;
3. code/configuration;
4. tests;
5. project documentation.

## Good questions

A good question:
- changes product scope, behavior, security, persistence, or architecture;
- cannot be answered from repository evidence;
- presents concrete alternatives when possible;
- asks one decision at a time.

## Avoid

Do not ask:
- questions already answered by the repository;
- implementation trivia that can be decided locally and reversibly;
- broad preference questions without concrete consequences;
- confirmation for every inferred low-risk detail.

## Unresolved information

If work can continue safely, write `TODO:` and proceed instead of blocking the artifact.
