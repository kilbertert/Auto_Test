# Windows 从零验收清单

本清单从“已经拿到私有 ZIP”开始。如何从 Linux/WSL 生成 ZIP，统一见[Windows 私有包快速打包](windows-package-quick-start.md)。

这份清单用于在一台 Windows 测试机上，从全新解压目录开始，验证 Auto-Test 能否仅凭测试用例、目标 URL 和一次环境注册自主完成真实测试。

日常操作可以使用中文菜单；菜单默认把 Run 保存在 `%LOCALAPPDATA%\auto-test\runs`，不会随 ZIP 解压目录、移动盘或映射盘失联。正式验收建议使用显式命令和本机固定输出目录，便于中断恢复和结果复核。

## AgentHost 宿主选择边界

当前默认宿主是 Codex。PR #28 后的 Linux x64 验收已证明 Codex 与 OMP 能以同一 Manifest 分别完成一次真实写入型充电 canary，并共享结果、证据、回执和 Mutation Ledger 合同；它不能替代 Windows 平台的业务复验。Windows 私有包自动安装 Codex；OMP 二进制需要在测试机单独安装，但可以消费同一个私有包默认 Provider 或显式 Model Profile，且其 workspace isolation 仍是 `prompt_only`。Provider 探针和安装检查只证明启动层，必须以 Windows 实际 Manifest、逐 case 证据、结果工作簿和 `pending=0` 的 Ledger 才能声明业务通过。

## 快速回归脚本

探索成功后可将同一运行的 MCP 轨迹编译为确定性 spec，再使用 `playwright test` 回归。编译器只使用 `passed` case 和标准 Playwright code，不从脱敏事件恢复密码；无法确定性翻译的调用会使编译失败。

## 1. 验收前准备

- 使用当前版本的内部私有 Windows ZIP，解压到本机短路径，例如 `D:\Auto-Test`；不要直接在 ZIP、OneDrive、共享盘或 `Program Files` 中运行。显式 `--output-dir` 也应放在运行期间持续在线的本机卷。
- 将测试用例 Excel 和同名 `.auto-test` 补充材料放在本机目录，例如 `D:\TestData`。Excel 内嵌图片无需单独导出。
- 确认目标是已授权的测试环境。会创建订单、启动设备、结算或删除数据时，必须准备可安全清理的测试数据和相应权限。
- 关闭正在编辑该 Excel 的程序，保持电脑联网并关闭自动睡眠。同一个测试环境和测试数据不要同时启动两个 Auto-Test run。
- 私有 ZIP 含一次性模型引导凭据。完成解压和安装后，不要把 ZIP、`.agent-private`、运行制品、环境 Profile 或 `%APPDATA%\auto-test` / `%LOCALAPPDATA%\auto-test` 上传到聊天、网盘或代码仓库。

## 2. 初始化并检查环境

首次使用可以直接双击 `Auto-Test.cmd`，也可以打开 PowerShell 执行：

```powershell
Set-Location "D:\Auto-Test"
.\Auto-Test.cmd --setup-only
.\Auto-Test.cmd doctor
```

继续验收前，应确认 Node.js、Chromium 和所选 AgentHost 的启动层均可用。Codex 使用 Windows 默认 Provider 时必须通过启动器探针；显式 Model Profile 不运行无关的默认探针，而由实际 Codex canary 验证。OMP 路径至少通过 `omp --version`，然后由 OMP 适配器使用同一个 Model Profile 生成隔离 `models.yml` 并在真实 canary 中验证 Provider。只有 legacy/native Run 才需要 `--agent-home` 或 `AUTO_TEST_AGENT_HOME` 提供宿主 provider/auth 源目录；省略时 Codex 可回退到 `%USERPROFILE%\.codex`，并保留当前 Provider 的 header 子表。子表引用的额外环境变量必须通过 `AUTO_TEST_AGENT_FORWARD_ENV` 显式列出。`--omp-home` / `AUTO_TEST_OMP_HOME` 是兼容别名。实际运行只复制允许的配置文件和当前 `agent.db` auth store 到私有 run，不应把用户 MCP、插件或历史 session 当作验收前置；复制前关闭正在写该 auth store 的 OMP 进程。启动层检查失败时先解决宿主问题，不要直接开始业务测试。

每个 Codex Run 都会关闭 Apps、插件和远程插件目录，避免隔离 Agent Home 在测试启动时同步 marketplace；测试工具只来自 Auto-Test 注入的 Playwright 和 Control MCP。

