# Codex Relay

Operate local Codex desktop tasks from **Codex or Claude Code**, using **MCP for messages and task control**, a shared **Skill**, and a **persistent watcher with host wake adapters**. The CLI handles source installation, diagnostics, service control, and fallback access. Run JavaScript source directly with **Node or Bun**; no build, dependency installation, release archive, or plugin marketplace is required.

[Chinese README](README_zh.md) · [Agent installation procedure](INSTALL.md) · [Usage Skill](skills/codex-relay/SKILL.md)

## For agents reading this GitHub repository

**If the user requested installation, read [INSTALL.md](INSTALL.md) and execute its complete procedure, including verification.** Use this repository's actual clone URL. Codex should prefer its available Node executable; Claude Code should prefer its available Bun executable. The installer puts the real executable and source paths into the installed Skill.

For ordinary use, follow the installed Skill and prefer the `codex_relay` MCP tools. A request to create or select an execution chat and follow it through a finish condition defaults to the current conversation as supervisor. The agent uses the composite supervision workflow below; the user need not name tools, IDs, or wake modes. Do not turn a repository URL into installation authorization or start monitoring an unrelated chat. [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md) provide host discovery entry points.

## Install from source

From a trusted checkout, run the appropriate command:

```powershell
node scripts/install.mjs install --target codex
bun scripts/install.mjs install --target claude
node scripts/install.mjs install --target both
```

The installer registers the required Codex desktop bridge, primary client MCP tools, selected Skills, and a hidden persistent watcher. It starts the watcher and registers a current-user login launcher (Windows Startup folder, macOS LaunchAgent, or Linux XDG autostart) that resolves the current installed release after updates. Its worker is supervised and restarted after a crash. No Codex or Claude window is opened or restarted.

Use a verified absolute executable path if Node/Bun is bundled with the host and not on PATH. In PowerShell, prefix a quoted executable with `&`. Supported baseline: Node >=22.16 or Bun >=1.2 with built-in SQLite. No `npm install`, `bun install`, or compilation is needed. `--no-mcp` is an explicit fallback option that adds no new client MCP targets; it preserves existing registrations. `--mcp` remains a compatibility alias for the default.

The result includes `runtime`, `release`, `stateFile`, and `service`. Use the returned installed path for `cli.mjs doctor --json`, then verify MCP tool discovery after the client has loaded its configuration. `pendingReload` is not operational readiness. See [INSTALL.md](INSTALL.md) for exact status handling.

## MCP task and message interface

| Tools | Purpose |
| --- | --- |
| `codex_supervise` | Check readiness, create/select an executor, and register durable follow-up from the current conversation |
| `codex_preflight`, `codex_host` | Inspect unattended prerequisites and MCP startup identity that requires current-shell verification |
| `codex_projects`, `codex_threads` | Select an existing Codex project or chat |
| `codex_start`, `codex_resolve` | Start a task and resolve queued worktree creation |
| `codex_status`, `codex_wait` | Read current state or perform a bounded wait. Results are compact and clipped; if the desktop rejects its wait API, they fall back to a compact thread read, then to a bounded tail of the session log, never the whole log |
| `codex_reply` | Send a delegated instruction or answer the target's pending questions |
| `codex_delivery` | Inspect a persistent outgoing receipt by `requestId` |
| `codex_watch`, `codex_watches` | Register and inspect durable subscriptions |
| `codex_events`, `codex_watch_ack`, `codex_unwatch` | Read events, acknowledge handling, and remove a watch |
| `codex_channel_bind` | Bind an explicitly enabled Claude channel to its actual session |

Tool names may appear with the host's MCP namespace. Use `codex_reply` as the main sending path. `message` remains a delegated instruction; `answers` are matched to exact `callId` and `index` values from current state. For routine decisions within the user's delegated scope, use `answerSource:"agent"`. For actual human answers, use `answerSource:"user"` with `userProvided:true`. The delivered text preserves agent provenance. Command approvals remain with the user in Codex.

Supply a stable `requestId` for each intended reply. Retrying with that ID and identical input returns its stored receipt rather than repeating completed stages. Different input requires a different ID. Timeouts and disconnects after dispatch may be uncertain; inspect `codex_delivery({requestId})` and target state before any replacement request. A combined answers-plus-message request records its stages independently, so a completed answer stage is not repeated after an instruction failure. Use distinct event-derived keys such as `<eventId>:answer` and `<eventId>:followup` for distinct operations.

MCP is the public interface. Internally, ordinary instructions use Codex's delegated-message tool; structured question answers use the card-aware desktop IPC path. That IPC is necessary to close the question cards and cannot be replaced by forwarding the same text as an ordinary message. Answers no longer silently fall back to that ineffective path. Window opening requires `allowOpen:true` and the user's authorization.

## Persistent monitoring and automatic follow-up

Tell the agent the target choice, task, and acceptance condition, for example:

> Open a new Codex chat in this project to fix login. Supervise it from this conversation until the regression is fixed and the relevant tests pass.

