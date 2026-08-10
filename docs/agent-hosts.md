# AgentHost：宿主无关执行

Auto-Test 的测试核心不再依赖某一个代理产品。`AgentHost` 是一条窄的运行时契约：宿主负责启动或恢复自己的会话、发送文本/图片输入、流式返回事件；Auto-Test Core 负责 Excel 与 sidecar 身份、环境权限、浏览器与 MCP 配置、证据、Mutation Ledger、逐 case 回执和最终结果合同。

## 可用宿主

| 宿主 | 选择值 | 传输 | 结构化输出 | 会话恢复 | Provider 适配 |
| --- | --- | --- | --- | --- | --- |
| Codex CLI | `codex`（默认） | Codex SDK/CLI thread | 原生支持 | 支持 | `CodexModelProviderAdapter`：Profile -> 隔离 `config.toml` + `models.json` |
| oh-my-pi | `omp` | OMP RPC JSONL (`omp --mode rpc`) | 由同一最终 JSON 提示和 Core 校验 | RPC session 文件 | `OmpModelProviderAdapter`：Profile -> 隔离 `models.yml` |

宿主能力记录还包含 `workspaceIsolation`：Linux/macOS 的 Codex 为 `enforced`，Windows Codex 直连模式因原生 CLI 的 MCP/shell 限制使用 `danger-full-access`，因此如实记录为 `prompt_only`；OMP 一直为 `prompt_only`。这不会改变两者的业务结果合同，但会在审计和竞争报告中保留真实执行边界。

## 当前验收状态

PR #28 已合并到 `main`（commit `836c849`）。截至 2026-08-06，Codex 与 OMP 已在 Linux x64 分别完成同一份真实写入型充电 canary。业务执行基线为 `836c849`，OMP 的最终交付恢复使用本文所在提交的修复；包版本均为 `0.1.0`。源文件 SHA-256 为 `212edae85a34b84cd948a8e9f40d2d93112f063d18290cd858ea2a06ed820781`，两个 run 的实际 Manifest 字节一致，SHA-256 为 `6a4b035377e8dc809e117bdf53a52be1a35e0d97433a9b9e9207159b3843af02`，比较器归一化输入包 SHA-256 均为 `2aefe7acca65639d9dd68ed6151d5420ab05c139bda3d0beb512bbb305d35e74`。

| 宿主 | 结果 | Ledger 终态 | 证据文件 | 被动回执 | 隔离边界 |
| --- | --- | --- | ---: | ---: | --- |
| Codex | `3/3 passed` | 7 `accepted`，`pending=0` | 355 | 772 | `enforced` |
| OMP | `3/3 passed` | 7 `accepted`，`pending=0` | 138 | 220 | `prompt_only` |

确定性比较器判定 `contractStatus=valid`、`verdict=equivalent`，逐 case 无差异。OMP 在本次 canary 中消耗的壁钟时间明显更多；其状态时间包含后续交付恢复验证，因此不能当作纯模型性能基准。默认宿主继续保持 Codex：它具有原生结构化输出、`enforced` workspace isolation 和受限模式；OMP 保留为同合同 challenger。一个复杂 canary 不能推出某个宿主在所有行业、页面控件或输入格式中全面胜出，Windows 写入型业务验收也仍需单独完成。

2026-08-07 又在实现 commit `88f8e5c`、包版本 `0.1.0`、Linux x64 上完成了 AgentHost 无关 Model Profile 的独立验收。Codex CLI `0.146.0` 与 OMP `17.2.9` 分别使用内置 `deepseek` Profile 和同一份三 case 合成写入型 fixture：目录筛选、详情核对、创建并删除同一条 note。源 Excel SHA-256 为 `bffbff6f31f5f321a4fa729d09f2da4b89d84150d970fddc05798429b8f188fc`；两个 run 的 immutable Manifest 文件 SHA-256 均为 `7779aa9875bba9a434185370e225d84cc55d70ce1cf8b83f13eadeaa348d3c80`，比较合同中的 canonical Manifest SHA-256 为 `4f890d908bfbb4bb64924e4d9d6a288392dc8d08b25e7146436eb81d796bfeb0`，input bundle 与 environment hash 分别为 `2b0d11e2992a03f68f84056636318565aed85fd05c3a55a3acc7e33a8ad67773` 和 `8af9ae2a0d8af5b610e92680bf261cde0ca468fb1ff7440d9ee59f1405cc7987`。

