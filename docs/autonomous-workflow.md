# Autonomous Workflow（AgentHost 默认路径）

本文描述 AgentHost 默认执行链路。当前架构已抽象为宿主无关的 AgentHost：Codex 与 OMP 都可以成为真实测试执行主体，并遵守相同的输入、证据、Ledger 和结果合同。一次业务请求对应一个逻辑 Run；物理宿主 thread 只是容量和恢复资源，可以在 Run 内轮换。宿主选择和 OMP RPC 说明见 [AgentHost 宿主契约](agent-hosts.md)。

## 产品契约

Run 的终态只有：

- `passed`：请求的操作、可观察预期和最终状态均有具体证据；
- `product_failed`：正确执行后观察到产品或业务结果与预期不符；
- `blocked`：输入、环境、权限、恢复状态或基础设施阻止完成；
- `failed`：未被归类为可恢复阻断的框架异常。

每个非通过 case 必须有且只有一个 `failureSource`：`product`、`agent_execution`、`input`、`environment` 或 `infrastructure`。环境阻断必须引用同一 case 的已记录环境需求和证据；Runner 不从摘要文字猜测分类。运行中的 Provider、AgentHost、浏览器、MCP 或网络异常属于独立的 `runInterruption` 事件：它说明本轮为何中断，但不能替代或覆盖已经保存的逐 case 业务结论。

## 自适应 Epoch Runtime

```text
一个逻辑 Run
  -> immutable intake manifest
  -> model capacity policy
  -> epoch-0001 / AgentHost thread A
  -> per-case result commit + workspace checkpoint
  -> epoch-0002 / AgentHost thread B（需要时）
  -> per-case store
  -> deterministic aggregate
```

容量策略读取 Model Profile 的可选元数据：`contextWindowTokens`、`maxOutputTokens`、`caseOutputTokens`、`targetContextRatio` 和 `targetOutputRatio`。Runner 估算每条来源行的输入成本和结果输出成本，并额外使用通用的 8-case 工作集上限，按预算生成 epoch；工程师不需要传入 `--case-batch-size`，也不需要手工规划长套件。

每个 epoch 的 AgentHost 交互顺序是：

1. 读取当前 epoch 的紧凑 case 索引（不可变 workflow/source 身份、来源行、风险、图片和结果证据指针）与相关图片；完整解析 Manifest 是工作区内不可变的 `test-manifest.json` 文件，由 AgentHost 按需读取，不再逐 turn 内嵌完整 Manifest JSON；
2. 自主探索、执行、断言和恢复业务状态；
3. 如有 pending Mutation Ledger，继续使用同一 thread 重新观察并恢复；
4. 只为当前 epoch 生成有界结构化结果和 recovery artifact；
5. Runner 校验不可变身份、case 覆盖、证据、失败来源和被引用的回执；
6. Runner 将每条 case 以幂等记录写入 `.agent-private/case-results/`；
7. 若还有后续 epoch，AgentHost 写入 checkpoint，Runner 轮换 thread。

AgentHost 不必调用 `case_execution_begin/end`、`case_result_record` 或环境审计 turn 才能操作浏览器。回执是被动审计通道；只有结果中引用的回执需要校验归属和状态。`case_result_record` 不能覆盖逐 case store 的恢复事实。

执行上下文按 token 成本设计，但不改变任何执行语义：每个 thread 的首个执行 turn 只携带固定协议文本、紧凑 case 索引和稳定工作区指针（原始 Excel、brief、图片、run 值、完整 Manifest、checkpoint）；稳定运行数据都留在工作区文件里由 AgentHost 按需读取，不在每个 turn 重复传输。resume 提示会重复这些稳定指针，使容量恢复换线后的新物理线程仍能找到同一批运行数据。比较 token 消耗时使用 `npm run agent:compare`：它按 run 聚合脱敏事件日志中每个已完成 turn 的 usage，把输入、缓存输入和输出 tokens 分开列报，并显示相对 baseline 的增量；case 结论、证据、Ledger 终态和回放校验仍由同一确定性合同比较。

## 薄外壳职责

Runner 只负责必须跨进程、跨模型和跨浏览器保留的事实：

1. 为 Excel 每个来源行建立不可变 workflow/case 身份；
2. 选择 Environment Profile，准备认证和权限边界；
3. 创建隔离 Agent Home、Playwright MCP 和 Run workspace；
4. 根据容量规划 epoch，启动或恢复物理 thread；
5. 输出脱敏事件、进度和心跳；
6. 保存 Mutation Ledger、环境需求、回执和逐 case store；
7. 对每个 epoch 做严格结构校验，并按 Manifest 顺序聚合完整交付；
8. pending Mutation 存在时强制 `blocked`。

