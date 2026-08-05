# AgentHost 跨场景测试快速指南

Auto-Test 的默认入口是一个逻辑 Agent Run。Runner 是薄运行外壳：选定的 Codex 或 OMP 宿主负责理解原始测试材料、规划页面操作、执行和断言；Core 负责输入身份、权限、浏览器、证据、Mutation Ledger、进度和确定性结果交付。

长用例集不会要求工程师手工切分。Runner 根据模型 Profile 的上下文窗口和输出上限自动规划 execution epoch（执行纪元），每个 epoch 只交付有限 case；epoch 之间用 checkpoint 传递站点模型和恢复笔记，必要时启动新的物理 AgentHost thread。所有 epoch 仍属于同一个 Run。

## 1. 首次准备

```bash
npm ci
npx playwright install chromium
npm run check
```

Windows 私有包会自动安装固定版本 Node.js、默认 Codex CLI、依赖和 Chromium，并验证配置的模型 API。OMP 是可选宿主，需要在测试机另行安装并配置自己的 Provider。公开源码运行时，请通过宿主配置或模型 Profile/环境变量提供 Provider，密钥不要写入仓库。

## 2. 注册环境

日常推荐：

```bash
npm run easy
```

环境 Profile 至少登记目标 URL、登录状态和最高风险：`read` 只读，`write` 允许授权测试写入，`destructive` 允许授权测试清理。实际动作仍必须受测试材料、环境授权和 Mutation Ledger 约束。

## 3. 准备 Excel

每条来源行都会建立稳定的 case ID。Excel 应提供操作步骤、可观察预期、业务实体匹配规则、写入后的清理要求和必要的环境前置条件。URL 可以通过 `--url` 提供，也可以从 Excel 中发现；内嵌图片和补充图片会进入同一 Run 工作区。

## 4. 执行

命令行：

```bash
npm run easy -- run \
  --file /private/cases.xlsx \
  --url https://app.example.test/ \
  --url https://admin.example.test/ \
  --profile staging \
  --agent-host codex \
  --headed \
  --case-limit 1
```

`--one` 是 `--case-limit 1` 的快捷方式，真正把 Manifest 限制为一条 case；它不再只是把列表型数据 `maxIterations` 设为 1。完整执行省略 `--case-limit` 即可。

底层入口：

```bash
npm run agent:test -- \
  --file /private/cases.xlsx \
  --profile staging \
  --output-dir artifacts/runs/example
```

常用选项：

- `--image <path>`：补充截图，可重复；
- `--brief <path>`：不含秘密的业务说明；
- `--model <id>`：覆盖模型名；
- `--agent-host codex|omp`：选择宿主；默认 `codex`；
- `--agent-bin <path>`：当前宿主可执行文件；OMP 也可使用 `--omp-bin`；
- `--omp-home <path>`：OMP provider/auth 配置目录；仅复制允许的配置文件到私有 run；
- `--model-profile <id>`：选择已注册 Provider；
- `--max-iterations <N>`：列表型数据的 canary 上限，不切分 case；
- `--case-limit <N>`：只执行前 N 条 case；
- `--headed` / `--headless`：显示或隐藏浏览器；
- `--resume`：继续同一 Run，必须复用原 `--output-dir`；不指定宿主时自动复用原 Run 的宿主。

不存在 `--case-batch-size`。容量调度由 Model Profile 的可选字段控制：`contextWindowTokens`、`maxOutputTokens`、`caseOutputTokens`、`targetContextRatio`、`targetOutputRatio`。未提供时使用保守默认值。

### 使用 OMP

```bash
npm run easy -- run \
  --file /private/cases.xlsx \
  --url https://app.example.test/ \
  --profile staging \
  --agent-host omp \
  --omp-bin /path/to/omp
```

OMP 使用 `omp --mode rpc` 启动持久 JSONL 会话。Auto-Test 会在 run 工作区生成 `.omp/mcp.json`，把同一套 Playwright 与 Control MCP 注入 OMP；OMP 的 provider 配置可用 `--omp-home <dir>` 或 `AUTO_TEST_OMP_HOME` 指定，Core 只复制 provider/auth 白名单到私有 agent 目录，不复制用户 MCP 或历史 session。需要环境变量认证时，可用 `AUTO_TEST_AGENT_FORWARD_ENV` 显式列出要转发的变量。`agent-host-selection.json` 会记录实际宿主，恢复时宿主身份必须保持一致。

