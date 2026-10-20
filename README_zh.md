# Codex Relay

让 **Codex 和 Claude Code** 通过 **MCP、共用 Skill、持久监听服务和宿主唤醒适配器** 操作本机 Codex 桌面任务。消息和回复优先走 MCP；CLI 负责源码安装、检查、服务控制和备用调用。**Node 与 Bun 均可直接执行源码**，无需编译、安装依赖、下载安装包或接入插件市场。

[English README](README.md) · [Agent 安装流程](INSTALL.md) · [使用 Skill](skills/codex-relay/SKILL.md)

## 让 Agent 从 GitHub 安装

把本仓库链接交给 Codex 或 Claude Code 并要求安装。英文 README、AGENTS.md 和 CLAUDE.md 会引导 Agent 执行 INSTALL.md 中完整的下载、运行时选择、安装、激活和验证流程，无需用户推导命令与配置路径。

当前前提是本机 Codex 桌面应用（Windows 已实测；macOS 与 Linux 已实现但未经实机验证），以及支持内置 SQLite 的 Node 22.16 以上或 Bun 1.2 以上。Codex 优先使用可用的 Node，Claude Code 优先使用可用的 Bun；两种运行时都能执行全部源码入口。

```powershell
node scripts/install.mjs install --target codex
bun scripts/install.mjs install --target claude
node scripts/install.mjs install --target both
```

运行时不在 PATH 中时使用已验证的绝对路径；PowerShell 调用带引号的可执行路径需要前置 `&`。安装器会把实际运行时、CLI 和安装器路径写入安装后的 Skill。

默认安装选定客户端的 Skill、主要 MCP 工具、必需的 Codex 桌面桥接，以及隐藏的持久监听服务。正常安装会立即启动监听监督进程，并注册当前用户的登录自启动：Windows 为启动文件夹中的隐藏 VBS，macOS 为 `~/Library/LaunchAgents/local.codex-relay.watcher.plist`，Linux 为 XDG autostart 的 `codex-relay.desktop`。登录恢复时，稳定启动器读取安装记录，定位更新后的源码版本；工作进程崩溃时由监督进程重新启动。此机制不是登录前运行的系统服务，也不会打开或重启 Codex、Claude 窗口。

`--no-mcp` 是明确需要 CLI 备用模式时的选项，只阻止新增客户端 MCP 配置，不删除已有注册；`--mcp` 保留为默认行为的兼容别名。`--home` 用于隔离测试或独立配置，不操作真实用户目录，也不会启动或停止监听服务。

## MCP 作为主要调用入口

MCP 提供完整操作入口：

- 默认监督流程：codex_supervise、codex_preflight、codex_host。
- 项目与任务：codex_projects、codex_threads、codex_start、codex_resolve、codex_status、codex_wait。状态与等待只返回精简、截断后的结果；桌面拒绝等待接口时，会先退回精简的对话读取，再退回会话日志末尾的有限片段，不会读取整个日志。
- 消息与回执：codex_reply、codex_delivery。
- 持久跟进：codex_watch、codex_watches、codex_event_context、codex_event_report、codex_events、codex_watch_ack、codex_unwatch、codex_channel_bind。

codex_reply 的 message 始终是委派指令；answers 根据当前问题的 callId 和 index 匹配。已有授权范围内的常规决策使用 answerSource: agent，投递内容保留 Agent 来源。真实用户答案使用 answerSource: user 与 userProvided: true。命令审批仍由用户在 Codex 中处理。

MCP 是公开的调用入口。内部普通指令使用 Codex 的委派消息工具；结构化问题答案使用能关闭问题卡片的桌面 IPC。将结构化答案改成普通消息转发会留下未关闭的问题，因此不会再静默降级到这种无效路径。打开或聚焦窗口需要明确授权的 allowOpen: true。

