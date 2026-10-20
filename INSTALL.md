# Agent installation, activation, and maintenance

This is the installation procedure for an agent asked to install this GitHub repository. Execute it through verification and report the real diagnostic state. Do not hand routine command/path discovery back to the user. The installation request covers this tool's normal user-level configuration, MCP integration, and hidden watcher registration; host trust and sandbox controls still apply.

## 1. Requirements and source acquisition

The desktop adapter requires a local Codex desktop app. Windows is the only platform tested against a live desktop. macOS and Linux are implemented from the desktop app's socket layout and covered by isolated tests, but are untested with a live desktop; report their real `doctor` state and do not describe them as verified. Use a real Node >=22.16 or Bun >=1.2 executable with built-in SQLite. No npm/Bun dependency install, compilation, archive, or marketplace is required. Claude unattended resume additionally needs the actual Claude CLI executable and an existing session authenticated under the user's normal Claude configuration.

Use the GitHub repository URL supplied by the user. Clone that exact source into a suitable local checkout, read this file there, and honor a requested ref using a separate checkout. Otherwise use its default branch and record `git rev-parse HEAD`. Existing Git authentication is used for private sources. Do not invent an origin, initialize Git in an unrelated folder, reset a user's checkout, or put credentials in configuration or command arguments. When already in the requested checkout, use it.

The host must allow user configuration writes and local named-pipe (Windows) or Unix-socket (macOS/Linux) access. For `EPERM`/`EACCES`, use the host's normal permission escalation within the authorized scope. Do not weaken global sandbox or approval policy. A pipe permission denial does not mean the desktop needs restarting.

## 2. Choose the runtime and install target

For Codex prefer its available Node executable; for Claude Code prefer its available Bun executable. Both execute every source entry. Use the host's known runtime path, or locate `node`/`bun` with the shell and verify `--version`. `claude.exe` is not a standalone Bun interpreter. Recorded runtime paths can change when a bundled host runtime is upgraded; do not guess paths.

From the trusted checkout run the applicable command:

```powershell
node scripts/install.mjs install --target codex
bun scripts/install.mjs install --target claude
node scripts/install.mjs install --target both
```

Use `codex`/`claude` for the requested client, or `both` when both are requested; the default is `both`. Pass `--runtime` with a verified executable to override the selected interpreter. PowerShell needs `&` before a quoted executable, for example `& "C:/path/to/node.exe" "scripts/install.mjs" install --target both`. Keep executable and arguments separate.

MCP is installed by default and is the primary task/message interface. `--mcp` is a compatibility alias. `--no-mcp` adds no new client MCP targets and preserves existing registrations; use it only when the user explicitly needs CLI fallback. The desktop bridge and persistent watcher remain required by this adapter.

An install `--dry-run` validates source/runtime/conflicts without changing configuration or Skills; it may create the state directory and a temporary lock. `--home <absolute-directory>` is an isolated test/profile mode that redirects every destination, ignores real `CODEX_HOME`/`CODEX_RELAY_HOME`, and never starts or stops a service. With `--home`, tests may add `--platform win32|darwin|linux` to generate another platform's autostart layout. Do not use it for normal user installation.

## 3. Inspect the result and configured components

The installer returns JSON containing `runtime`, immutable source `release`, `stateFile`, `targets`, `mcpTargets`, and `service`. It installs:

| Component | Default location |
| --- | --- |
| Source snapshots | `~/.codex-relay/releases/<content-hash>/` |
| Installation record | `~/.codex-relay/install.json` |
| Codex Skill | `~/.agents/skills/codex-relay/` |
| Claude Skill | `~/.claude/skills/codex-relay/` |
| Required desktop bridge | `mcp_servers.codex_relay_bridge` in `~/.codex/config.toml` |
| Primary Codex MCP tools | `mcp_servers.codex_relay` in the same TOML file |
| Primary Claude MCP tools | `mcpServers.codex_relay` in `~/.claude.json` |
| Stable service launcher | `~/.codex-relay/service.mjs` |
| Hidden current-user login entry | Windows: `Codex Relay.vbs` in the user's Startup folder; macOS: `~/Library/LaunchAgents/local.codex-relay.watcher.plist`; Linux: `$XDG_CONFIG_HOME/autostart/codex-relay.desktop` (default `~/.config/autostart/`) |
| Durable watch state | `~/.codex-relay/watches/state.json` |
| Reply delivery receipts | `~/.codex-relay/outgoing/` |