Runner 不实现第二个 Planner、Locator 解释器、字段组合引擎或业务 Runtime，也不会替选定 AgentHost 生成业务结论。

## 恢复契约

`codex-agent.state.json` 使用 `version: "2.0"`，保存 `completedCaseIds`、`threadGeneration`、`activeEpoch`、`checkpointPath`、无密钥的 `sessionBindingFingerprint`、最近一次 `turn.completed.usage`，以及可选的 `runInterruption`（稳定代码、发生阶段、人类摘要、恢复动作和时间）。旧版 `single_thread/case_windows`、`activeBatch`、`completedBatchIds` 和 `case-batches` 状态不再兼容；恢复旧状态会 fail closed，要求新建 Run。`--resume` 开始时会清除旧中断事件，避免已恢复的 Provider 故障继续污染新结果。

恢复流程：

1. 校验原始 workflow ID、source SHA、Environment Profile 和 Mutation Ledger；
2. 读取逐 case store，将已完成 case 从待执行集合移除；
3. active epoch 有 thread ID 且 AgentHost/Provider/模型绑定指纹未变化时恢复该 thread，否则保留逻辑 Run 并启动下一代 thread；resume 提示始终携带稳定工作区指针（完整 Manifest、原始输入、run 值和 checkpoint 路径），使换线后的新物理线程按需读取同一批运行数据，而不依赖上一线程的记忆；
4. 仍有 pending Mutation 时，选定 AgentHost 先重新观察真实业务状态，禁止盲目重放写入；
5. 读取所有逐 case 记录，按 Manifest 不可变顺序聚合最终结果。

早期 v2 状态可能没有绑定指纹。此时 Runner 先尝试恢复旧物理 session；若宿主明确返回 `session_incompatible`，Runner 最多轮换一次物理 thread，并先发送标准 resume prompt 重建上下文和核对 Ledger，再继续原 active epoch。普通业务错误、页面操作错误或未分类 Agent 错误不会触发该轮换；新 thread 仍不兼容时按基础设施阻断结束，禁止无限重启。

如果最终 JSON 响应在传输中断，但 epoch recovery artifact 已存在，Runner 只在确定性校验通过后采用它。Runner 不从日志、标题或页面残片补造 case 结果。

AgentHost 输出的 `Reconnecting... n/m` 是同一 turn 内的有界传输重试，Runner 只记录进度并等待终态；嵌套 quota 文本不会在第一次尝试时触发关闭，但明确的 `AccessDenied.Unpurchased`/模型未授权会立即归为 `provider_authorization`，不继续无效重连。明确余额耗尽仍保存为 `provider_rate_limited` 并等待外部额度恢复；可识别的瞬时 429/TPS/TPM 限流会按服务端提示等待一次，启动一代物理线程并用 resume 继续，仍失败才阻断。真正的上下文/输出容量错误才触发有限调度恢复：权威 Ledger 为空且没有交互回执的多 case epoch 可以二分，已有业务写入的 epoch 不得拆分重做，只能保留原 case 集并换一代线程恢复；finalization 最多恢复一次。case 结果已落盘后的 checkpoint 是可选记忆，超限时跳过，禁止为它继续消耗线程。

## 结果边界

最终 `codex-agent.result.json` 是逐 case 业务结论的结构化权威结果，`codex-agent.state.json.runInterruption` 是运行中断事实，`codex-agent.events.jsonl` 是脱敏技术事件流；Windows 控制台只确定性投影这三层事实，不另行裁决。`agent-workspace/case-results.json` 是给恢复和交付使用的版本化 artifact，Excel 结果文件是同一 case 事实的确定性投影。没有真实故障案例时，fixture、模型调用、合成数据和自适应调度测试只能证明框架行为，不能写成业务准确率或生产诊断准确率验收。

该分层借鉴 [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457) 对稳定问题类型、短摘要和实例细节的分离，以及 [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/) 对事件正文、属性和原始记录的分离。Auto-Test 不是 HTTP Problem Details API 或 OpenTelemetry exporter：这里只映射设计语义，分别使用稳定 `runInterruption.code`、人类可读摘要、逐 case 事实和按时间排序的脱敏事件流，并由测试验证它们不会互相覆盖。