Linux/macOS 的 Codex 运行时只会把本次 Run 的 `.agent-private` 作为 sandbox 的额外可写目录，以便 Control MCP 登记权威 Ledger。Windows Codex CLI 0.146.0 在 `workspace-write` 下无法启动子 MCP 或可写 shell，因此 Auto-Test direct 模式会由 AgentHost 自动切换到 `danger-full-access`；这是宿主平台限制的通用兼容处理，不是针对某个业务的放权。Windows 这条路径不具备 Codex 的操作系统级 workspace sandbox，`agent-host-selection.json` 必须显示 `workspaceIsolation: prompt_only`。Auto-Test 仍保留 run 工作区、允许 origin、风险策略、Control MCP、Mutation Ledger 和结果合同边界；只在专用测试账号/测试机运行，且不要把该能力等同于可写仓库或用户目录的安全隔离。选择 OMP 时，Windows 启动器不会显示 Codex 专用 Provider 探针结果；`omp --version` 只能证明 OMP 可启动，Model Profile 的环境变量、协议和模型能力仍要由真实 AgentHost canary 验证。

Windows 默认 Provider 的模型 API 探针最多等待 120 秒，并在长时间等待时输出心跳。stdout/stderr 使用本次探针的临时文件捕获，后台继承句柄不会让已退出的主进程继续占用启动窗口；只有 Codex/API 调用本身未结束才会触发超时、恢复上一版 Provider 配置并明确报错。stdout+stderr 总量超过 4 MiB 同样会终止进程树、回滚配置并清理捕获文件。这不是业务测试结果。OMP 和显式 Model Profile 不运行该 Codex 默认探针，而是在 AgentHost 运行前准备自己的 Provider 绑定；两者都必须用真实 canary 验证协议、鉴权和模型能力。只有已经确认网关健康但首个响应确实较慢时，才为单次诊断临时设置 `AUTO_TEST_CODEX_PROBE_TIMEOUT_SECONDS`（1 到 3600），不要用它掩盖额度、限流、网络或流式响应故障。

启动层通过后，真实 AgentHost 还必须在第一个业务执行提示前完成只读 Control MCP 预检。受管 Codex Model Profile 会自动通过本机 loopback 桥把 namespace MCP 工具转换为 Provider 标准 function tools。验收时从 `codex-agent.events.jsonl` 精确确认恰好一次 `server=auto-test-control`、`tool=test_contract` 且 `status=completed` 的事件，并且该预检回合没有其他工具、shell 命令或文件改动事件；否则不能宣称业务通过，框架应生成 `blocked` 且 `failureSource=infrastructure` 的结构化结果。若仍提示工具不可用，依次检查本地 MCP 是否启动、Provider 是否支持标准 Responses function/SSE/工具结果续传、模型是否实际调用工具；不要用旧包绕过预检后的 `passed` 代替这项验收。该门只确认 MCP 工具通道可用，不替代页面执行、业务断言或 Ledger 验收。

如果默认 Key 额度不足，但另一个 Key 使用同一个 Provider Base URL，可在本次验收命令中临时指定：

```powershell
.\Auto-Test.cmd run `
  --file $Cases `
  --url "https://app.example.test/" `
  --profile $Profile `
  --output-dir $Run `
  --api-key "<temporary-api-key>" `
  --headed `
  --one
```

该参数只作用于当前 Windows 默认 Provider，不会替换默认 Key；不要把真实 Key 提交到脚本或测试材料。`--api-key` 和 `--reconfigure-api` 都不能与 `--model-profile` 同时使用，显式 Profile 应通过自己的 `envKey` 提供凭据。需要永久重配默认 Provider 时，使用 `--reconfigure-api`，不要与 `--api-key` 同时使用。

新 Run 默认使用 AgentHost 通用的内置 `deepseek`。默认 Windows Provider 正好配置为 `deepseek-v4-flash @ https://api.deepseek.com` 时，启动器会把本轮 DPAPI Key 仅在进程内映射为 `DEEPSEEK_API_KEY`；其他 endpoint/model 会成为本进程的 `windows-private` 默认 Profile。两种默认都可供 Codex 或 OMP 使用。验收 `volcengine` 时提供 `ARK_API_KEY` 并显式加入 `--model-profile volcengine`，Codex 与 OMP 都会使用同一 Profile，分别生成自己的隔离配置。Windows 启动器不会自动把第二个供应商的 Key 导入 DPAPI；Profile 注册表和环境变量都属于当前测试机的私有配置，不得进入 ZIP、仓库或验收记录。Provider/模型探针和一条真实只读 canary 都通过后，才能扩大范围。

## 3. 一次性注册测试环境

