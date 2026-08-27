# Kit Changelog

## Current Revision

- Entire kit translated to English.
- Reworked for Codex + Claude Code instead of Cursor-specific commands.
- Added canonical `agent-kit/skills/` source plus generated `.agents/skills/` and `.claude/skills/` copies.
- Added `AGENTS.md` as the shared project instruction file.
- Added `CLAUDE.md` as a thin Claude Code adapter importing `AGENTS.md`.
- Added mandatory Caveman Mode for terse engineering output and minimal diffs.
- Removed redundant editor-specific command wrappers.
- Preserved the Fastify + TypeBox stack guidance.
- Kept PostgreSQL, PowerSync/SQLite, MinIO, Yjs, and WebSocket responsibility-based instead of mandatory for every feature.
- Kept pragmatic DDD; abstractions are not checklist requirements.
- Kept scoped task verification and full PR/merge gates separate.
- Kept external research conditional rather than ritual.