| 宿主 | 结果 | case 证据引用 | 被引用回执 | Ledger 终态 | 壁钟时间 |
| --- | --- | ---: | ---: | --- | ---: |
| Codex | `3/3 passed` | 15 | 0 | 1 `compensated`，`pending=0` | 322,366 ms |
| OMP | `3/3 passed` | 9 | 6 | 1 `compensated`，`pending=0` | 202,685 ms |

两次运行结束后 fixture 都恢复为 `0 notes`，并生成含逐 case 结果列的回写工作簿。比较器再次得到 `contractStatus=valid`、`verdict=equivalent`、零 case difference。该 canary 使用真实 DeepSeek 模型请求和真实浏览器/Control MCP 写入补偿，但被测站点是合成 fixture；它证明两个 Provider 适配器能在同一 Core 合同下投入 Linux canary 使用，不证明 Windows 业务闭环、Volcengine 可用性、任意未知网站一次成功或两个宿主在所有场景中业务判断等价。

Core 对 `mutations` 和 `environmentRequirements` 拥有唯一确定性权威。AgentHost 返回的同名集合只是重复投影，不能覆盖 Core 的 Ledger 或环境需求账本；`Mutation Ledger` 只能通过 `auto-test-control.mutation_begin` / `mutation_resolve` 写入，Agent 自己在工作区创建的同名 JSON 不能冒充账本。逐 case 业务结论、分类和证据仍须通过完整 schema。Codex 的结构化输出和 OMP 的文本回执使用同一业务合同；Provider-facing Schema 只使用跨供应商可接受的对象、数组和标量类型，空字符串/空数组作为不适用字段的传输哨兵，Core 在结果边界恢复可选字段语义。若已阻断的 run 存在覆盖全部 immutable case、无重复且证据可解析的逐 epoch 交付，并且权威 Ledger 没有 `pending`，`--resume` 会先验证并恢复这些事实，不启动浏览器或 AgentHost，也不重做业务写入。证据文件名包含运行 Secret 时，框架会同步清理生成文件名和交付引用；`input/` 中的原始输入包保持不变。

两者收到相同的原始 Excel、同名 `.auto-test` sidecar、图片、环境上下文、run 工作区和测试提示。Core 不读取页面业务语义，也不生成第二个 Planner 或 Reporter。OMP 不支持 Codex 的 `outputSchema` 参数时，仍必须返回同一 `codex-agent.result.json` 合同；Core 会用相同的 schema、case 覆盖、证据、环境需求和 Ledger 校验。Provider 探针只验证模型请求能建立；如果供应商拒绝结构化输出，Runner 会把它归为基础设施/Agent 交付问题，并要求在同一线程上补交同一合同，而不会把已完成业务误报成产品失败。

`codex-agent.*` 是历史文件名，为了恢复旧 Run 保留；它不表示结果由 Codex 生成。宿主身份、平台、Node 版本、Auto-Test 包版本和可用 commit 会同时写入 `agent-host-selection.json`。

## 选择宿主

底层入口：

```bash
npm run agent:test -- \
  --file /private/cases.xlsx \
  --url https://app.example.test/ \
  --profile staging \
  --agent-host codex
```

使用 OMP：

```bash
npm run agent:test -- \
  --file /private/cases.xlsx \
  --url https://app.example.test/ \
  --profile staging \
  --agent-host omp \
  --agent-bin /path/to/omp
```

也可以设置 `AUTO_TEST_AGENT_HOST=omp`。`--agent-bin` / `AUTO_TEST_AGENT_BIN` 和 `--agent-home` / `AUTO_TEST_AGENT_HOME` 是当前宿主的通用运行时覆盖；`--codex-bin/--omp-bin`、`--codex-home/--omp-home` 以及对应宿主环境变量只保留兼容性，并在 CLI 边界归一化，Core 不读取它们。

原生 home 只在没有 Auto-Test Profile 时用于保留宿主自己的 Provider/auth 状态。选择 Profile 后，OMP 适配器会在 run 私有目录生成只包含该 Provider 的 `models.yml`，并用 `--model <provider>/<model>` 选择它，不会和用户 `models.yml` 混用。原生副本只允许 `config/models`、当前 `agent.db` auth store（含 SQLite sidecar）、旧版 `auth.json` 和 `settings.json`；`.env` 不会整文件复制，如确需使用其中的环境变量，必须通过 `AUTO_TEST_AGENT_FORWARD_ENV` 显式列出键。首次运行省略 home 时读取宿主默认目录；Codex 在 Windows 会回退到 `%USERPROFILE%\.codex`，并保留当前 Provider 的 `http_headers` / `env_http_headers` 子表，但子表引用的额外环境变量仍须加入 `AUTO_TEST_AGENT_FORWARD_ENV`。恢复时若没有显式提供新的 home，会保留原 run 已复制的 Provider 文件。复制前应关闭正在写同一 auth store 的 OMP 进程，或改用显式 Profile 环境变量。一次 Run 选定的宿主会写入 `agent-host-selection.json` 和状态文件，`--resume` 不允许静默更换宿主。