双击 `Auto-Test.cmd`，选择“注册或更新测试环境”：

1. 一次填写本场景明确作为测试环境入口、需要登录或授权的前台和后台 URL；不要仅因 Excel 含教程、连通性参照或外部资料链接就把它注册为业务环境。
2. 设置稳定、易识别的环境名称，例如 `acceptance-test`。
3. 登录状态默认选“否”。只有本套用例已明确以登录后页面为前置、且不验证登录/登出/会话时，才选“是”并在浏览器中捕获可选会话种子。
4. 选择允许的最高风险。只读场景选“只读”，普通表单写入选“写入”，需要停止、删除或结算时才选“清理”。
5. 回到启动窗口确认注册完成。

环境 Profile 只需注册一次。认证用例应由 AgentHost 按 Excel 真实建立初始状态、操作并断言，不把人工预登录当作验收前置。已保存会话失效、URL 范围变化或权限变化时，使用同一菜单更新；不要手工编辑 Profile JSON、Cookie 或 `storageState`。命令行只在需要这种会话种子时显式加 `--capture-login`。

## 4. 执行一条真实 canary

菜单中的“开始一次新测试”适合日常使用。正式验收建议在 PowerShell 中明确记录输入和输出目录：

```powershell
Set-Location "D:\Auto-Test"

$Cases = "D:\TestData\cases.xlsx"
$Profile = "acceptance-test"
$Run = "D:\Auto-Test-results\acceptance-$(Get-Date -Format yyyyMMdd-HHmmss)"

.\Auto-Test.cmd run `
  --file $Cases `
  --url "https://app.example.test/" `
  --url "https://admin.example.test/" `
  --profile $Profile `
  --output-dir $Run `
  --headed `
  --slow-mo 150 `
  --one
```

将示例 URL 替换为本次被测环境的实际入口。Excel 中的其他链接会保留给 Agent 判断，不会自动成为预执行环境门禁。`--one` 先执行一条 case 做安全 canary；确认清理和断言可靠后，再按测试范围执行更多 case。

运行期间不要手工操作同一批测试实体，不要关闭启动窗口或自动打开的浏览器。选定的 AgentHost 会直接读取原始 Excel 和图片，并可使用 shell、临时脚本和完整 Playwright 自主探索、执行、验证结果并恢复业务状态；不需要人工编写 Execution Plan。

默认运行由 Runner 按模型容量自动规划 execution epoch，并显示 `epoch X/Y` 和累计完成情况。每个 epoch 只包含有界 case 集；完成后写入逐 case store，必要时写 checkpoint 并启动下一代 AgentHost thread。这只影响上下文容量和恢复方式，不改变用例、权限或业务预期。工程师不需要计算或传入切分大小。

启动后应立即看到带时间的阶段进度；执行期间会显示当前 `AgentHost`、epoch/thread generation，以及读取页面、点击/填写/选择控件、测试辅助脚本、工作区更新、证据和业务写入清理等安全动作回执。每个动作带序号和开始、完成或失败状态；完成和失败会带耗时，重复的同一回执不会刷屏。窗口每约 20 秒输出一次“框架仍在运行”心跳：存在活动动作时显示“当前动作”和该动作持续时间；推理、重连或其他没有活动工具的阶段显示“最近动作”、框架总运行时长和恢复状态。进度不会显示命令正文、密码、验证码、Cookie、表单值、工具参数或模型推理正文；完整脱敏事件在 `$Run\codex-agent.events.jsonl` 中供审计。如果窗口给出明确的 `blocked` 或失败结果，应按结果中的原因处理；不要仅因某个页面步骤耗时较长就关闭窗口。

非通过终态会紧接着显示失败位置、原因类别、直接原因、需要补充的环境、运行中断事件（如有）、建议操作、已完成用例数、Mutation Ledger 终态和证据路径。原因类别必须是产品缺陷、代理执行失败、输入资料问题、环境阻断或基础设施故障之一。直接原因来自逐 case 业务事实；Provider 额度/限流、AgentHost、浏览器、MCP 或网络问题记录在 `codex-agent.state.json.runInterruption`，作为独立的运行事件展示，不能覆盖环境、产品或输入根因。详细技术事件仍只在脱敏诊断文件中，不会把命令、表单值或模型推理输出到摘要。

终端进度只用于判断框架是否仍在运行，不能作为验收通过证据。

如果结果包含环境需求，先查看：

```powershell
Get-Content "$Run\.agent-private\environment-requirements.json" -Raw | ConvertFrom-Json
```

