# DSH AgentHost 路线 B 实施计划

## 目标

把 DeepSeek Harness 接成第三个 `AgentHost`，由 DSH 持久 Session 承担 Agent 多轮执行，Auto-Test Core 继续唯一拥有 Manifest、epoch、证据、执行回执、环境需求、Mutation Ledger 和最终结果校验。

## 非目标

- 不把 DSH memory、goal 或 skill 变成测试事实源；
- 不修改 Core 的业务分类和恢复语义；
- 不用官方 one-shot `headless` 输出冒充多轮 Host；
- 未经 canary 不宣称 DSH 优于 Codex 或已支持 Windows 产品化运行。

## Bridge 合同

Auto-Test 启动 `dsh --profile auto-test-host --rpc`，stdin/stdout 使用一行一个 JSON 对象。命令包含 `start`、`resume`、`input` 和 `close`；每个命令必须返回带相同 `id` 的 `response`。启动响应必须包含持久 `sessionId`。

Bridge 输出使用 `AgentEvent` 的稳定事件名：`thread_started`、`turn_started`、`agent_message`、`tool_started`、`tool_completed`、`command_started`、`command_completed`、`file_change_started`、`file_change_completed`、`turn_completed`、`turn_failed`、`session_incompatible` 和 `error`。工具事件必须提供稳定 `callId`，MCP 工具同时提供 `server` 与 `tool`。

## 交付阶段

1. **Auto-Test adapter**：内置 `dsh` 注册、JSONL 客户端、Session start/resume、事件归一化、Anthropic Messages Provider 配置和 fail-closed 能力声明。
2. **DSH profile**：在 DSH 仓库实现 `auto-test-host` profile/plugin，复用核心 Agent、Session、MCP 与 sandbox 服务，暴露上述 JSONL 合同。
3. **协议验收**：用假 bridge 覆盖 start、follow-up、事件、close、resume、坏帧、超时和 session incompatibility。
4. **fixture canary**：同一三 case fixture 分别运行 Codex、OMP、DSH，并用 `agent:compare` 校验证据、回执、工作簿与 Ledger。
5. **故障 canary**：验证 Provider 断线、DSH 进程重启、MCP 重连、损坏交付、pending Mutation 和 finalization-only 恢复。
6. **Windows canary**：验证 ACL/PwSh sandbox、便携包、真实 Provider、浏览器写入和恢复；通过前保持 experimental。

## 当前边界

本分支完成阶段 1 的 Auto-Test 一侧。阶段 2 必须在 DSH 项目实现，官方 `headless` profile 不支持 `--rpc`。因此当前 `doctor` 只能确认 DSH CLI 存在；真实运行会在缺少 `auto-test-host` bridge 时于业务执行前失败。