Provider 选择在 AgentHost 边界完成。Core 只传递 `AgentModelProviderDescriptor`（`providerId`、`model`、`baseUrl`、统一 `api`、输入模态、推理/容量能力和环境变量引用），再调用选中 Host 的 `modelProvider.prepare()`；适配器负责原生文件、selector、启动参数和隔离环境。Codex 当前声明只支持 `openai-responses`，并映射为 `wire_api = "responses"`。受管 Profile 的 `models.json` 以当前安装版 Codex CLI 的 bundled model catalog 为模板，保留该版本原生 agent instructions 和必需 schema，再只覆盖 Profile 声明的模型、推理、搜索、输入模态和容量能力；模板不可读取或生成文件不能由真实 CLI 解析时会在模型请求前 fail closed。这样既避免第三方模型落入错误的 fallback metadata，也不会用框架自制的弱提示替换 Codex 原生执行框架。Codex Web Search 只有在 Profile 明确声明 `supportsSearchTool: true` 时启用。OMP 声明支持 OMP catalog 的协议集合，并把同一 descriptor 写成 `models.yml`。因此 `openai-completions` 等 Profile 可以被 OMP 消费，但会在 Codex 适配器准备阶段明确拒绝，而不是让 Runner 解析 Codex 字段。第三方 Host 只需实现相同接口；已有合成 Host 契约测试证明它不需要在 Runner 增加 ID 分支。自定义模型应声明真实上下文窗口、输出上限和输入模态，避免错误调度或把不支持的图片发送给 Provider；仅 native 配置且没有目录元数据时，Codex 才可能保留 fallback metadata 警告。

仓库提供两个无密钥内置 Profile：

| Profile | Model | Base URL | `envKey` | 备注 |
| --- | --- | --- | --- | --- |
| `deepseek` | `deepseek-v4-flash` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | Responses HTTP；文本输入；不启用 WebSocket |
| `volcengine` | `glm-5.2` | `https://ark.cn-beijing.volces.com/api/coding/v3` | `ARK_API_KEY` | 文本输入；同时接受 `VOLCENGINE_API_KEY` / `VOLCENGINE_ARK_API_KEY` |

新 Run 默认选择 `deepseek`，无论选用 Codex 还是 OMP；显式传入 `--model-profile volcengine` 可切换火山，显式参数、自定义注册表的 `defaultProfileId` 和同名 `deepseek` 定义都能覆盖内置默认元数据。Windows 私有包若使用其他 endpoint/model，会在当前启动进程发布一个不含 Key 的 `windows-private` 默认 Profile；精确匹配内置 DeepSeek 时则保留内置推理、容量和输入模态元数据。API Key 必须由当前进程环境提供，缺失时适配器会在模型请求前 fail closed。裸 `--resume` 优先复用 `model-selection.json` 中的 Profile 与模型覆盖；升级前没有该文件的旧 Run 继续使用原 AgentHost Provider，以避免迁移后静默换模。供应商是否开放精确模型 ID、账号额度和结构化输出兼容性仍需用真实 Provider canary 验证，不能由配置解析通过推断。

Codex 使用受管 Model Profile 时，会在 AgentHost 内启动仅监听 `127.0.0.1` 的 Responses 工具兼容桥。Codex CLI 发出的 namespace MCP 工具会在请求边界展开为标准 Responses `function` 工具，Provider 返回的调用再恢复为 Codex 可路由的 namespace 调用；API Key 只作为请求头经过内存转发，不写入桥接日志或文件。第三方 Provider 因此不必实现 Codex 的 namespace 扩展，但至少必须正确支持标准 Responses function tools、流式 SSE、工具结果续传以及所选模型的工具调用。未选择 Model Profile 的 native Codex 配置不经过这层桥接，其 Provider 必须自行兼容 Codex 原生工具协议。

## OMP 前置条件

