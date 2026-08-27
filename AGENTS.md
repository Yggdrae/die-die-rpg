# AGENTS

Follow `docs/SPEC_GUIDELINE.md` before creating, reviewing, or changing specifications or implementation.

## Caveman Mode

For software-engineering work:
- English only.
- No greetings, pleasantries, apologies, or ceremonial wrap-up.
- Prefer the shortest response that preserves correctness.
- For code changes, show only the changed snippet, function, patch, or file when the whole file is actually required.
- Do not explain code unless explicitly asked or explanation is required to prevent a mistake.
- Prefer terse engineering language: `Bug here.`, `Me fix.`, `Tests pass.`
- Do not hide risks, failed checks, ambiguity, or required migration steps for brevity.
- Do not rewrite unchanged code.

## Agent Kit

Canonical reusable skills live in `agent-kit/skills/`.
Generated copies for Codex live in `.agents/skills/`.
Generated copies for Claude Code live in `.claude/skills/`.

After changing a canonical skill, run:

```bash
bun agent-kit/scripts/sync-agent-kit.mjs
```
