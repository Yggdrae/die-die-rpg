# Agent Kit

This repository uses one canonical skill set for Codex and Claude Code.

## Layout

```text
agent-kit/skills/      canonical source
.agents/skills/        generated Codex copy
.claude/skills/        generated Claude Code copy
AGENTS.md              Codex/project instructions
CLAUDE.md              Claude Code adapter importing AGENTS.md
```

## First Use

The generated skill directories are included in the kit. No setup is required after extraction at repository root.

## Editing Skills

Edit only `agent-kit/skills/`, then run:

```bash
bun agent-kit/scripts/sync-agent-kit.mjs
```

Commit canonical and generated copies together.

## Adding a Skill

Create:

```text
agent-kit/skills/<skill-name>/SKILL.md
```

Optional supporting files go under `references/` or `scripts/` inside the skill directory.

Use portable frontmatter:

```yaml
---
name: skill-name
description: Clear trigger description.
---
```

Then sync.

## Removing a Skill

Delete it from `agent-kit/skills/` and run the sync script. The generated copies are recreated from scratch, so stale skills disappear.