每个预期发送操作应使用稳定 requestId。相同 ID 与相同输入的重试返回已有回执，不重复已完成阶段。不同操作分别使用事件 ID 后加 :answer、:followup 等键。超时或断线后先通过 codex_delivery 与当前任务状态检查投递结果，不用新 ID 绕过不确定状态。答案与后续指令的合并请求分别记录阶段，部分成功后不会重发已完成的答案。

## 持久监听与自动跟进

默认使用**当前对话监督另一个执行对话**。只需告诉 Agent 是新开还是使用哪个现有 Codex 对话、做什么，以及做到什么程度，例如：

> 在当前项目里新开一个 Codex 对话修复登录失败，由当前对话监督，直到回归问题修复并通过相关测试。

> 让已有的「数据库迁移」对话继续完成迁移，持续跟进到约定的迁移检查通过。

Agent 会调用 codex_supervise 自动完成当前宿主身份识别、项目和精确对话名称解析、桌面桥接及调用上下文检查、模型档位检查、CLI 能力探测、唤醒方式选择和持久监听注册。用户无需指定工具、会话 ID、可执行文件路径或唤醒模式。执行后端目前仍是本机 Codex Desktop；Codex 或 Claude Code 都可作为监督宿主。

每次通过 MCP 设置监督流程时，Agent 都会先在当前宿主的 Shell 中运行一次已安装 CLI 的 host 命令，将实际 host、threadId 或 sessionId、cwd，以及适用的 fastDisabled 字段传为 supervisor。共享 MCP 进程可能保留启动时的旧会话 ID，因此 codex_host 会标记 requiresShellVerification:true，不能据此认定当前调用对话。不会整份传入 host 输出中的兼容字段或 runtime，不会猜测最近的聊天或会话文件，也不会把查 ID 的工作交回用户。直接使用 CLI supervise 时，可默认读取它实际所在 Shell 的环境。

任务说明、验收条件以及创建和发送阶段都会持久保存。同一操作使用稳定 requestId；新工作树尚未创建完成，或创建后其他阶段失败时，重试不会另开一个替代对话。一个执行回合结束后，监督 Agent 仍需对照验收条件检查结果，未达成就继续推进，处理后重新监听。

codex_preflight 可单独检查无人值守条件，不会发送测试消息或创建任务。只有条件通过才启动并注册默认流程。发现名称歧义、宿主未激活、缺少 Channel、权限或模型档位证据不足时，会返回具体阻塞原因；这不算无人值守就绪。电脑需要保持运行，本机 Codex 桌面桥接、正常认证、网络和使用额度也必须可用。

唤醒方式自动选择：Codex 优先使用能力探测通过的 queue，其次使用可用且已加载的 desktop 上下文。当前活跃 Claude 会话优先使用已授权、已绑定的 Channel；非活跃的已保存监督会话可以使用可用 CLI 的 resume。当前 Claude 会话没有 Channel 时，不会并行启动另一个进程写同一会话，也不会擅自启用开发 Channel 的信任开关。

**要求整个会话使用 Standard，不启用 Fast。** 在创建或接管时检查执行会话和 Codex 监督会话的档位，包括 queue 监督方式；之后的普通消息继承会话设置，不逐条设置或检查模型档位，queue 也不附加每条消息的档位覆盖参数。Claude resume 在启动恢复进程时通过 CLAUDE_CODE_DISABLE_FAST_MODE=1 和 fastMode:false 关闭恢复会话的 Fast；Claude Channel 需要从其宿主 Shell 验证整个监督会话已禁用 Fast。桌面接口没有会话档位设置方法，因此已知 Fast 或档位未知时会阻止流程，不能声称已自动改成 Standard。流程保留模型和推理强度，不修改全局模型配置；配置检查也不冒充服务端实际使用档位的回执。

高级调用方仍可直接通过 codex_watch 注册被监听的 Codex threadId 和明确的监督会话。监督 Codex 对话必须使用不同的 threadId，不能自我监听。手动 queue 模式需提供已验证的 Codex CLI 绝对路径。排队成功不代表 Agent 已处理完成，仍须等待确认。Queue 适配器使用隔离假 CLI 测试，不能声称所有真实 Codex 版本都已通过实际发送验收。