The normal install starts a hidden watcher supervisor immediately and registers recovery at user login. The supervisor restarts its worker after a crash. Login recovery follows the installation record to the current immutable release. It does not start before user login or launch a Codex/Claude window. On Linux, login recovery needs a desktop session that honors XDG autostart. On macOS and Linux, the relay and watcher sockets live in the private `~/.codex-relay/` directory; a `CODEX_RELAY_HOME` path longer than about 90 characters exceeds the Unix socket path limit and is reported by `doctor`. A normal update restarts this service to load the new source. Isolated `--home` installs generate the files but skip process control.

`CODEX_RELAY_HOME` overrides Relay data/runtime; `CODEX_HOME` overrides Codex configuration/state. Preserve these profile choices during maintenance. The desktop bridge is required even for a Claude caller: only a Codex desktop-launched bridge receives the private app tools environment. Running it in an ordinary shell cannot create that environment.

Existing unrelated settings are preserved. If an existing entry, Skill, or startup file is not owned by this installation, or managed content was edited, report the conflict rather than overwriting it. The installed Skill contains actual runtime/CLI/installer paths, so later agents need no PATH setup.

## 4. Verify installation and activate MCP

Using `runtime` and `release` returned by installation, run:

```text
<runtime> <release>/cli.mjs doctor --offline --json
<runtime> <release>/cli.mjs doctor --json
<runtime> <release>/cli.mjs service status
```

Pass the executable and source file as separate correctly quoted arguments. Offline checks validate source, runtime, Skill, configuration, and startup file ownership. Live doctor checks watcher status, bridge connectivity, and a read-only project query. It does not create a task, send a test message, focus a window, or approve commands.

| Status | Meaning and next action |
| --- | --- |
| `notInstalled` | Run installation in the intended profile. |
| `needsRepair` | Resolve the named source/runtime/Skill/configuration/startup check while preserving edits. |
| `needsAccess` | Use the host's normal permission escalation for the authorized pipe operation and check again. |
| `needsService` | Run the installed CLI's `service start`, inspect `watch-service.log` if it fails, then rerun doctor. |
| `configured` | Offline checks passed; live readiness is not established. |
| `pendingReload` | Codex has not loaded the bridge. Report the required MCP reload/new desktop session; do not restart or focus the desktop without authorization. |
| `needsCaller` | The bridge lacks a usable loaded Codex chat. Ask the user to activate one, and send a user message only if their version needs it. Do not send an unsolicited message. |
| `ready` | Configuration, live bridge, usable caller, and applicable service checks passed. |

A nonzero exit/`ok:false` needs interpretation, not blind retries. Configuration can be complete while desktop activation is pending. After an authorized reload, check again. Confirm the client discovers the Relay MCP tools, including `codex_supervise`, `codex_preflight`, `codex_host`, and `codex_reply`, before claiming MCP is active; names may carry an MCP namespace. Newly registered tools may require a new session. The direct server is `<runtime> <release>/mcp.mjs`; the legacy `claude-mcp.mjs` remains compatible.

Then read the installed Skill. Prefer MCP for task operations and all normal messages/replies. CLI fallback is available for diagnostics or an unavailable MCP session. Installation verification does not authorize a demonstration task, watch, or message to another chat.

## 5. Register automatic follow-up when requested

The default user experience is a natural request naming a new or existing Codex execution chat, the task, and its acceptance condition. The current Codex or Claude conversation supervises that separate executor. Follow the installed Skill and call MCP `codex_supervise` with `requestId`, `task`, `doneWhen`, and exactly one of `createNew:true`, `threadId`, or `threadTitle`. Supply the requested project for creation; do not create an unsolicited chat or infer a worktree request. Keep one stable ID for the delegation, including pending worktree resolution and partial-failure retries.

