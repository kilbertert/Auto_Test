# AgentHost 跨场景测试快速指南

Auto-Test 的默认入口是一个逻辑 Agent Run。Runner 是薄运行外壳：选定的 Codex 或 OMP 宿主负责理解原始测试材料、规划页面操作、执行和断言；Core 负责输入身份、权限、浏览器、证据、Mutation Ledger、进度和确定性结果交付。

长用例集不会要求工程师手工切分。Runner 根据模型 Profile 的上下文窗口和输出上限自动规划 execution epoch（执行纪元），每个 epoch 只交付有限 case；epoch 之间用 checkpoint 传递站点模型和恢复笔记，必要时启动新的物理 AgentHost thread。所有 epoch 仍属于同一个 Run。

## 生成快速回归 spec

成功运行会自动生成 `agent-workspace/replay/replay-manifest.json` 和逐 case spec/config。探索线程在 case episode 外捕获 cookies/localStorage 和 sessionStorage，Core 将临时文件提升到 `.agent-private/` 后删除工作区原件。Environment Profile 上限为 `read` 时，所有 passed case 都使用这份认证前置在新 BrowserContext 中实际回放，通过后才标记 `verified`，不受 intake 的单 case 风险推断影响；允许 `write`/`destructive` 的 Profile 只自动回放被判定为 `read` 的 case，其余只生成 `candidate`，避免再次制造副作用。生成 config 的测试超时为 180 秒、导航超时为 90 秒，可覆盖合法的 30 秒以上业务等待。缺少认证态捕获、完整断言或独立回放通过时，passed 交付会回到同一 Agent 线程修正。编译器只采用最后一个完整、可重放且含断言的 case attempt；历史 Run 仍可用 `npm run compile:replay` 手工迁移。敏感输入从同一 Run 的私有 `AUTO_TEST_VALUE_*` 文件加载，不写入 spec。

## 1. 首次准备

```bash
npm ci
npx playwright install chromium
npm run check
```

Windows 私有包会自动安装固定版本 Node.js、默认 Codex CLI、依赖和 Chromium，并验证默认模型 API。OMP 是可选宿主，需要在测试机另行安装；模型 Provider 可由同一个 Auto-Test Model Profile 交给 OMP 适配器，legacy/native Run 也可使用 OMP 自身配置。公开源码运行时，请通过宿主适配器、宿主配置或 Model Profile/环境变量提供 Provider，密钥不要写入仓库。

## 2. 注册环境

日常推荐：

```bash
npm run easy
```

环境 Profile 至少登记目标 URL 和最高风险：`read` 只读，`write` 允许授权测试写入，`destructive` 允许授权测试清理。登录状态是可选会话种子，注册时默认不捕获；如果 Excel 要测试登录、登出或会话失效，应保持该默认，让 AgentHost 真实执行认证用例。实际动作仍必须受测试材料、环境授权和权威 Mutation Ledger 约束；对外部持久化写入，Agent 必须通过 `auto-test-control.mutation_begin` / `mutation_resolve` 登记和核销，工作区自建的同名文件不算登记。

## 3. 准备 Excel

每条来源行都会建立稳定的 case ID。Excel 应提供操作步骤、可观察预期、业务实体匹配规则、写入后的清理要求和必要的环境前置条件。新 AgentHost Run 必须用 `--url` 明确提供本次被测环境入口；Excel 中出现的其他链接仍保留给 Agent 理解和探索，但不会仅因出现在单元格中就成为 Environment Profile 的预执行覆盖要求。内嵌图片和补充图片会进入同一 Run 工作区。

新 intake 会为每条 case 同源生成 `outcome`：`action` 是必须执行的操作，`observable` 是必须观察到的业务结果，`evidence` 声明交互和观察证据，`cleanup` 保留来源清理要求，`failureModes` 声明该 case 允许被归入的失败模式。它是 Agent、结果交付和 eval 共用的完成定义，不是第二套 Planner DSL；完整业务含义仍以原 Excel、brief 和图片为准。