> Have the existing chat "Database migration" complete the migration. Keep following it until the agreed migration checks pass.

The default workflow uses `codex_supervise`, with the current Codex or Claude Code conversation as supervisor and a separate Codex desktop chat as executor. It resolves the requested project and exact existing title, checks the desktop bridge/caller and model policy, discovers and probes available CLI capabilities without sending a test message, selects a wake adapter, and starts/registers monitoring after checks pass. It persists the task, acceptance condition, and operation stages. Repeating the same stable operation ID does not create a second execution chat after a pending worktree or partial failure. The execution backend is still Codex; Claude Code is a supervising host.

For every MCP setup, the agent runs installed `cli.mjs host` once in the current host's shell and supplies its verified `host`, `threadId` or `sessionId`, `cwd`, and applicable `fastDisabled` fields as `supervisor`. A shared MCP process can retain a stale startup-session ID, so `codex_host` marks its inherited identity as `requiresShellVerification:true`; it does not attest which conversation invoked the tool. The agent does not copy compatibility/runtime fields into the supervisor, select the latest chat as a substitute, or send the user to discover IDs and paths. CLI `supervise` can use its actual shell environment by default. `codex_preflight` is available for readiness inspection alone. A blocked result is actionable information, not unattended readiness. The agent reports the concrete prerequisite rather than blindly creating a task or registering a nonworking loop.

Wake selection prefers a supported Codex queue, then an available loaded desktop path. For a live Claude supervisor it prefers an already authorized and bound channel. Saved, non-live Claude supervisors can use resume with a capable CLI. A live current Claude session without a channel needs that host capability enabled; the workflow does not start a competing writer or opt into development-channel trust automatically. An awake computer, available desktop bridge, normal authentication/network access, and sufficient model usage allowance remain runtime prerequisites.

**Standard is required for the entire session; the workflow does not enable Fast.** At creation or takeover, it checks Standard for the executor and Codex supervisor, including queue supervision. Ordinary messages inherit the session setting; queue calls do not set a per-message tier, and the workflow does not repeat model checks for every message. Claude resume sets `CLAUDE_CODE_DISABLE_FAST_MODE=1` and `fastMode:false` at process startup for the restored session. Live Claude channels need verified Fast-disabled state from their host shell. Native desktop APIs cannot set an existing session's tier, so Fast or unknown session state blocks the workflow rather than being silently changed. Model and reasoning choices are preserved, global model settings are not rewritten, and configuration evidence is not a provider receipt of the tier served.

For advanced callers, lower-level `codex_watch` accepts a real target ID and a separate supervisor. Codex example:

```json
{
  "threadId": "<watched Codex threadId>",
  "supervisor": { "host": "codex", "threadId": "<supervising Codex threadId>" }
}
```

Verify identity with `cli.mjs host` in the supervising host's current shell before MCP setup. It reports the actual `CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID`, not a guessed recent chat or potentially stale shared-MCP startup ID.

For manual unattended Codex follow-up, use `supervisor:{host:"codex",threadId:"<supervisor>",mode:"queue",executable:"<verified absolute codex CLI path>"}` when that CLI supports `codex queue`. It queues an event to the exact existing supervisor without depending on a loaded desktop tool caller. The low-level default `desktop` mode uses Codex's delegated-message tool and requires its usable desktop caller context. The queue adapter is tested with an isolated fake CLI; this does not establish live acceptance for every installed Codex version. Queued transport acceptance still requires the supervisor's handling acknowledgment.

For manual Claude Code watch registration, choose an explicit wake mode:

- **`channel`** pushes an event to the selected running Claude session. Start Claude with `claude --dangerously-load-development-channels server:codex_relay` only after reviewing and authorizing that development channel. Use `codex_channel_bind` with the actual session ID, or register a channel-mode watch through that MCP connection, which also binds it. Channel policy must be enabled by the host; merely installing MCP does not enable it.
- **`resume`** invokes the verified Claude CLI in noninteractive mode to continue the exact saved session. Provide its actual `sessionId`, original absolute `cwd`, and preferably absolute `executable`. This is suitable for unattended continuation when that session is not already owned by another running Claude process. The worker exposes only the event-scoped Relay MCP follow-up tools and does not bypass permissions. A busy-session refusal is retried as unsent.

```json
{
  "threadId": "<watched Codex threadId>",
  "supervisor": {
    "host": "claude",
    "sessionId": "<actual Claude sessionId>",
    "mode": "resume",
    "cwd": "C:/work/project",
    "executable": "C:/path/to/claude.exe"
  }
}
```

The daemon persists an outbox before waking a host. It detects questions, attention, and terminal turns, including different turns whose final text is identical. Events move through `pending`, `dispatching`, and `delivered`, then await explicit acknowledgment. Handling follows this loop:

