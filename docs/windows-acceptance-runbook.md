# Windows 从零验收清单

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

继续验收前，应确认 Node.js、Codex CLI、模型 Provider/API 和 Chromium 均显示成功。若当前 Provider Key 额度不足且 Windows 用户的 Codex CLI `auth.json` 存在备用 `OPENAI_API_KEY`，启动器会明确显示切换并再次探测；没有出现成功探测前不要直接开始业务测试。初始化失败时先解决环境问题，不要直接开始业务测试。

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

运行期间不要手工操作同一批测试实体，不要关闭启动窗口或自动打开的浏览器。框架会自主理解 Excel 和图片、探索页面、维护动态计划、执行操作、验证结果并恢复业务状态；不需要人工编写 Execution Plan。

启动后应立即看到带时间的阶段进度；执行期间会显示读取页面、浏览器动作、动态计划、证据和业务写入清理等安全摘要。模型正在思考、等待页面或自动重连而暂时没有新动作时，窗口每约 20 秒输出一次“框架仍在运行”心跳。进度不会显示密码、验证码、Cookie、表单值、工具参数或模型推理正文。如果窗口给出明确的 `blocked` 或失败结果，应按结果中的原因处理；不要仅因某个页面步骤耗时较长就关闭窗口。

终端进度只用于判断框架是否仍在运行，不能作为验收通过证据。

## 5. 判断验收是否真正通过

启动窗口显示“测试通过”后，仍应核对结构化产物：

```powershell
$Result = Get-Content "$Run\codex-agent.result.json" -Raw | ConvertFrom-Json
$Plan = Get-Content "$Run\agent-workspace\execution-plan.json" -Raw | ConvertFrom-Json
$Ledger = Get-Content "$Run\.agent-private\mutation-ledger.json" -Raw | ConvertFrom-Json

$Result.outcome
$Result.cases | Format-Table caseId, outcome
$Plan.steps | Where-Object status -ne "passed" | Format-Table id, status
$Ledger | Where-Object status -eq "pending" | Format-Table id, caseId, status
```

只有同时满足以下条件，才算该 run 通过：

- `codex-agent.result.json` 的 `outcome` 为 `passed`；
- 每个测试用例均为 `passed`，且有对应业务证据；
- 动态计划没有 `pending`、`in_progress`、`failed` 或 `blocked` 步骤；
- Mutation Ledger 没有 `pending` 条目；
- 测试材料要求的最终业务状态已验证，例如零活动订单、测试数据已删除、设备或连接器已恢复。

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

恢复会继续使用原 Codex thread、动态计划、证据和 Mutation Ledger，并先重新观察未完成业务写入的真实状态。不要删除原输出目录或 Ledger，不要改用新输出目录盲目重跑，也不要手工把 `blocked` 改成 `passed`。

`product_failed` 表示已确认产品结果不符合预期，应修复产品或调整测试数据后重新验收；它不是基础设施恢复入口。

## 7. 验收交付

至少保留以下文件用于复核：

- `codex-agent.state.json`
- `codex-agent.result.json`
- `codex-agent.events.jsonl`
- `agent-workspace\execution-plan.json`
- `agent-workspace\evidence-index.json`
- `agent-workspace\evidence\`

`.agent-private` 用于本机恢复和审计，不应外发。页面证据也可能包含业务数据，离开测试团队前必须先检查和脱敏。

更详细的安装、私有 Provider、安全边界和命令说明见 [Windows 快速操作指南](windows-quick-start.md)。