The composite checks current identity, bridge/caller, project and exact-title resolution, standard service, harmless executable capability probes, and wake availability before starting/registering the workflow. It persists the acceptance condition and creation/send stages. `codex_preflight` performs readiness inspection alone and sends no test message. CLI fallback is `preflight --input-file <JSON>` or `supervise --input-file <JSON>` through the installed runtime and source path.

For every MCP setup, run installed `cli.mjs host` once in the current host's shell and supply only its supported `host`, `threadId` or `sessionId`, `cwd`, and applicable `fastDisabled` fields as `supervisor`. Do not pass the entire output or compatibility/runtime fields. A shared MCP server can retain a stale startup-session ID; `codex_host` returns `requiresShellVerification:true` and cannot attest the calling conversation. CLI `supervise` can default to its actual shell environment. Never select the latest chat/session as a substitute or ask the user to discover tool names, session IDs, or executable paths. The host command also reports Claude Fast-disabled state; do not claim that state unless the current shell verifies it.

Automatic wake selection prefers a supported Codex queue, then a usable loaded desktop context. It uses an already authorized and bound channel for a current live Claude supervisor; it may select resume for a non-live saved Claude supervisor. A current live Claude session without a channel is a concrete host blocker, not permission to launch a parallel resume writer or silently enable development-channel trust. Installation alone cannot establish those session-specific conditions. Runtime also needs an awake computer, available Codex bridge, working normal authentication/network access, and sufficient usage allowance.

The entire execution and supervision session must use Standard. Check that setting at creation or takeover for the executor and Codex supervisor, including queue supervision; ordinary messages inherit it without per-message tier overrides or model checks. Claude resume disables Fast for the restored session at process startup with `CLAUDE_CODE_DISABLE_FAST_MODE=1` and `fastMode:false`. Claude channel supervision requires verified Fast-disabled state in its live host. Native desktop APIs expose no session-tier setter, so known Fast or unknown state blocks the workflow instead of being silently changed. Preserve model/effort choices and global configuration. Do not claim actual served-tier verification from configuration evidence. A blocked prerequisite means unattended readiness has not passed; report the named action needed rather than falsely claiming a working watch.

For an advanced explicit watch configuration, use the exact monitored Codex `threadId` and a separate supervisor. The following lower-level examples are not required user setup steps.

For a Codex supervisor call MCP `codex_watch`:

```json
{"threadId":"<target threadId>","supervisor":{"host":"codex","threadId":"<separate supervisor threadId>"}}
```

The target cannot supervise itself. The default `desktop` mode sends a delegated event through Codex desktop and waits for a usable caller. For unattended follow-up, prefer the explicit `supervisor:{host:"codex",threadId:"<supervisor>",mode:"queue",executable:"<verified absolute codex CLI path>"}` when `codex queue --help` confirms support. Queue mode targets the existing supervisor without a loaded desktop caller dependency; it does not create a new chat or loosen policy. The monitored target still requires the desktop bridge. Do not claim a queued event has been handled until acknowledgment. The adapter has isolated fake-CLI tests; real queue dispatch must be verified only within user-authorized messaging scope, not as an installation demonstration. The service does not open Codex to force delivery.

For Claude Code choose one mode explicitly:

- **Live channel:** review/authorize the custom development channel, then start Claude using `claude --dangerously-load-development-channels server:codex_relay`. The MCP registration is already installed; this explicit host flag opts that server into receiving channel notifications. Its feature/organization policy must permit channels. Bind the actual session with MCP `codex_channel_bind({sessionId})`, or register `codex_watch` with `supervisor:{host:"claude",sessionId,mode:"channel"}` through the same MCP connection, which also binds it. An explicitly configured `mcp.mjs --channel-session <id>` or `CODEX_RELAY_CHANNEL_SESSION_ID` can bind at server initialization. Do not set an unknown session ID or modify a managed MCP config casually.
- **Unattended resume:** register `supervisor:{host:"claude",sessionId,mode:"resume",cwd,executable}` with the exact saved session, its original absolute working directory, and a verified Claude CLI executable. The daemon runs a bounded noninteractive `--resume` process with only event-scoped Relay follow-up MCP tools. It neither bypasses permission controls nor runs a general shell agent. A session already owned by another running process may refuse resume; that definite unsent result backs off and retries. Prefer the live channel while actively using that same session.

