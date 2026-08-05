# AgentHost：宿主无关执行

Auto-Test 的测试核心不再依赖某一个代理产品。`AgentHost` 是一条窄的运行时契约：宿主负责启动或恢复自己的会话、发送文本/图片输入、流式返回事件；Auto-Test Core 负责 Excel 与 sidecar 身份、环境权限、浏览器与 MCP 配置、证据、Mutation Ledger、逐 case 回执和最终结果合同。

## 可用宿主

| 宿主 | 选择值 | 传输 | 结构化输出 | 会话恢复 | Provider 配置 |
| --- | --- | --- | --- | --- | --- |
| Codex CLI | `codex`（默认） | Codex SDK/CLI thread | 原生支持 | 支持 | Auto-Test Model Profile 或隔离 Codex Home |
| oh-my-pi | `omp` | OMP RPC JSONL (`omp --mode rpc`) | 由同一最终 JSON 提示和 Core 校验 | RPC session 文件 | OMP provider 配置的受控副本或环境变量 |

宿主能力记录还包含 `workspaceIsolation`：Codex 为 `enforced`，OMP 为 `prompt_only`。这不会改变两者的业务结果合同，但会在审计和竞争报告中保留真实执行边界。

两者收到相同的原始 Excel、同名 `.auto-test` sidecar、图片、环境上下文、run 工作区和测试提示。Core 不读取页面业务语义，也不生成第二个 Planner 或 Reporter。OMP 不支持 Codex 的 `outputSchema` 参数时，仍必须返回同一 `codex-agent.result.json` 合同；Core 会用相同的 schema、case 覆盖、证据、环境需求和 Ledger 校验。

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
  --omp-bin /path/to/omp
```

也可以设置 `AUTO_TEST_AGENT_HOST=omp` 和 `AUTO_TEST_OMP_BIN`。`--omp-home` 或 `AUTO_TEST_OMP_HOME` 可指定 OMP 的 agent 配置目录；Core 只复制 `config/models`、当前 `agent.db` auth store（含存在的 SQLite sidecar）、旧版 `auth.json`、`.env` 和 `settings.json` 这些 provider/auth 文件到私有 run 目录，不复制用户 MCP、插件或历史 session。首次运行省略 `--omp-home` 时读取默认 OMP agent 目录；恢复时若没有显式提供新的 `--omp-home`，会保留原 run 已复制的 Provider 文件，不会被当前用户目录静默覆盖。复制前应关闭正在写同一 auth store 的 OMP 进程，或改用显式 Provider 环境变量，避免复制活跃 SQLite 文件。`--agent-bin` 是当前宿主的通用可执行文件覆盖；`--codex-bin` 仍是兼容参数。一次 Run 选定的宿主会写入 `agent-host-selection.json` 和状态文件，`--resume` 不允许静默更换宿主；省略恢复命令中的宿主时会从原状态自动复用。

Codex 的隔离 Home 会保留所选 Provider 的模型、推理强度、`model_context_window`、service tier 和 Provider 连接段，但不会复制用户 MCP 或其他项目配置。自定义模型必须在源 Codex 配置中声明真实上下文窗口，避免长套件按错误的兜底容量运行。

## OMP 前置条件

Auto-Test 不把 OMP 二进制或 OMP Provider 凭据复制进仓库或私有包。使用 OMP 前请在测试机安装 `omp`，完成 OMP 自身的模型登录/Provider 配置，并确认 `omp --version` 能运行。运行时会把 provider 配置复制到私有 `agentHome`，并设置 `PI_CODING_AGENT_DIR` 与隔离 session 目录；不会继承调用者的 OMP profile、用户 MCP、插件或历史 session。Auto-Test 会在每个 run 工作区生成 `.omp/mcp.json`，其中只包含本次 Playwright 和 `auto-test-control` MCP 的隔离命令与路径；不会复用用户的 Codex MCP 配置。

OMP 启动时会在 run 工作区写入一个项目级 `.omp/config.yml`：关闭 OMP 自带 browser、memory/autolearn 和用户扩展，并强制启用项目 MCP。这样 OMP 与 Codex 都通过同一份 run-scoped Playwright/Control MCP 操作浏览器；OMP 自带 browser 不会悄悄替换 Playwright 会话。`shell`、网络和高风险业务操作仍受测试环境 Profile、run 工作区约定和 Mutation Ledger 约束。`--auto-approve` 只表示已授权的测试动作不被宿主交互提示卡住，不扩大目标 URL 或业务权限。

OMP 当前没有 Codex SDK 同等级的操作系统 workspace sandbox；“只写 run 工作区”主要由提示、项目配置和审计合同约束。需要真实业务验收时，应使用专用测试机/账号，并把该差异保留在 `agent-host-selection.json` 与验收记录中；这也是 OMP 不能冒充 `--opaque-test-data` 的原因。

默认 direct 模式会向宿主提供运行所需的最小系统环境变量。若 OMP Provider 只支持环境变量认证，可在启动 Auto-Test 前设置 `AUTO_TEST_AGENT_FORWARD_ENV=OMP_API_KEY,OTHER_PROVIDER_KEY`；只有列出的变量会进入隔离宿主进程，且不会进入 Playwright/Control MCP 子进程。当前 OMP 适配器不宣称支持 `--opaque-test-data` 的受限工具模式，使用该模式会明确阻断，不会假装已经隔离。

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

## 同合同比较

先用同一 Excel、sidecar、URL、Environment Profile 和 `--case-limit` 分别执行两个独立 Run：

```bash
npm run agent:test -- --file cases.xlsx --url https://app.example.test/ --profile staging --agent-host codex --output-dir artifacts/runs/codex-fixture
npm run agent:test -- --file cases.xlsx --url https://app.example.test/ --profile staging --agent-host omp --omp-bin /path/to/omp --output-dir artifacts/runs/omp-fixture
npm run agent:compare -- --run artifacts/runs/codex-fixture --run artifacts/runs/omp-fixture --output artifacts/runs/agent-competition.json
```

`agent:compare` 是确定性只读工具：它会从每个 run 的 `agent-workspace/test-manifest.json` 读取 immutable 合同，并校验 workflow/source 身份、逐 case 覆盖、终态 Mutation Ledger、证据和回执，然后列出差异。缺少该 Manifest、宿主重复或包/平台不一致都会使合同无效。没有经过独立验证的 fixture oracle 时，结果只能是 `equivalent`、`different` 或 `undetermined`，不会因为某个宿主返回了 `passed` 就自动宣布它更正确。合成 fixture 可以提供一个包含同一 `workflowId`、`sourceSha256` 和逐 case `outcome/failureSource` 的 oracle，再用 `--oracle expected.json` 计算可复现的 winner；未绑定 immutable input 的 oracle 会使比较合同无效。
