# Windows 从零验收清单

本清单从“已经拿到私有 ZIP”开始。如何从 Linux/WSL 生成 ZIP，统一见[Windows 私有包快速打包](windows-package-quick-start.md)。

这份清单用于在一台 Windows 测试机上，从全新解压目录开始，验证 Auto-Test 能否仅凭测试用例、目标 URL 和一次环境注册自主完成真实测试。

日常操作可以使用中文菜单；正式验收建议使用显式命令和固定输出目录，便于中断恢复和结果复核。

## 1. 验收前准备

- 使用当前版本的内部私有 Windows ZIP，解压到本机短路径，例如 `D:\Auto-Test`；不要直接在 ZIP、OneDrive、共享盘或 `Program Files` 中运行。
- 将测试用例 Excel 和同名 `.auto-test` 补充材料放在本机目录，例如 `D:\TestData`。Excel 内嵌图片无需单独导出。
- 确认目标是已授权的测试环境。会创建订单、启动设备、结算或删除数据时，必须准备可安全清理的测试数据和相应权限。
- 关闭正在编辑该 Excel 的程序，保持电脑联网并关闭自动睡眠。同一个测试环境和测试数据不要同时启动两个 Auto-Test run。
- 私有 ZIP 含一次性模型引导凭据。完成解压和安装后，不要把 ZIP、`.agent-private`、环境 Profile 或 `%APPDATA%\auto-test` 上传到聊天、网盘或代码仓库。

## 2. 初始化并检查环境

首次使用可以直接双击 `Auto-Test.cmd`，也可以打开 PowerShell 执行：

```powershell
Set-Location "D:\Auto-Test"
.\Auto-Test.cmd --setup-only
.\Auto-Test.cmd doctor
```

继续验收前，应确认 Node.js、Codex CLI、模型 Provider/API 和 Chromium 均显示成功。初始化失败时先解决环境问题，不要直接开始业务测试。

模型 API 探针默认最多等待 120 秒，并在长时间等待时输出心跳。超过上限后启动器会终止卡住的 Codex 进程、恢复上一版 Provider 配置并明确报错；这不是业务测试结果。只有已经确认网关健康但首个响应确实较慢时，才为单次诊断临时设置 `AUTO_TEST_CODEX_PROBE_TIMEOUT_SECONDS`（1 到 3600），不要用它掩盖额度、限流、网络或流式响应故障。

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

该参数只作用于当前运行，不会替换默认 Key；不要把真实 Key 提交到脚本或测试材料。需要永久重配默认 Provider 时，使用 `--reconfigure-api`，不要与 `--api-key` 同时使用。

## 3. 一次性注册测试环境

双击 `Auto-Test.cmd`，选择“注册或更新测试环境”：

1. 一次填写本场景可能访问的全部前台、后台和辅助网站 URL。
2. 设置稳定、易识别的环境名称，例如 `acceptance-test`。
3. 按提示在浏览器中完成登录，确认每个网站都已进入业务页面。
4. 选择允许的最高风险。只读场景选“只读”，普通表单写入选“写入”，需要停止、删除或结算时才选“清理”。
5. 回到启动窗口确认注册完成。

环境 Profile 只需注册一次。登录失效、URL 范围变化或权限变化时，使用同一菜单更新；不要手工编辑 Profile JSON、Cookie 或 `storageState`。

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

将示例 URL 替换为测试材料需要访问的实际 URL。`--one` 先执行一条列表数据做安全 canary；确认清理和断言可靠后，再按测试范围执行更多数据。

运行期间不要手工操作同一批测试实体，不要关闭启动窗口或自动打开的浏览器。Codex 会直接读取原始 Excel 和图片，并可使用 shell、临时脚本和完整 Playwright 自主探索、执行、验证结果并恢复业务状态；不需要人工编写 Execution Plan。

默认运行由 Runner 按模型 Profile 容量自动规划 execution epoch，并显示 `epoch X/Y` 和累计完成情况。每个 epoch 只包含有界 case 集；完成后写入逐 case store，必要时写 checkpoint 并启动下一代 Codex thread。这只影响上下文容量和恢复方式，不改变用例、权限或业务预期。工程师不需要计算或传入切分大小。

启动后应立即看到带时间的阶段进度；执行期间会显示读取页面、浏览器动作、测试辅助脚本、工作区更新、证据和业务写入清理等摘要。模型正在思考、等待页面或自动重连而暂时没有新动作时，窗口每约 20 秒输出一次“框架仍在运行”心跳。进度不会显示命令正文、密码、验证码、Cookie、表单值、工具参数或模型推理正文。如果窗口给出明确的 `blocked` 或失败结果，应按结果中的原因处理；不要仅因某个页面步骤耗时较长就关闭窗口。