失败模式统一为八类：`input`、`authentication`、`environment`、`locator_navigation`、`business_assertion`、`mutation_cleanup`、`agent_execution`、`infrastructure`。结果校验会把非 passed case 的 `failureSource`/`failureKind` 映射到同一八类，若不在该 case 的 `failureModes` 合同内则拒绝；只读 case 不允许 `mutation_cleanup`。

最终校验会拒绝 outcome 的假通过：非阻断 case 必须有具体观察证据，并在合同要求时引用同 case 的 interaction 回执。`blocked` 可以发生在交互之前，因此不强制 interaction；写入清理仍只由权威 Mutation Ledger 判定，避免出现第二套相互冲突的清理状态。

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

`--one` 是 `--case-limit 1` 的快捷方式，真正把 Manifest 限制为一条 case，并只保留该 case 引用的材料链接；未执行 case 中的链接不会提前阻断 canary。完整执行省略 `--case-limit` 即可。

底层入口：

```bash
npm run agent:test -- \
  --file /private/cases.xlsx \
  --url https://app.example.test/ \
  --profile staging \
  --output-dir artifacts/runs/example
```

常用选项：

- `--image <path>`：补充截图，可重复；
- `--brief <path>`：不含秘密的业务说明；
- `--model <id>`：覆盖模型名；
- `--agent-host codex|omp`：选择宿主；默认 `codex`；
- `--agent-bin <path>`：当前宿主可执行文件；也可设置 `AUTO_TEST_AGENT_BIN`；
- `--agent-home <path>`：当前宿主的原生 provider/auth 源目录；只复制宿主允许的内容到私有 run；
- `--codex-bin/--omp-bin`、`--codex-home/--omp-home`：上述通用参数的兼容别名，并同时选择对应内置宿主；
- `--model-profile <id>`：选择模型 Provider；内置 `deepseek` / `volcengine`，也可从注册表选择自定义 Profile；
- `--max-iterations <N>`：列表型数据的 canary 上限，不切分 case；
- `--case-limit <N>`：只执行前 N 条 case；
- `--headed` / `--headless`：显示或隐藏浏览器；
- `--resume`：继续同一 Run，必须复用原 `--output-dir`；不指定宿主时自动复用原 Run 的宿主。

不存在 `--case-batch-size`。容量调度由 Model Profile 的可选字段控制：`contextWindowTokens`、`maxOutputTokens`、`caseOutputTokens`、`targetContextRatio`、`targetOutputRatio`。`inputModalities`、`reasoningEfforts` 和 `supportsParallelToolCalls` 描述模型能力。Profile 元数据由 Core 用于调度和输入选择；各 AgentHost 决定如何写入自己的目录（例如 Codex `models.json` 或 OMP `models.yml`）。协议字段使用统一 `api` 名称；宿主不支持该 API 时会在模型请求前 fail closed。旧注册表中的 `wireApi: "responses"|"chat"` 仅作为兼容输入读取。

### 使用 OMP

```bash
npm run easy -- run \
  --file /private/cases.xlsx \
  --url https://app.example.test/ \
  --profile staging \
  --agent-host omp \
  --agent-bin /path/to/omp
```

OMP 使用 `omp --mode rpc` 启动持久 JSONL 会话。Auto-Test 会在 run 工作区生成 `.omp/mcp.json`，把同一套 Playwright 与 Control MCP 注入 OMP；native provider 配置可用通用 `--agent-home <dir>` 或 `AUTO_TEST_AGENT_HOME` 指定，`--omp-home` / `AUTO_TEST_OMP_HOME` 仍兼容。OMP 适配器只复制 provider/auth 白名单到私有 agent 目录，不复制用户 MCP 或历史 session。需要环境变量认证时，可用 `AUTO_TEST_AGENT_FORWARD_ENV` 显式列出要转发的变量。`agent-host-selection.json` 会记录实际宿主与供应商绑定，恢复时宿主身份必须保持一致。

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

每个 epoch 的 manifest 只保留当前 case 的完整步骤、资源和图片，同时携带全 Run 的紧凑 `materialIndex`（case ID、标题、来源行、风险和图片数量）。Agent 可据此按需回看原始材料，不需要把其他 case 的正文和图片全部放入当前上下文。

