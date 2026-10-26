# Ordinary desktop creation and host attribution

The supported behavior preserves automatic new-chat creation through the native
desktop `create_thread` tool and submits later work through the ordinary desktop
start/steer input path. The first-message body is the task followed by the
finish condition as normal conversation text. Relay adds no headings, supervisor
roles, authorization history, or source and routing narration. Those details
stay in the supervising conversation and internal records.

The host may retain its own attribution that the first message came from
another ChatGPT chat. This is within the accepted boundary and does not block
the supported workflow. The research below concerns the optional, stricter
requirement of removing all host attribution as well. That is separate from
keeping the work body clean. Later ordinary input does not erase earlier
conversation history.

This note records the bounded investigation on 2026-10-25. The boundary findings
come from static protocol inspection. No live task was sent to validate the
alternative creation candidates discussed below; they are not prerequisites
for the accepted native creation and ordinary follow-up behavior.

## Inspected desktop artifact

The inspected Windows app was `OpenAI.Codex_26.1016.8622.0_x64`, with archive:

```text
C:/Program Files/WindowsApps/OpenAI.Codex_26.1016.8622.0_x64__2p2nqsd0c76g0/app/resources/app.asar
SHA-256: a05dfd86ca508148c83c25590639cf91a52c6647733cdf200723d85357052b49
```

Locations below are character offsets in the named minified JavaScript member,
not line numbers or stable identifiers across app releases. They identify
observed source boundaries; static inspection does not prove live reachability.

| Boundary | Installed source and offset | Observation |
| --- | --- | --- |
| External app-tool call | `.vite/build/main-CT5a1yCd.js`, `Wd` near `306886` | The call requires a nonempty caller `threadId` and a `callerSource` of `codex` or `chatgpt`; omitting the caller is not a supported ordinary-creation switch. |
| Native task creation | `webview/assets/app-initial-ad16eaadf81f.js`, `$9s` at `9216940`, `eec` at `9219515`, `nec` at `9222884` | Creation accepts the source thread separately. With a source thread, the creation branches call `vqn` for the initial input. The public `create_thread` contract requires a nonempty prompt. |
| Internal blank root | Same renderer member, `Q9s` at `9216582` | Calls `eec` with `prompt:""`, `startWithoutFirstTurn:{title}`, `target:{type:"projectless"}`, and `threadSource:"user"`. With no source thread, `eec` uses empty input rather than delegation input. This internal function is not an external IPC entry. |
| Observed blank-root caller | Same renderer member, `kec.startTask` at `9232544` | The first-party Rosalind plugin host creates the blank projectless chat, then navigates to it with a prefilled composer. It does not submit the prompt. It does not provide general background project/worktree creation. |
| Coordination requests | `.vite/build/src-CsH31EEu.js`, `T0` near `1593900`, `Een` near `528490`; renderer duplicate `Een` near `2456400` | Registers owner discovery and existing-thread follower operations. The follower dispatcher asserts an existing conversation owner before starting or steering a turn. No ordinary blank-creation or arbitrary host-request handler was found in this registry. |
| New-chat deep link | `.vite/build/main-CT5a1yCd.js`, `newThread` branch at `3704834` | Resolves the project and navigates to `/` with project, focus nonce, and prefilled prompt. It does not create a persistent conversation or submit a turn. |
| Evaluation control | Renderer `jSu` at `12730929` | The production implementation throws `eval control actions are only available in dev builds`. The main process only forwards this action to the renderer. |
| Desktop backend startup | `.vite/build/main-CT5a1yCd.js`, `QJe` near `3173110` | The inspected startup path uses `app-server` without a socket `--listen` argument. A separate app-server process is not thereby connected to this desktop backend. |

The focused REA main-source analysis was retained as
`ev_2a3f42b0dca36e43e9e3aa52c89984470b4f0c8b436b1de96af9b3cd472cf4d3`.
Its selected JavaScript parsed without parse failures; application and semantic
graph coverage remained partial. REA reported integrity contradictions in
unpacked native companions and retained those bytes as untrusted. Packed
JavaScript was inspected as inert text; no bundle bootstrap was executed.

## Native app-server protocol

The separately inspected native executable was:

```text
C:/Users/XOR/AppData/Local/OpenAI/Codex/bin/37f54d68e5533a51/codex.exe
codex 0.163.0-alpha.11.2
```

Its own experimental TypeScript generator was run into the ignored temporary
directory `.test-tmp/native-protocol`:

```text
app-server generate-ts --experimental --out V:/Code/codex-relay/.test-tmp/native-protocol
```

The generated `v2/ThreadStartParams.ts` contains `cwd`,
`runtimeWorkspaceRoots`, `projectId`, model, service tier, permission selection,
instructions, dynamic tools, and selected capability roots. It has no required
user-input field. `v2/ThreadStartResponse.ts` returns the thread, actual model,
service tier, working directory, workspace roots, instruction sources, approval
policy/reviewer, and permission profile. This establishes a native blank
`thread/start` protocol; it does not establish an external route into the
desktop's running backend or a complete desktop creation lifecycle.

The native CLI also exposes `app-server proxy` for a running app-server control
socket. A read-only proxy initialization attempt against
`C:/Users/XOR/.codex/app-server-control/app-server-control.sock` failed with
Windows socket error `10050` before a successful initialization. This is an
unavailable connection result, not proof that the server is absent or that a
different transport would work.

For supporting implementation context, upstream app-server source selects
stdio and Unix socket listeners as separate transport modes, and the CLI proxy
forwards to a running server. Upstream `main` is not exact-version evidence for
the installed binary:

- [App-server transport implementation](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/lib.rs)
- [CLI app-server proxy implementation](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs)

## Optional removal of all host attribution

Launching a second headless app-server would create a separate client/backend
relationship. A successful blank response alone would not show that the
desktop has adopted ownership, loaded its dynamic tools and permission
configuration, assigned the intended project/worktree, or can process its
approvals and ordinary follower input. Terminating that process would also
require a proven ownership handoff. Keeping it running would add another
execution backend and resource lifecycle.

Relay keeps automatic creation on its valid native contract and uses ordinary
input for follow-up. Together with role-neutral plugin initialization and
work-only message bodies, this meets the accepted boundary. A separate daemon,
history editing, renderer injection, or an empty public creation request is
not needed for this workflow.

Removing all host attribution in a future change would need a callable
ordinary creation boundary in the
same desktop lifecycle, including project/worktree setup, permissions, model
policy, ownership, first input, durable identity, and uncertain-result recovery.
No such complete external boundary was established in this investigation.