非通过终态会紧接着显示失败位置、原因类别、直接原因、建议操作、已完成用例数、Mutation Ledger 终态和证据路径。原因类别必须是产品缺陷、代理执行失败、输入资料问题、环境阻断或基础设施故障之一。详细技术事件仍只在脱敏诊断文件中，不会把命令、表单值或模型推理输出到摘要。

终端进度只用于判断框架是否仍在运行，不能作为验收通过证据。

如果结果包含环境需求，先查看：

```powershell
Get-Content "$Run\.agent-private\environment-requirements.json" -Raw | ConvertFrom-Json
```

每条记录都应包含 `caseIds`、`kind`、`condition` 和已保存的 `evidence`。先确认页面可用的只读操作已经执行：可筛选、搜索、改日期范围、翻页、刷新或查看详情时，不应直接把结果报成环境问题。`origin` 类记录完成一次环境注册或更新后，其他类型在补足权限、认证、测试数据或物理条件后，都必须复用相同的 Excel、Profile 和 `$Run`，增加 `--resume` 继续。恢复中的 Codex 会重新观察并以新证据标记已满足的需求；不要改用新目录绕过环境边界。

共享环境需求在审计后可能只继续阻断其中一部分 case。最终交付会保留 requirement ID 和仍受阻的 case，只解除已被同一 Codex 证据重新归类为产品、输入或代理执行问题的 case。已被更精确 requirement 完全替代的旧记录标记为 `superseded`，保留审计历史但不再阻断运行；它不会被误标为条件已经满足。

执行 `--resume` 时，窗口可能直接提示已有逐 case 交付通过确定性校验。这表示框架已核对输入身份、case 完整性、证据、环境需求和实际 Ledger，因而无需重新启动浏览器或 Codex；它不是跳过业务执行，而是在已有逐 case 事实后避免重复操作。如果任一项不完整或仍有 pending Mutation，框架恢复 active epoch 的 thread；若容量轮换尚未启动下一 epoch，则使用 checkpoint 启动新的物理 thread。

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

结果目录中的 `原文件名-Auto-Test-结果.xlsx` 是交付给测试工程师复核的工作簿副本。它逐来源行写入状态、失败归类、摘要、证据索引和环境需求；原始 `$Cases` 不会被框架修改。结构化 JSON 仍是权威证据索引，Excel 是对同一结果的确定性回写，不会另行判断业务结论。

只有同时满足以下条件，才算该 run 通过：

- `codex-agent.result.json` 的 `outcome` 为 `passed`；
- 每个测试用例均为 `passed`，且有对应业务证据；
- Mutation Ledger 没有 `pending` 条目；
- 测试材料要求的最终业务状态已验证，例如零活动订单、测试数据已删除、设备或连接器已恢复。

`execution-plan.json`、`field-compositions.json`、Control MCP evidence checkpoint 或 Codex 生成的临时脚本可以存在，也可以不存在；它们不能替代最终业务证据，也不是通过条件。

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

恢复会继续使用原始材料副本、Codex 工作区文件、证据和 Mutation Ledger，并先重新观察 active epoch 未完成业务写入的真实状态。若浏览器执行已结束、但最终 JSON 响应在传输中断，框架只能在对应 epoch artifact 或全量 `agent-workspace\case-results.json` 通过身份、case 覆盖、证据路径和 Ledger 终态校验后采用结果，不能从日志或页面猜测。Excel、URL、Profile 和风险策略必须保持不变；旧版 v1 状态不支持恢复。不要删除原输出目录或 Ledger，不要改用新输出目录盲目重跑，也不要手工把 `blocked` 改成 `passed`。

`product_failed` 表示已确认产品结果不符合预期，应修复产品或调整测试数据后重新验收；它不是基础设施恢复入口。即使本轮还有其他用例 `blocked`，终端摘要仍会保留已确认产品差异，并按输入材料、环境/权限/测试数据、基础设施和 Codex 执行交付分别显示阻断数量与首个直接原因。

对于其他原因：

- 代理执行失败：优先恢复同一 Codex thread，不要重复已验证的业务写入；
- 输入资料问题：修正 Excel 与同名 sidecar 输入包后开始新 run，不要修改原 run 的 source hash；
- 环境阻断：补充同一 Profile 的登录、权限、测试数据或物理条件后使用 `--resume`；
- 基础设施故障：恢复 Provider、Codex CLI、Chromium、MCP 或本地网络后使用原 `$Run` 恢复。

任何非通过结果如果显示 Mutation Ledger 仍有 `pending`，都必须先恢复原 run 并核对真实业务状态，不得直接新建运行重做写入。

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
- Codex 在 `agent-workspace\` 中生成并由最终结果引用的辅助脚本或记录
- `.agent-private\environment-requirements.json`（如存在）

`.agent-private` 用于本机恢复和审计，不应外发。页面证据也可能包含业务数据，离开测试团队前必须先检查和脱敏。

更详细的安装、私有 Provider、安全边界和命令说明见 [Windows 快速操作指南](windows-quick-start.md)。