Auto-Test 不把 OMP 二进制或用户 OMP 配置复制进仓库或公开包。内部私有 Windows 包可以携带一个默认 Provider 的一次性引导凭据；首次启动会导入 DPAPI 并删除解压目录中的明文文件，随后 Codex 或 OMP 都可消费对应 Model Profile。使用 OMP 前仍需在测试机安装 `omp` 并确认 `omp --version` 能运行。选择 Auto-Test `--model-profile` 时，OMP 适配器在私有 `agentHome/models.yml` 中生成本次 Profile，并通过选定环境变量认证；不选择 Profile 的 legacy/native Run 才会复制 OMP 自身的 provider/auth 文件。两种路径都会设置 `PI_CODING_AGENT_DIR` 与隔离 session 目录，不继承调用者的 OMP profile、用户 MCP、插件或历史 session。Auto-Test 会在每个 run 工作区生成 `.omp/mcp.json`，其中只包含本次 Playwright 和 `auto-test-control` MCP 的隔离命令与路径；不会复用用户的 Codex MCP 配置。

OMP 启动时会在 run 工作区写入一个项目级 `.omp/config.yml`：关闭 OMP 自带 browser、memory/autolearn 和用户扩展，并强制启用项目 MCP。这样 OMP 与 Codex 都通过同一份 run-scoped Playwright/Control MCP 操作浏览器；OMP 自带 browser 不会悄悄替换 Playwright 会话。`shell`、网络和高风险业务操作仍受测试环境 Profile、run 工作区约定和 Mutation Ledger 约束。`--auto-approve` 只表示已授权的测试动作不被宿主交互提示卡住，不扩大目标 URL 或业务权限。

Linux/macOS 的 Codex `workspace-write` sandbox 只额外开放当前 Run 的 `.agent-private` 目录（通过 SDK `additionalDirectories`），让 Control MCP 能写入权威 Ledger 和环境需求；不会开放仓库或用户 home。Windows Codex CLI 0.146.0 在该模式下无法启动子 MCP 或可写 shell，Auto-Test direct 模式会自动使用 `danger-full-access`；因此 Windows 不能宣称操作系统级 workspace isolation，实际能力会写入 `agent-host-selection.json`。OMP 当前也没有 Codex SDK 同等级的操作系统 workspace sandbox；“只写 run 工作区”主要由提示、项目配置和审计合同约束。需要真实业务验收时，应使用专用测试机/账号，并把该差异保留在 `agent-host-selection.json` 与验收记录中；这也是 OMP 不能冒充 `--opaque-test-data` 的原因。

默认 direct 模式会向宿主提供运行所需的最小系统环境变量。若 OMP Provider 只支持环境变量认证，可在启动 Auto-Test 前设置 `AUTO_TEST_AGENT_FORWARD_ENV=OMP_API_KEY,OTHER_PROVIDER_KEY`；只有列出的变量会进入隔离宿主进程，且不会进入 Playwright/Control MCP 子进程。当前 OMP 适配器不宣称支持 `--opaque-test-data` 的受限工具模式，使用该模式会明确阻断，不会假装已经隔离。

AgentHost 在页面、网络响应或浏览器存储中观察到的运行期凭据不一定属于输入 Secret。每个 turn 后的生成文本清洗会同时识别 Authorization/Cookie/API key、`access_token`/`refresh_token` 等敏感键和 JWT 形态；JSON/JSONL 仍保持可解析，JSONL 按行流式清洗并通过同目录临时文件替换，因此可以恢复处理旧版本留下的大事件日志。immutable `test-manifest.json` 和原始输入不会被清洗器改写。该清洗不处理截图、PDF 等二进制证据，也不改写用于恢复的 `.agent-private`，因此外发前仍要人工检查二进制证据并排除私有目录。

OMP RPC 的 `message_update` 和 `tool_execution_update` 是包含累计完整内容的瞬时帧；适配器不会把它们送入 Core 事件日志。完整 `message_end`、工具开始/完成、错误和 turn 终态仍按共同 AgentHost 事件合同保留，因此诊断、进度、执行回执和最终交付不受影响。

进度回调是同一事件合同的安全投影，不是第二个执行裁决器。每个宿主动作会归一化为 `server.tool`（或 `command_execution` / `file_change`）类别，并在控制台回显 `started`、`completed` 或 `failed`、动作序号和耗时；回调还携带 `hostId`、当前 epoch 和 thread generation。相同 `callId` 的重复开始/完成帧只报告一次。心跳优先显示仍在进行的动作及其持续时间，空闲时显示最近动作和恢复状态。参数、结果、命令正文、表单值、Cookie、验证码和模型推理正文永远不进入该投影；需要逐帧审计时查看同一 Run 的脱敏 `codex-agent.events.jsonl`、执行回执和证据制品。