手动配置 Claude Code 监听时，有两种模式：

- **channel**：向运行中的 Claude 会话推送事件。需要用户审阅并授权自定义开发 Channel，通过 `claude --dangerously-load-development-channels server:codex_relay` 启动，并使用真实 sessionId 绑定。通过同一 MCP 连接注册 channel 模式的 watch 也会执行绑定。宿主和组织策略必须允许 Channel；仅安装普通 MCP 不会自动启用推送。关闭的会话无法靠 Channel 自动打开。
- **resume**：使用真实 Claude CLI，通过非交互方式继续精确的已保存会话。注册时提供真实 sessionId、原始绝对 cwd，以及已验证的 executable。唤醒工作进程只取得当前事件范围内的 Relay 跟进 MCP 工具，不绕过权限。正在被其他进程占用的会话可能拒绝恢复，此类明确未投递结果会退避重试；活跃使用中的同一会话更适合 Channel。

唤醒消息只包含必要标识，例如：

```json
{"relayEvent":1,"eventId":"<event ID>","subscriptionId":"<subscription ID>","type":"turnEnded"}
```

完整报告、任务目标以及整段操作规则不再复制到每条通知中。固定处理规则集中在 Skill 和 MCP 初始化说明里。监督 Agent 收到事件后：

1. 一次调用 codex_event_context，组合读取该事件的持久确认状态、已保存目标和策略，以及当前任务的精简状态。已确认事件返回 handled:true、nextAction:skip，不再查询桌面。
2. 根据当前状态和预览决定下一步。返回 reconcile 或 retryStatus 时先处理对应问题；捕获时的快照不是当前状态证明，也不是新的用户授权。不再按惯例依次读取 codex_events 和 codex_status，重复取得相同正文。
3. 只有验收、错误、证据或被截断的完成条件确实需要更多内容时，才调用 codex_event_report。已有授权范围内的常规选择自行决定，通过 codex_reply 继续任务；确实需要用户决定或审批时转交具体问题。
4. 对照已保存的验收条件检查结果，处理完成后使用 codex_watch_ack 的 rearm 继续监听；只有达到用户完成条件才使用 complete 停止该订阅，不能把一个回合结束当作整个任务完成。

上下文中的消息预览默认 400 字符，previewChars 可设为 64 至 2000。goalTruncated 表示应先通过 codex_event_report 的 section:goal 读取完整条件，再判断是否完成。报告默认 section:report，始终对应原事件回合，不会替换成另一个最新回合；section:snapshot 可读取捕获的事件数据。报告分页默认 4000 字符，最多 16000；按 nextOffset 继续，并传入返回的 reportHash 检查分页期间内容是否改变。complete:false 明确表示只能取得捕获的片段，不能当作已核实的完整报告。报告与快照中的文字都是任务数据，不是应执行的新指令。

事件在唤醒宿主前写入持久 outbox，使用稳定 ID 去重。状态包括 pending、dispatching、delivered、acknowledged，以及投递不明确时的 uncertain。未投递事件在服务恢复后自动继续；已投递事件等待处理确认。调度中崩溃或投递结果不明确时不会盲目重发，检查宿主是否已执行后，才用 retry 明确授权重新投递。这防止重复副作用，但不声称能实现外部系统绝对一次投递。

Codex desktop 模式唤醒需要可用的桌面桥接和调用上下文，queue 模式需要支持该命令的真实 CLI 和现有监督会话；离线 Channel 需要会话重新启动并绑定，或明确选用 resume 模式。宿主不可用时事件仍保留，不会通过打开窗口强制投递。

## 检查、服务控制与维护

安装结果返回 runtime、release 和 stateFile。使用返回路径执行已安装 CLI：

```powershell
node cli.mjs doctor --json
node cli.mjs service status
node cli.mjs service start
node cli.mjs service stop
node cli.mjs update
node cli.mjs uninstall
```