经验性知识（站点技巧、异步等待、表格实体识别、跨域会话等）按需加载为场景 Skill/brief，不永久塞进通用 Prompt；它们由 `requiredCapabilities` 等来源信号选择。安全和结果协议（Mutation Ledger、认证状态、outcome 合同、交付合同）继续留在 Core，不随 brief 变化。

Core 拥有 bounded fan-out 策略（`fanoutPolicy`），通过 Control MCP `test_contract` 以单一来源暴露给 Agent：默认只读、并发上限为 1。该策略是 Core 声明并由 Agent 遵守的单一来源（Core 不拦截 Agent 内部的 sub-agent 调用，故不提供逐任务确定性门禁）；真实写入型测试不会被拆成默认并行 agent。

选定的 AgentHost 始终是真实测试执行主体。Runner 不解释业务语义，不生成第二份 Execution Plan，也不要求 `case_execution_begin/end`、`case_result_record` 或环境审计 turn 才允许浏览器工作。Control MCP 回执是可选审计信息，只有宿主在结果中引用的回执才会被确定性校验。

对外部业务写入使用 Mutation Ledger 记录完整业务操作。恢复时选定的 AgentHost 必须先重新观察真实状态；只要存在 `pending` Mutation，最终结果就只能是 `blocked`，不会继续调度后续 epoch。

## 6. 结果和恢复

主要文件：

- `codex-agent.state.json`：Run 状态、线程代数、完成 case、active epoch、无密钥的 AgentHost/模型绑定指纹、checkpoint 和最近一次 turn usage；
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

恢复会校验 workflow/source 身份和 Ledger。已写入逐 case store 的 case 不会重跑；active epoch 通常恢复原 thread，容量轮换后的新 epoch 会从 checkpoint 和原工作区继续。若基础设施恢复需要切换模型 Profile，逻辑 Run、active epoch、工作区和 Ledger 保持不变，但与新 AgentHost/Provider/模型绑定不兼容的物理 session 会被下一代 thread 替换；新 thread 必须先执行 resume 协议并核对 pending Mutation。早期 v2 状态没有绑定指纹时，Runner 只在宿主明确报告 session 不兼容后轮换一次；普通执行错误不会触发轮换。旧版 `version: 1.0` 状态、`activeBatch`、`completedBatchIds` 等状态不再兼容，恢复会 fail closed 并要求新建 Run。

需要比较两个宿主时，先用同一输入包执行两个独立 Run，再执行 `npm run agent:compare -- --run <codex-run> --run <omp-run>`。比较器只读取结构化结果、证据和 Ledger，不启动新的 Agent，也不重复业务写入。两个 Run 必须同时提供 immutable `test-manifest.json`、一致的 `workflowId`/`sourceSha256`、Excel 与同名 sidecar/image 的 `input-bundle.json`、Manifest hash、Environment selection hash、平台、架构、Auto-Test 包版本、commit 和 `agent-host-selection.json`。缺少或不一致的任一合同输入时，比较器会 fail closed，结果为 `invalid`，不会继续给出宿主等价性结论。

把第一个 `--run` 固定为已验证 baseline，并提供绑定同一 immutable input 的 oracle，即可得到最小 eval scorecard：逐 case 命中率、八类失败模式分布、证据/回执/Mutation 数量、耗时、聚合 token（输入/缓存输入/输出）、线程代数/恢复次数/epoch 数，以及相对 baseline 的 delta。CI 或故障 probe 使用 `--require-oracle-match`；任何候选没有完整命中 oracle（包括“本应 blocked/product_failed 却返回 passed”）都会返回非零：

```bash
npm run agent:compare -- \
  --run artifacts/runs/baseline \
  --run artifacts/runs/candidate \
  --oracle evals/readonly-canary.oracle.json \
  --require-oracle-match \
  --output artifacts/evals/readonly-canary.json
```

oracle 只记录已独立验证的 outcome 和必要失败分类，不从待评估 Run 自身生成。写入型真实场景不得为了比较而在同一业务实体上盲目重复执行；优先使用只读 canary、隔离测试数据或已经完成的 Run 制品。