Channel delivery requires a running, enabled, bound session. It cannot reopen a closed Claude session. Resume mode requires a working CLI/authenticated saved session. Do not claim a closed host will magically receive live channel events. See the official [channel reference](https://code.claude.com/docs/en/channels-reference) and [CLI reference](https://code.claude.com/docs/en/cli-reference) for current host requirements; channels are a preview feature and explicit trust opt-in.

Watch registration starts the service if needed. No routine polling prompt or external scheduler is required. On an event, the supervisor retrieves it with `codex_events`, checks current `codex_status`, compares results with the persisted finish condition, sends authorized follow-up with `codex_reply`, then calls `codex_watch_ack({eventId,action:"rearm"})`. Use `complete` only when the finish condition is satisfied; one turn ending is not enough. `retry` is explicit redelivery authorization after inspecting a delivered/uncertain event, not a normal acknowledgment.

## 6. Service control, recovery, and maintenance

Use installed CLI `service status`, `service start`, or `service stop`. A stop creates the service stop marker, while a start clears it. Stopping the service does not remove subscriptions. Unacknowledged events can be inspected with `codex_events`; `includeAcknowledged:true` includes history. `codex_unwatch({subscriptionId})` removes a subscription and cancels its queued events without deleting task history.

The outbox is written before wake dispatch. Repeated snapshots are deduplicated, including after restart. Pending events resume automatically. Delivered events await acknowledgment. Dispatch interrupted by a crash becomes `uncertain`; inspect the receiving host before explicit retry because it may already have acted. The system does not promise exactly-once external effects. Preserve `watches/` and `outgoing/` when recovering or migrating an installation.

For messages, supply a stable MCP `codex_reply.requestId` and identical input on retries. Inspect `codex_delivery({requestId})` and the current target after an error; CLI fallback is `delivery --request-id <id>`. Completed answer/instruction stages are not repeated; uncertain stages are not automatically resent. Use separate IDs such as `<eventId>:answer` and `<eventId>:followup` for separate operations. Never work around uncertain delivery by inventing a fresh request ID without checking the target.

Run installed `update` to fetch the recorded Git origin into fresh temporary staging, validate it, and switch managed integrations to a new immutable snapshot. It does not reset/pull the original user checkout. The previous release and durable watcher/reply state are retained. Use `update --ref <requested-ref>` or `update --source <trusted-local-checkout>` as needed. With both `--source` and `--ref`, that checkout's HEAD must already match; it will not be switched. A source copy without Git metadata needs `--source`, not an invented origin. `update --dry-run` may contact the remote and use temporary staging but does not switch the installed integration.

After update, follow the returned new `release`, rerun doctor, and reload client MCP only when needed. Recovery can reinstall a trusted prior commit or use `update --source <previousRelease>`. Atomic replacements and rollback protect managed configuration/Skills/startup files when installation fails; preserve reported conflicts.

Run installed `uninstall` only when requested. It stops the service, removes its startup launcher, MCP/Skill integration, install record, and removable managed source snapshots. It preserves unrelated settings, Codex task/session data, logs/tokens, durable watch state, and reply receipts. Reinstalling can recover preserved records; inspect them before resuming unwanted old subscriptions. If removal is blocked by user edits, preserve and report the conflict. Locked/current-working runtime directories are listed under `retainedRuntimeDirectories`; remove only those verified managed directories when authorized. Do not recursively remove the user's home, `.codex`, `.claude`, or `.agents`. A repeated uninstall returns `notInstalled`.