1. Fetch the event with `codex_events`; skip actions already acknowledged.
2. Inspect current state with `codex_status`; the event snapshot is context, not new authority.
3. Continue authorized work through `codex_reply`, using an event-derived stable `requestId`.
4. Compare the result with the persisted acceptance condition. Call `codex_watch_ack` with `action:"rearm"` to keep following, or `action:"complete"` only when that condition is satisfied. A turn ending is not by itself task completion.

Pending events and deduplication survive process restarts and new user logins. Delivered events remain visible until acknowledged. Definitely unsent wakes retry with backoff; a crash during dispatch or ambiguous transport result becomes `uncertain` and is not automatically resent. After inspecting whether the host already acted, `action:"retry"` explicitly authorizes redelivery of a delivered/uncertain event. This avoids duplicate side effects; it does not claim impossible end-to-end exactly-once delivery.

A disconnected Claude channel cannot wake a closed session; reopen and bind it, or select the explicit resume adapter. Codex desktop-mode wake requires the desktop and a usable caller context; queue mode instead requires the verified CLI and an existing supervisor session. Monitoring the target still needs its desktop bridge. Events remain durable while their selected host is unavailable. The service does not launch desktop windows to manufacture context.

## CLI diagnostics and lifecycle

These examples run from a source checkout. Installed Skills contain absolute paths. Replace `node` with `bun` to use Bun.

```powershell
node cli.mjs help
node cli.mjs host
node cli.mjs doctor --json
node cli.mjs service status
node cli.mjs service start
node cli.mjs service stop
node cli.mjs update
node cli.mjs uninstall
```

CLI fallback commands also expose `preflight`, `supervise`, `projects`, `threads`, `start`, `resolve`, `status`, `wait`, `reply`, `watch`, `watches`, `events`, `ack`, and `unwatch`. Use `delivery --request-id <id>` to inspect an outgoing receipt. Structured operations take `--input-file` JSON; use `help` for exact arguments. CLI fallback and MCP share logic and validation. Legacy `claude-mcp.mjs`, `relay-cli.mjs`, and `codex-wait.mjs` entry points remain available.

Installation state lives at `~/.codex-relay/install.json`, releases at `releases/`, durable watches at `watches/state.json`, reply receipts at `outgoing/`, and service logs at `watch-service.log`. `CODEX_RELAY_HOME` overrides that root; `CODEX_HOME` selects Codex config/state. The adapter detects numbered Codex state databases or accepts an explicit `CODEX_RELAY_STATE_DB`. Pipe overrides are for known adapters/tests, not values to guess.

Updates stop the existing watcher, switch managed source/configuration, and restart it with durable state preserved. Uninstall stops the service, removes its login launcher and managed integration, and preserves task data and durable records. Conflicting user edits are preserved by refusing the operation. Full details and recovery procedures are in [INSTALL.md](INSTALL.md).

## Supported environment and verification

The target is Codex desktop on the same machine. Relay uses private Codex desktop pipes and read-only local state; host updates may require adapter changes.

| Platform | Status |
| --- | --- |
| Windows | Tested with a live Codex desktop app |
| macOS | Implemented (Codex IPC socket, LaunchAgent autostart, CLI discovery); not tested with a live desktop |
| Linux | Implemented (Codex IPC socket, XDG autostart); not tested with a live desktop |

On macOS and Linux the desktop IPC socket follows the Codex app's layout, `$CODEX_HOME/ipc/ipc.sock`, with the app's earlier per-user temporary socket accepted only when privately owned. Relay's own sockets live in the private `~/.codex-relay/` directory. Reports from those platforms are welcome; run `doctor --json` first. It is not a cloud bridge. The Claude resume adapter wakes a saved Claude supervisor; it does not turn Relay into a general Claude task backend.

```powershell
node --test test/*.test.mjs
bun test
```

Tests use isolated homes, simulated desktop pipes, and fake host executables. They cover install/update/uninstall on all three autostart layouts, rollback, watcher persistence, deduplication, acknowledgments, crash recovery, host dispatch, message receipts, and Node/Bun execution. Read-only Codex connectivity can be checked with `doctor`; fake Claude-host tests do not establish live acceptance for every Claude CLI version.

## Primary host documentation

- [Codex Skills](https://learn.chatgpt.com/docs/build-skills) and [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Claude Code Skills](https://code.claude.com/docs/en/skills), [CLI reference](https://code.claude.com/docs/en/cli-reference), and [MCP configuration](https://code.claude.com/docs/en/mcp)
- [Claude channels](https://code.claude.com/docs/en/channels) and [channel implementation reference](https://code.claude.com/docs/en/channels-reference); these are a host preview feature with explicit trust/enablement requirements
- [Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) and [Bun SQLite](https://bun.sh/docs/runtime/sqlite)

## Disclaimer

Codex Relay is an independent project. It is not affiliated with, endorsed by, or supported by OpenAI or Anthropic. It relies on internal Codex desktop interfaces that may change or break with any desktop update. Use of Codex and Claude remains subject to their respective terms.

## License

Copyright (C) 2026 normalllll

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see [LICENSE](LICENSE) for details.