## 5. 运行机制

一次运行的核心状态如下：

```text
逻辑 Run
  -> capacity policy
  -> epoch-0001 / AgentHost thread A
  -> 每条 case result commit + workspace checkpoint
  -> epoch-0002 / AgentHost thread B（必要时）
  -> per-case store
  -> immutable-order deterministic aggregate
```

选定的 AgentHost 始终是真实测试执行主体。Runner 不解释业务语义，不生成第二份 Execution Plan，也不要求 `case_execution_begin/end`、`case_result_record` 或环境审计 turn 才允许浏览器工作。Control MCP 回执是可选审计信息，只有宿主在结果中引用的回执才会被确定性校验。

对外部业务写入使用 Mutation Ledger 记录完整业务操作。恢复时选定的 AgentHost 必须先重新观察真实状态；只要存在 `pending` Mutation，最终结果就只能是 `blocked`，不会继续调度后续 epoch。

## 6. 结果和恢复

主要文件：

- `codex-agent.state.json`：Run 状态、线程代数、完成 case、active epoch、checkpoint 和最近一次 turn usage；
- `codex-agent.result.json`：完整 `passed`、`product_failed` 或 `blocked` 结果；
- `.agent-private/case-results/`：逐 case 事实源，每个 case 一个幂等 JSON 记录；
- `.agent-private/execution-epochs/`：每个 epoch 的有界结构化结果；
- `.agent-private/checkpoints/`：选定 AgentHost 在 thread 轮换前写入的工作记忆；
- `.agent-private/mutation-ledger.json`：私有副作用恢复账本；
- `agent-workspace/execution-receipts.json`：被动捕获的 Playwright 回执；
- `agent-workspace/case-results.json`：最终确定性聚合的交付 artifact；
- `原文件名-Auto-Test-结果.xlsx`：按来源行回写的结果副本；
- `codex-agent.events.jsonl`：脱敏事件流，可用于追溯进度和失败位置。

中断后：

```bash
npm run easy -- run \
  --file /private/cases.xlsx \
  --profile staging \
  --output-dir artifacts/runs/example \
  --resume
```

恢复会校验 workflow/source 身份和 Ledger。已写入逐 case store 的 case 不会重跑；active epoch 会恢复原 thread，容量轮换后的新 epoch 会从 checkpoint 和原工作区继续。旧版 `version: 1.0` 状态、`activeBatch`、`completedBatchIds` 等状态不再兼容，恢复会 fail closed 并要求新建 Run。

需要比较两个宿主时，先用同一输入包执行两个独立 Run，再执行 `npm run agent:compare -- --run <codex-run> --run <omp-run>`。比较器只读取结构化结果、证据和 Ledger，不启动新的 Agent，也不重复业务写入。

## 7. 结果边界

- `passed`：每条 case 的操作、预期和最终状态均有具体证据；
- `product_failed`：正确执行后观察到业务结果与预期不符；
- `blocked`：环境、权限、输入、恢复状态或基础设施阻止完成；
- `failed`：未被归类为可恢复阻断的框架异常。

没有真实故障案例时，fixture、模型调用或合成数据只能证明调度、恢复、证据契约和结果聚合，不构成业务准确率验收。首次接入真实系统应从一条只读 canary 开始，再扩大范围。

## 8. 多模型 Profile

Profile 注册表位于 Linux/macOS 的 `~/.config/auto-test/model-profiles.json`，Windows 位于 `%APPDATA%\auto-test\model-profiles.json`。API Key 只通过 `envKey` 指向的环境变量提供：

```json
{
  "version": "1.0",
  "defaultProfileId": "primary",
  "profiles": [
    {
      "id": "primary",
      "model": "your-model",
      "providerId": "primary_api",
      "baseUrl": "https://model-api.example.test/v1",
      "wireApi": "responses",
      "envKey": "AUTO_TEST_MODEL_API_KEY",
      "contextWindowTokens": 128000,
      "maxOutputTokens": 16000
    }
  ]
}
```

额度、容量或上游网络异常会形成可恢复的 `infrastructure` 结果。修复或切换 Profile 后，用原输出目录执行 `--resume`，不要复制结果目录或手工改结果。