每条记录都应包含 `caseIds`、`kind`、`condition` 和已保存的 `evidence`。先确认页面可用的只读操作已经执行：可筛选、搜索、改日期范围、翻页、刷新或查看详情时，不应直接把结果报成环境问题。`origin` 类记录完成一次环境注册或更新后，其他类型在补足权限、认证、测试数据或物理条件后，都必须复用相同的 Excel、Profile 和 `$Run`，增加 `--resume` 继续。恢复中的 AgentHost 会重新观察并以新证据标记已满足的需求；不要改用新目录绕过环境边界。

共享环境需求在审计后可能只继续阻断其中一部分 case。最终交付会保留 requirement ID 和仍受阻的 case，只解除已被同一 AgentHost 证据重新归类为产品、输入或代理执行问题的 case。已被更精确 requirement 完全替代的旧记录标记为 `superseded`，保留审计历史但不再阻断运行；它不会被误标为条件已经满足。

执行 `--resume` 时，窗口可能直接提示已有逐 case 交付通过确定性校验。这表示框架已核对输入身份、case 完整性、证据、环境需求和实际 Ledger，因而无需重新启动浏览器或 AgentHost；它不是跳过业务执行，而是在已有逐 case 事实后避免重复操作。如果任一项不完整或仍有 pending Mutation，框架恢复 active epoch 的宿主 thread；若容量轮换尚未启动下一 epoch，则使用 checkpoint 启动新的物理 thread。

长用例集恢复时查看 `codex-agent.state.json` 的 `completedCaseIds`、`threadGeneration`、`activeEpoch` 和 `checkpointPath`。`.agent-private\case-results\` 是逐 case 恢复事实源，`.agent-private\execution-epochs\` 保存每个 epoch 的有界交付；已完成 case 不应被重写或重跑。若恢复后重复执行已完成 case，或者把一个 epoch 的回执填充到另一个 epoch，应判定调度验收失败。

## 5. 判断验收是否真正通过

启动窗口显示“测试通过”后，仍应核对结构化产物：

```powershell
$Result = Get-Content "$Run\codex-agent.result.json" -Raw | ConvertFrom-Json
$Ledger = Get-Content "$Run\.agent-private\mutation-ledger.json" -Raw | ConvertFrom-Json

$Result.outcome
$Result.cases | Format-Table caseId, outcome, summary
$Result.cases | ForEach-Object { $_.evidence }
$Ledger | Where-Object status -eq "pending" | Format-Table id, caseId, status
Get-ChildItem "$Run\*-Auto-Test-结果.xlsx" | Select-Object FullName
```

结果目录中的 `原文件名-Auto-Test-结果.xlsx` 是交付给测试工程师复核的工作簿副本。它逐来源行写入状态、失败归类、摘要、证据索引和环境需求；原始 `$Cases` 不会被框架修改。框架只在工作簿原子提交、重新读取且 XLSX 结构校验通过后显示其路径；若显示“结果文件生成失败”，即使业务 outcome 已产生也不能宣称 Excel 已交付。结构化 JSON 仍是权威证据索引，Excel 是对同一结果的确定性回写，不会另行判断业务结论。

只有同时满足以下条件，才算该 run 通过：

- `codex-agent.result.json` 的 `outcome` 为 `passed`；
- 每个测试用例均为 `passed`，且有对应业务证据；
- Mutation Ledger 没有 `pending` 条目；
- 测试材料要求的最终业务状态已验证，例如零活动订单、测试数据已删除、设备或连接器已恢复。

另外，`.agent-private\mutation-ledger.json` 必须是 Core 校验通过的合法数组；若 Agent/脚本覆盖了 Ledger 形状，结果必须是 `blocked / agent_execution`，即使页面看起来已完成也不能算通过。

`execution-plan.json`、`field-compositions.json`、Control MCP evidence checkpoint 或 AgentHost 生成的临时脚本可以存在，也可以不存在；它们不能替代最终业务证据，也不是通过条件。

一次页面点击成功、浏览器没有报错或部分步骤执行完成，都不能替代这些终态条件。

## 6. 中断后从原 run 恢复

如果电脑睡眠、网络断开、模型限流、浏览器或 MCP 中断，先恢复外部条件，然后复用完全相同的 Excel、URL、Profile 和 `$Run`，只增加 `--resume`：

```powershell
.\Auto-Test.cmd run `
  --file $Cases `
  --url "https://app.example.test/" `
  --url "https://admin.example.test/" `
  --profile $Profile `
  --output-dir $Run `
  --resume `
  --headed
```