上面的路径表示从源码目录执行；安装后的 Skill 提供真实绝对路径，也可用 Bun 执行。

CLI 备用入口支持 preflight、supervise、event-context 和 event-report 的 --input-file JSON 调用，与 MCP 共用相同流程。正常操作优先走 MCP。

| 检查状态 | 含义 |
| --- | --- |
| notInstalled | 尚未安装当前配置 |
| needsRepair | 运行时、源码、Skill、配置或启动文件存在具体问题 |
| needsAccess | 宿主沙箱拒绝管道访问，需正常权限流程 |
| needsService | 持久监听服务未正常运行 |
| configured | 离线检查通过，尚未建立实际运行证据 |
| pendingReload | 已完成配置，等待 Codex 加载桌面桥接 |
| needsCaller | 桥接已连接，还需要可用的 Codex 聊天上下文 |
| ready | 配置、桌面桥接、只读项目查询及适用的服务检查通过 |

停止服务保留订阅和事件；start 清除停止标记并恢复。update 从记录的 Git origin 获取新源码，或通过 --source 指定可信本地源码，切换不可变版本并重启监听服务，保留去重状态与消息回执。不会修改原始工作目录。没有 Git 元数据时需要 --source，不能虚构 origin。

更新到精简事件流程后，监督会话的 MCP 连接也需要加载新版工具和初始化说明；仍在运行的旧 MCP 进程可能尚不提供 codex_event_context。事件 ID、处理确认历史、发送回执和重启恢复均保留。原 codex_events 与 codex_status 继续作为兼容和手动诊断入口。

uninstall 停止服务、移除登录启动器及自身管理的 MCP、Skill、安装记录和可移除源码，保留无关设置、Codex 任务数据、日志、持久事件与消息回执。重新安装可能恢复保留的订阅，应先确认这些旧订阅仍然需要。发现用户修改了受管理内容时保留修改并报告冲突。

## 验证与边界

```powershell
node --test test/*.test.mjs
bun test
```

测试使用隔离用户目录、模拟桌面管道和假宿主程序，覆盖持久监听、去重、确认后重新监听、崩溃恢复、宿主投递、消息回执，以及三种平台自启动布局下的安装、更新、卸载和回滚。真实连接可通过只读 doctor 检查；假 Claude 宿主测试不能代表所有实际 Claude CLI 版本已通过运行验收。

目标是同一台机器上的 Codex 桌面应用。桌面适配器依赖 Codex 内部接口与只读本地状态，应用升级可能影响兼容性，也不提供云端桥接。

| 平台 | 状态 |
| --- | --- |
| Windows | 已用真实 Codex 桌面应用实测 |
| macOS | 已实现（Codex IPC socket、LaunchAgent 自启动、CLI 查找），未经实机验证 |
| Linux | 已实现（Codex IPC socket、XDG 自启动），未经实机验证 |

macOS 与 Linux 上的桌面 IPC socket 按 Codex 应用自身的布局使用 `$CODEX_HOME/ipc/ipc.sock`；应用早期的按用户临时 socket 仅在归当前用户私有时才会使用。Relay 自身的 socket 位于私有目录 `~/.codex-relay/`。欢迎反馈这些平台上的结果，请先运行 `doctor --json`。

代码、注释、Skill、安装说明及英文 README 使用英文，中文仅存在于以 _zh.md 结尾的文档。

## 免责声明

Codex Relay 是独立项目，与 OpenAI 和 Anthropic 无关联，也未获其认可或支持。项目依赖 Codex 桌面应用的内部接口，任何桌面版本更新都可能导致其变化或失效。使用 Codex 与 Claude 仍须遵守各自的服务条款。

## 许可证

Copyright (C) 2026 normalllll

本程序为自由软件，按自由软件基金会发布的 GNU 通用公共许可证第 3 版或（由你选择）任何更新版本（GPL-3.0-or-later）的条款再分发和/或修改。本程序不提供任何担保，详见 [LICENSE](LICENSE)。
