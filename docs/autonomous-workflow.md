# Autonomous Workflow（AgentHost 默认路径）

本文描述 AgentHost 默认执行链路。当前架构已抽象为宿主无关的 AgentHost：Codex 与 OMP 都可以成为真实测试执行主体，并遵守相同的输入、证据、Ledger 和结果合同。一次业务请求对应一个逻辑 Run；物理宿主 thread 只是容量和恢复资源，可以在 Run 内轮换。宿主选择和 OMP RPC 说明见 [AgentHost 宿主契约](agent-hosts.md)。

## 产品契约

Run 的终态只有：

- `passed`：请求的操作、可观察预期和最终状态均有具体证据；
- `product_failed`：正确执行后观察到产品或业务结果与预期不符；
- `blocked`：输入、环境、权限、恢复状态或基础设施阻止完成；
- `failed`：未被归类为可恢复阻断的框架异常。

每个非通过 case 必须有且只有一个 `failureSource`：`product`、`agent_execution`、`input`、`environment` 或 `infrastructure`。环境阻断必须引用同一 case 的已记录环境需求和证据；Runner 不从摘要文字猜测分类。

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

容量策略读取 Model Profile 的可选元数据：`contextWindowTokens`、`maxOutputTokens`、`caseOutputTokens`、`targetContextRatio` 和 `targetOutputRatio`。Runner 估算每条来源行的输入成本和结果输出成本，按预算生成 epoch；不会按固定 case 数隐式切分，也不要求工程师传入 `--case-batch-size`。

每个 epoch 的 AgentHost 交互顺序是：

1. 读取当前有界 Manifest、原始材料和相关图片；
2. 自主探索、执行、断言和恢复业务状态；
3. 如有 pending Mutation Ledger，继续使用同一 thread 重新观察并恢复；
4. 只为当前 epoch 生成有界结构化结果和 recovery artifact；
5. Runner 校验不可变身份、case 覆盖、证据、失败来源和被引用的回执；
6. Runner 将每条 case 以幂等记录写入 `.agent-private/case-results/`；
7. 若还有后续 epoch，AgentHost 写入 checkpoint，Runner 轮换 thread。

AgentHost 不必调用 `case_execution_begin/end`、`case_result_record` 或环境审计 turn 才能操作浏览器。回执是被动审计通道；只有结果中引用的回执需要校验归属和状态。`case_result_record` 不能覆盖逐 case store 的恢复事实。

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

`codex-agent.state.json` 使用 `version: "2.0"`，保存 `completedCaseIds`、`threadGeneration`、`activeEpoch`、`checkpointPath` 和最近一次 `turn.completed.usage`。旧版 `single_thread/case_windows`、`activeBatch`、`completedBatchIds` 和 `case-batches` 状态不再兼容；恢复旧状态会 fail closed，要求新建 Run。

恢复流程：

1. 校验原始 workflow ID、source SHA、Environment Profile 和 Mutation Ledger；
2. 读取逐 case store，将已完成 case 从待执行集合移除；
3. active epoch 有 thread ID 时恢复该 thread，否则从最近 checkpoint 启动下一代 thread；
4. 仍有 pending Mutation 时，选定 AgentHost 先重新观察真实业务状态，禁止盲目重放写入；
5. 读取所有逐 case 记录，按 Manifest 不可变顺序聚合最终结果。

如果最终 JSON 响应在传输中断，但 epoch recovery artifact 已存在，Runner 只在确定性校验通过后采用它。Runner 不从日志、标题或页面残片补造 case 结果。

## 结果边界

最终 `codex-agent.result.json` 是结构化权威结果，`agent-workspace/case-results.json` 是给恢复和交付使用的版本化 artifact，Excel 结果文件是同一事实的确定性投影。没有真实故障案例时，fixture、模型调用、合成数据和自适应调度测试只能证明框架行为，不能写成业务准确率或生产诊断准确率验收。