恢复会继续使用原始材料副本、Agent 工作区文件、证据和 Mutation Ledger，并先重新观察 active epoch 未完成业务写入的真实状态。若浏览器执行已结束、但最终 JSON 响应在传输中断，框架只能在对应 epoch artifact 或全量 `agent-workspace\case-results.json` 通过身份、case 覆盖、证据路径和 Ledger 终态校验后采用结果，不能从日志或页面猜测。Excel、URL、Environment Profile 和风险策略必须保持不变；模型 Profile 可以在额度、容量或 Provider 故障后显式切换。旧版 v1 状态不支持恢复。不要删除原输出目录或 Ledger，不要改用新输出目录盲目重跑，也不要手工把 `blocked` 改成 `passed`。

模型 Profile 变化时，`codex-agent.state.json` 中的无密钥绑定指纹用于判断旧物理 session 是否还能恢复。绑定不同时，Runner 保留同一个逻辑 Run、active epoch、工作区和 Ledger，启动下一代 thread，并在继续执行前发送 resume prompt 核对 pending Mutation。早期 v2 状态没有指纹时，仅在宿主明确返回 session 不兼容后执行一次轮换；普通业务或代理执行错误不得触发轮换，第二次不兼容必须以基础设施阻断结束。

`product_failed` 表示已确认产品结果不符合预期，应修复产品或调整测试数据后重新验收；它不是基础设施恢复入口。即使本轮还有其他用例 `blocked`，终端摘要仍会保留已确认产品差异，并按输入材料、环境/权限/测试数据、基础设施和 AgentHost 执行交付分别显示阻断数量与首个直接原因。若环境需求已经由同一 case 的页面证据记录，后续 Provider 中断不会把该 case 改成基础设施失败；只有没有逐 case 事实的剩余 case 才使用运行中断分类。

对于其他原因：

- 代理执行失败：优先恢复同一 AgentHost thread，不要重复已验证的业务写入；
- 输入资料问题：修正 Excel 与同名 sidecar 输入包后开始新 run，不要修改原 run 的 source hash；
- 环境阻断：补充同一 Profile 的登录、权限、测试数据或物理条件后使用 `--resume`；
- 基础设施故障：恢复所选 AgentHost、Provider、Chromium、MCP 或本地网络后使用原 `$Run` 恢复；不要在恢复时静默切换宿主。

任何非通过结果如果显示 Mutation Ledger 仍有 `pending`，都必须先恢复原 run 并核对真实业务状态，不得直接新建运行重做写入。恢复时若不需要更换 native Provider，省略 `--agent-home` 以复用原 run 的隔离配置；不要让当前用户目录意外改变原测试宿主的模型或认证。

## 7. 验收交付

至少保留以下文件用于复核：

- `codex-agent.state.json`
- `codex-agent.result.json`
- `codex-agent.events.jsonl`
- `agent-workspace\execution-receipts.json`
- 运行期间 `execution_receipts` 查询默认返回当前 Run 的紧凑回执摘要；必要时按 active epoch 收窄。上述文件保留完整回执供确定性校验和审计。新回执 ID 应带 epoch 命名空间和 turn 序号，不应在 thread 轮换或恢复后退回裸 `item_*`。
- `agent-workspace\case-results.json`（如存在）
- `agent-workspace\input\input-index.json`
- `agent-workspace\evidence\`
- `原文件名-Auto-Test-结果.xlsx`
- AgentHost 在 `agent-workspace\` 中生成并由最终结果引用的辅助脚本或记录
- `.agent-private\environment-requirements.json`（如存在）

`.agent-private` 用于本机恢复和审计，不应外发。页面证据也可能包含业务数据，离开测试团队前必须先检查和脱敏。

生成文本会在每个 AgentHost turn 后自动清洗本轮 secret、Authorization、Cookie、Bearer、API key，以及页面或网络响应中动态产生的 `access_token`、`refresh_token` 和 JWT；结构化 JSON/JSONL 清洗后仍保持可解析，大 JSONL 按行流式处理。OMP 的累计消息和工具增量帧不会写入事件日志，完整消息、工具终态和错误仍须存在。immutable `test-manifest.json`、原始输入目录和 `.agent-private` 不会被清洗器改写，前两者分别保留竞争合同和来源证据，后者仍然是本机私有恢复材料。截图、PDF 等二进制证据不做自动 OCR 或像素擦除，外发前必须人工检查。验收门禁应至少确认 `agent-workspace` 的生成文本没有精确 secret、JWT 或已知动态凭据命中，再结合人工检查二进制证据。

更详细的安装、私有 Provider、安全边界和命令说明见 [Windows 快速操作指南](windows-quick-start.md)。