## 公平比较

比较 Codex 和 OMP 时固定以下输入：Excel、sidecar、URL、Environment Profile、风险策略、浏览器版本、模型材料和 `--case-limit`。不要把某个宿主的临时提示、Execution Plan、定位器或脚本复制给另一个宿主。比较结果以以下共同交付为准：

- `codex-agent.result.json` 的逐 case outcome、failureSource 和 failureKind；
- `agent-workspace/test-manifest.json` 的完整冻结内容与 Manifest hash；
- `environment-selection.json` 的 Profile、origin、认证范围和风险权限 hash；
- `environment-selection.json` 中不暴露原值的 `testDataSha256`，用于确认两个宿主拿到的是同一批业务运行值；Profile 登录用户名/密码不计入该摘要，凭据轮换不会改变原测试输入合同；
- 每个 case 引用的实际证据和 `agent-workspace/evidence/` 文件；
- `.agent-private/mutation-ledger.json` 的 terminal/pending 状态；
- `原文件名-Auto-Test-结果.xlsx` 的逐来源行回写；
- `agent-host-selection.json` 中记录的平台、宿主和包/可执行文件。

Provider 探针通过只证明宿主启动层；不能替代真实页面执行。一个 canary 的 `passed` 只能证明该平台、该宿主、该 commit/包版本和该输入包的结果，不能推出任意网站或任意 OMP/Codex 版本都一次成功。

## Control MCP 能力预检

真实 AgentHost 在每个物理执行线程的第一轮业务提示前，会先发送一次只读能力预检。Core 必须在归一化事件流中观察到恰好一次已完成的 `auto-test-control.test_contract` `tool_completed` 事件，且不能出现其他工具、shell 命令或文件改动事件，才会发送浏览器探索和业务执行提示；模型的文字声称、`list_mcp_resources` 结果、Provider 探针通过或宿主静态 `mcp: true` 能力声明都不算预检通过。未满足该合同时，Run 会直接生成 `blocked` 的 `infrastructure` 结果，并说明 Provider/AgentHost 没有正确提供 Control MCP 工具。

这条预检只验证工具通道和不可变契约，不解释业务语义、规划步骤或裁决结果。受管 Codex Profile 已把 namespace 工具转换为标准 function；若预检仍失败，应分别检查本地 MCP 启动、Provider 的标准 function/SSE/工具结果协议和模型是否实际发起工具调用。旧包在没有预检时通过 shell 或临时脚本得到的 `passed` 不能证明 Control MCP 通道可用。修复基础设施后，应在同一输入和环境下重新执行；未发生业务写入的预检阻断可以从原目录恢复。

Core 读取 `.agent-private/mutation-ledger.json` 时会运行时验证其必须是合法数组且每个条目符合 Ledger 合同。Agent 或辅助脚本把该文件覆盖为对象、坏 JSON 或不完整条目时，结果会 fail closed 为 `agent_execution` blocked，并保留明确的制品违规原因；不会再因 `.some()` 等类型错误丢失权威结果文件。只有 Control MCP 登记的 Ledger 才是业务写入事实源。

## 同合同比较

先用同一 Excel、sidecar、URL、Environment Profile 和 `--case-limit` 分别执行两个独立 Run：

```bash
npm run agent:test -- --file cases.xlsx --url https://app.example.test/ --profile staging --agent-host codex --output-dir artifacts/runs/codex-fixture
npm run agent:test -- --file cases.xlsx --url https://app.example.test/ --profile staging --agent-host omp --omp-bin /path/to/omp --output-dir artifacts/runs/omp-fixture
npm run agent:compare -- --run artifacts/runs/codex-fixture --run artifacts/runs/omp-fixture --output artifacts/runs/agent-competition.json
```

`agent:compare` 是确定性只读工具：它会从每个 run 的 `agent-workspace/test-manifest.json` 读取 immutable 合同，并校验 workflow/source 身份、逐 case 覆盖、终态 Mutation Ledger、证据和回执，然后列出差异。缺少该 Manifest、宿主重复或包/平台不一致都会使合同无效。没有经过独立验证的 fixture oracle 时，结果只能是 `equivalent`、`different` 或 `undetermined`，不会因为某个宿主返回了 `passed` 就自动宣布它更正确。合成 fixture 可以提供一个包含同一 `workflowId`、`sourceSha256` 和逐 case `outcome/failureSource` 的 oracle，再用 `--oracle expected.json` 计算可复现的 winner；未绑定 immutable input 的 oracle 会使比较合同无效。
