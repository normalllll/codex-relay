# Read-only desktop session policy

Relay checks a session's selected service tier at supervision setup. It does not set a tier on every message, rewrite global defaults, or treat missing evidence as Standard. Both CLI and MCP use `inspectModelPolicy` and the same desktop adapter.

## Current settings read

The adapter in `src/desktop/codex-ipc.mjs` uses the existing local desktop coordination socket:

1. Initialize a separate Relay client and discover the exact selected session's owner.
2. Request `thread-follower-read-model-settings` from that owner. The host waits for pending settings updates before responding. The current response includes model metadata but omits the service tier, so it serves as the update barrier rather than tier evidence.
3. Register as a temporary state follower of that same owner and session. Consume the first matching state snapshot and extract only `latestThreadSettings.serviceTier` from a resumed session.
4. Flush an unsubscribe and close the connection on success or failure. Host disconnect cleanup is the fallback if the socket has already failed.

There is no desktop navigation, task creation, message delivery, configuration write, or ownership takeover. The reader never claims incoming discovery requests. It does not request complete-history hydration or save a snapshot. The host's normal snapshot can contain transcript data; the local reader discards that data and exposes only the selected tier, snapshot revision and protocol version.

The entire read has a five-second deadline. Frames larger than 8 MiB, malformed frames, protocol changes, owner changes, mismatched session/host IDs and unsettled settings fail closed. The reader accepts snapshot protocol 11 and following/model-settings protocol 1. It does not guess alternate protocol versions or retry indefinitely. Missing values and explicit null do not establish Standard.

## Policy evidence

The live settings reader supplements explicit thread metadata. Conflicting accelerated evidence prevents acceptance. Saved turn-context inspection remains available when neither live source exposes a tier; a historical Fast turn does not override current explicit session settings. Global configuration is used only for new-session defaults.

`default` and `standard` are accepted as Standard configuration evidence. Known accelerated tiers are rejected. This establishes the host's selected session configuration at the read point, not the model provider's actual served tier. The user can change settings after setup; ordinary messages continue inheriting their session's setting.

If no source provides a tier, `SESSION_TIER_UNAVAILABLE` identifies the host evidence gap. Agents retain the existing setup request ID and do not repeatedly ask the user to toggle Standard. Unsupported values return `SESSION_TIER_UNRECOGNIZED`; known accelerated selections return `SESSION_TIER_ACCELERATED`.

## Input after a failed run

Ordinary desktop input selects start or steer from the exact owner's runtime state. `active` uses steering; `idle` and `systemError` use a normal new-turn submission with inherited thread settings. `systemError` describes the previous run's failure and is not by itself an input prohibition. The owner must still return a valid nested turn-acceptance response before Relay records delivery. Resuming, unloaded, unknown, and unconfirmed-submission states continue to block; ambiguous writes never trigger another automatic submission. The adapter does not classify eligibility by capacity-error text or override model, tier, approval, or sandbox settings.

This behavior is covered by isolated owner-protocol and MCP receipt-recovery tests. Historical protocol declarations include `systemError`, and the inspected owner handler forwards `thread-follower-start-turn` to the regular turn-start operation. Those static observations do not establish live recovery from an actual provider-capacity event.

## Inspection and verification boundary

The protocol was inspected in the installed Windows package `OpenAI.Codex_26.1016.8622.0_x64`, whose application manifest reports build `26.1016.62342`. REA retained the archive inventory as Evidence `ev_24b57f35b2938c8a32c43882bf8db2a97d138760870bda8f9efadc8aaf859eea`. That inventory analyzed only the manifest; focused inert source reads established the following protocol observations:

- `.vite/build/src-CsH31EEu.js`, character offset 531764: model-settings handler waits for pending settings and asserts the session owner.
- The same module, offset 258493: state projection includes `latestThreadSettings`.
- The same module, offset 1583401: broadcast framing and version selection.
- `.vite/build/main-CT5a1yCd.js`, offset 738420: state snapshots use the existing coordination broadcast.

The archive analysis recorded integrity contradictions in unrelated unpacked native binaries. Those binaries were not executed or used to derive this adapter. Static inspection alone did not establish live behavior: a separate read-only Windows probe confirmed the exact session owner's protocol-11 snapshot and explicit `serviceTier:"default"`, and the shared preflight returned `ready:true` without creating a task or sending a message.

Node and Bun tests use temporary homes and sockets. They cover discovery, owner/session/host matching, bounds, malformed and incompatible responses, unknown/Fast values, unsubscribe on failure, timeouts, and the MCP supervision call chain without relying on invented tier fields in `read_thread`. macOS and Linux paths have isolated test coverage; no live desktop acceptance is claimed on those platforms.
