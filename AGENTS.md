# Codex Relay agent entry point

For an installation request, read [INSTALL.md](INSTALL.md) and execute its complete procedure. Do not infer installation from this file alone or install while doing development work. The repository is the distribution: no release archive, npm install, compilation, plugin marketplace, or global executable is required.

For usage, read [skills/codex-relay/SKILL.md](skills/codex-relay/SKILL.md). The installer substitutes the actual executable and source paths into the installed skill. Use that installed skill after installation.

For a request to create or select a Codex execution chat and follow it to a finish condition, default to the current conversation as supervisor. Use the Skill's `codex_supervise` workflow for readiness checks, wake selection, and durable registration. Verify current-session identity with installed CLI `host` in the current shell for every MCP setup; shared MCP startup identity can be stale. Pass only supported supervisor fields, not the full host output. Do not ask the user to choose tools or guess recent sessions. Require Standard for the entire execution and supervision session at creation/takeover; ordinary messages inherit the session setting. Block known Fast or unverified state without rewriting global settings. Do not substitute a new chat for a failed or uncertain creation.

For development:
- Keep source, comments, CLI messages, skills, and documentation in English. Chinese is allowed only in files ending in `_zh.md`.
- Keep Node and Bun execution working without dependencies or transpilation.
- CLI and MCP share `src/tasks/tools.mjs`; fix behavior there rather than creating separate implementations.
- Use `node --test test/*.test.mjs` and `bun test` for isolated validation. Tests must use temporary homes/pipes; never modify real user configuration, launch/focus Codex, or create live tasks.
- The desktop adapter uses internal Codex interfaces. Windows is the only platform tested with a live desktop; macOS and Linux paths are implemented and covered by isolated tests only. Do not claim live support on them without a live verification. Preserve honest diagnostic states when the host requires reload or is incompatible.
- Do not publish, push, install on the real account, or restart desktop applications as part of repository development.