固定回归任务集由 `src/eval/eval-suite.ts` 的 `canonicalEvalSuite()` 声明为版本化清单（canary、本地 fixture、Windows 验收、中断恢复），并保证八类失败模式每类至少被一个任务覆盖。AgentHost、Prompt、Model Profile 或 checkpoint 变更时，用这套固定任务集比较业务 outcome、证据完整性、Ledger 终态、失败来源、token/时间以及重试恢复次数；比较仍通过 `agent:compare` 完成，不引入新服务。

`npm run eval:suite -- --run <baseline-run> --run <candidate-run> ...` 是这份任务集的薄聚合入口：它按 `canonicalEvalSuite()` 逐个跑 `agent:compare` 并汇总门禁结果。第一个 `--run` 是 baseline，其后是候选；任一 `requiresOracleMatch` 任务有候选未完整命中 oracle 即返回非零。oracle 是业务专属 ground truth（和真实 xlsx 一样私有），放在 gitignored 的 `evals/` 下、按 `templates/eval-oracle.example.json` 的格式人工编写；未编写的任务会被 `eval:suite` 跳过而非报错。

## 7. 结果边界

- `passed`：每条 case 的操作、预期和最终状态均有具体证据；
- `product_failed`：正确执行后观察到业务结果与预期不符；
- `blocked`：环境、权限、输入、恢复状态或基础设施阻止完成；
- `failed`：未被归类为可恢复阻断的框架异常。

没有真实故障案例时，fixture、模型调用或合成数据只能证明调度、恢复、证据契约和结果聚合，不构成业务准确率验收。首次接入真实系统应从一条只读 canary 开始，再扩大范围。

## 8. 多模型 Profile

Profile 注册表位于 Linux/macOS 的 `~/.config/auto-test/model-profiles.json`，Windows 位于 `%APPDATA%\auto-test\model-profiles.json`。新 Run（无论 Codex 还是 OMP）没有显式选择或自定义默认项时使用内置 `deepseek`；`--model-profile` 可切换到内置 `volcengine` 或任意自定义 Profile。Core 只解析统一 `api`、模型、端点和容量；Codex/OMP 适配器分别生成隔离的 TOML/YAML。API Key 只通过 `envKey` 或 `envKeyAliases` 指向的环境变量提供。自定义 `providerId` 必须以字母或下划线开头，后续只使用字母、数字、下划线或连字符，避免破坏任意宿主的 Provider selector。下面示例通过 `defaultProfileId` 把自定义 `primary` 提升为默认，从而覆盖内置 DeepSeek：

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
      "api": "openai-responses",
      "envKey": "AUTO_TEST_MODEL_API_KEY",
      "contextWindowTokens": 128000,
      "maxOutputTokens": 16000
    }
  ]
}
```

内置 Profile 的公开元数据如下（示例不包含任何 Key）：

| Profile | Model | Base URL | API Key 环境变量 | Context window |
| --- | --- | --- | --- | ---: |
| `deepseek` | `deepseek-v4-flash` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | 1,048,576 |
| `volcengine` | `glm-5.2` | `https://ark.cn-beijing.volces.com/api/coding/v3` | `ARK_API_KEY`（兼容 `VOLCENGINE_API_KEY`） | 1,024,000 |

例如：

```bash
DEEPSEEK_API_KEY='<secret>' npm run agent:test -- \
  --file cases.xlsx --url https://app.example.test/ --profile staging
```

选择优先级是显式 `--model-profile`、恢复记录、自定义 `defaultProfileId`、Windows 私有包的 `windows-private` 运行时默认、注册表中的同名 `deepseek`、内置 `deepseek`。精确匹配内置 DeepSeek 的 Windows 包不会创建较弱的运行时副本，而是使用完整内置元数据；只有一个自定义 Profile 但未设置 `defaultProfileId` 时不会隐式取代 DeepSeek。额度、容量或上游网络异常会形成可恢复的 `infrastructure` 结果。修复或切换 Profile 后，用原输出目录执行 `--resume`；未显式传入新的 `--model-profile` / `--model` 时会复用上次有效选择。旧 Run 没有 `model-selection.json` 时，裸恢复继续使用原 AgentHost 的 Provider。不要复制结果目录或手工改结果。
