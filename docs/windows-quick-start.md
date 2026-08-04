# Windows 使用：双击即可开始

日常使用不需要编辑 JSON、不需要创建 `storageState`，也不需要记住长命令。

准备在新 Windows 目录中完整复现一次真实验收时，直接按 [Windows 从零验收清单](windows-acceptance-runbook.md) 操作；本文保留安装原理、私有 Provider 和高级命令细节。

需要从 Linux/WSL 重新生成私有 ZIP 时，只看[Windows 私有包快速打包](windows-package-quick-start.md)；本文不重复打包命令。

## 第一次使用

直接双击仓库根目录的 `Auto-Test.cmd`。

启动器会自动完成：

1. 从 Node.js 官方发布包安装 Auto-Test 私有的固定版本 Node.js 24，并校验官方 SHA-256；
2. 在 Auto-Test 私有工具目录安装与服务器一致的 Codex CLI 固定版本；
3. 从私有安装包读取模型 Provider 配置，或在公开源码首次使用时提示输入；
4. 发送一次最小模型请求，验证 API 地址、Key 和模型真实可用；
5. 安装项目依赖和 Chromium；
6. 打开中文操作菜单。

不需要执行 `codex login`，也不使用 ChatGPT 账号额度。

内部私有 Windows 包会携带一次性引导配置：

- API Base URL；
- 模型 ID；
- 私有 API Key：首次双击时自动导入当前 Windows 用户的 DPAPI，然后删除解压目录中的明文引导文件。

因此测试工程师不需要填写任何模型信息。Windows 会直接调用上述 API，不需要连接或暴露 Auto-Test 服务器，也不要求安装 CLIProxyAPI。安装器使用通用的直接 API Provider：

```toml
model = "your-model-id"
model_provider = "auto_test_api"

[model_providers.auto_test_api]
name = "Auto-Test Model API"
base_url = "https://model-api.example.test/v1"
wire_api = "responses"
env_key = "AUTO_TEST_MODEL_API_KEY"
requires_openai_auth = false
```

Node.js 和 Codex CLI 都安装在 `%APPDATA%\auto-test\tools`，Codex 配置保存在 `%APPDATA%\auto-test\codex-home`。整个过程不需要管理员权限，不会安装或覆盖电脑上的全局 Node/Codex，也不会修改已有的 `%USERPROFILE%\.codex`。API Key 使用 Windows DPAPI 加密保存，仅当前 Windows 用户能够解密；启动时只加载到 Auto-Test 当前进程的 `AUTO_TEST_MODEL_API_KEY`，不会写入仓库、TOML 或明文用户环境变量。

旧版本如果检测到 `cliproxyapi` 配置，会自动改用上述直连接入。新配置通过真实 API 探针后才会替换旧配置；验证失败会自动恢复。探针默认最多等待 120 秒，等待超过 20 秒后会持续显示安全心跳；模型服务或流式响应卡住时，启动器会终止探针进程并给出网络/Provider 诊断，不会无限停在“正在验证”。

只有确认私有网关正常但响应时间确实超过 120 秒时，才临时调高等待时间；取值范围为 1 到 3600 秒。这个参数不会修复额度不足、限流或断流，不应作为日常配置：

```powershell
$env:AUTO_TEST_CODEX_PROBE_TIMEOUT_SECONDS = "180"
.\Auto-Test.cmd --setup-only
Remove-Item Env:AUTO_TEST_CODEX_PROBE_TIMEOUT_SECONDS
```

Chromium 首次下载默认优先使用适合当前 Windows 部署区域的 Playwright 镜像；镜像失败会自动回退官方 CDN。安装器直接使用 Auto-Test 自带的 `node.exe` 执行项目内 Playwright CLI，不依赖电脑上的全局 `npm`、`npx` 或它们的 PowerShell 脚本。企业网络如果有自己的制品镜像，可以在启动前临时指定：

```powershell
$env:AUTO_TEST_PLAYWRIGHT_DOWNLOAD_HOST = "https://your-mirror.example/playwright"
.\Auto-Test.cmd --setup-only
```

浏览器安装完成后会复用本机缓存，后续启动不会重复下载 190 MiB 以上的 Chromium 压缩包。

如果旧安装包在下载前立即显示 `Could not determine Node.js install directory`，这不是 Chromium 网络错误，而是旧启动器调用 `npx.ps1` 时的 Node 安装目录探测失败。请改用包含便携 Playwright 调用修复的新安装包；无需清理已经导入的 API 配置。

公开 GitHub 源码和公开 Release 不包含 API Key、内部 API 地址或内部模型 ID。首次使用公开源码时，需要输入这三项，或提前设置 `AUTO_TEST_CODEX_BASE_URL`、`AUTO_TEST_CODEX_MODEL` 和 `AUTO_TEST_MODEL_API_KEY`。只有服务器生成、私下交付的 `Auto-Test-Windows-private-*.zip` 才能零输入启动；该 ZIP 本身属于敏感凭据载体，分发后应从聊天工具、网盘和下载目录删除。更推荐为 Auto-Test 使用独立、限额、可随时撤销的 Key，而不是长期共享个人或服务器主 Key。

准备完成后会打开中文菜单：

```text
1. 开始一次新测试
2. 注册或更新测试环境
3. 查看最近一次结果
4. 检查运行环境
0. 退出
```

## 第一次接入一个网站

选择“注册或更新测试环境”，然后：

1. 粘贴当前已知的前台、后台等网站 URL；
2. 给环境起一个名称，例如 `test-95`；
3. 选择是否需要登录；
4. 选择允许的最高操作范围；
5. 如果需要登录，在自动打开的浏览器中正常登录，看到业务页面后回到窗口按回车。

框架会自动保存浏览器登录状态并生成环境 Profile。测试工程师不需要接触 Registry、Secret Vault、`storageState` 或 `sessionStorage`。

风险选择含义：

- `1 只读`：只能查看和断言，默认推荐；
- `2 写入`：允许新增、修改和启动等业务操作；
- `3 清理`：还允许对授权测试环境及本轮测试数据执行停止、删除或结算。选择此项时会二次确认。

## 日常执行

`execution_receipts` MCP 查询默认只提供当前窗口的紧凑同 case 推荐 ID；完整回执文件仍用于确定性校验和审计，避免前置窗口的全部回执进入新上下文。回执 ID 包含 case 窗口和 turn 序号，跨上下文或恢复时重复出现的 `item_*` 不会互相覆盖。

选择“开始一次新测试”：

1. 在弹出的窗口中选择测试用例 Excel；
2. 粘贴网站 URL；
3. 默认先执行一条数据做安全验证；
4. 选择是否显示浏览器中的自动化操作；Windows 默认显示，并对动作做轻微减速以便观察；
5. 等待框架显示最终结果。

框架会先解析 Excel，并把单元格中出现但没有手工输入的网站 URL 自动加入本次目标范围。如果已有环境只覆盖其中一部分，菜单会明确列出缺少的网站并进入环境更新向导；直接使用向导默认值会保留原环境的登录状态和权限范围。环境完整后，框架会自动选择并复用登录状态。每次运行的输出目录也会自动创建。

默认执行主体是 Codex 测试代理。短用例集使用一个持久线程；长用例集默认每 8 个 case 使用一个独立上下文，所有窗口共享同一原始 Excel、测试说明、图片、本轮环境值、登录状态、证据和 Mutation Ledger。Codex 可以使用 shell、临时脚本、网络、Web Search 和完整 Playwright MCP，自主理解、规划、探索、执行、断言并恢复。窗口调度只分配 case ID，不解释业务步骤或生成 Execution Plan。旧 Planner/Refiner/Runtime 只在命令行显式加入 `--legacy-runtime` 时使用。

框架不会再为手机号、日期、组合输入框或其他页面形态增加业务字段规则。Codex 直接读取原始测试材料，根据页面证据决定如何填写和验证；需要复杂处理时可以编写一次性 Playwright/JavaScript 辅助代码。旧的 `case_result_record` checkpoint、复合字段 Gate 和动态计划仍可作为诊断记录；它们不替代新的浏览器执行回执，也不单独决定通过。

每次运行目录中的 `agent-workspace/input/` 保存原始测试材料的本次运行副本，`codex-agent.events.jsonl` 保存脱敏后的线程、shell 和工具事件，`agent-workspace/execution-receipts.json` 保存 Runner 自动捕获的 Playwright 完成调用元数据，`codex-agent.result.json` 保存 Codex 直接生成且由框架校验的最终结果，`agent-workspace/evidence/` 保存页面证据。结束时还会生成 `原文件名-Auto-Test-结果.xlsx`：这是原 Excel 的副本，按每条 case 的来源行追加“Auto-Test 状态、失败来源、失败类型、执行摘要、证据索引、环境需求”六列，证据索引中也会列出执行回执 ID，原 Excel 不会被改写。每个 Codex 窗口会留下自己的恢复交付，全部窗口完成后 `agent-workspace/case-results.json` 保存全量版本化逐 case 交付：当最终结构化响应无法被接受，或后续 `--resume` 可以直接完成同一份交付时，框架会校验其版本、输入身份、完整覆盖、证据路径、逐 case 执行回执、显式失败来源、环境需求和权威 Ledger 终态后使用它。测试结束时，窗口会先显示通过、产品不符预期和阻断的用例数，再分别提示测试材料、环境/权限/数据、基础设施或 Codex 执行交付的首个直接原因。模型额度、MCP、浏览器或网络不可用时会返回 `blocked`，不会把基础设施错误误报为测试通过。

完整 Agent 模式可以跟随页面真实跳转和测试材料中的辅助 origin；如果目标权限、认证、测试数据、物理前置或新 origin 确实不可用，Codex 必须先在页面完成可用的只读筛选、搜索、日期范围、分页、刷新或详情观察，再将带 case ID 和证据的待补充条件记录到 `.agent-private/environment-requirements.json` 和 `codex-agent.result.json`。未完成可用页面交互属于 `agent_execution`，不能误报为环境阻断。完成环境注册或其他所需条件后，使用原 Excel、原 Profile 和原输出目录执行 `--resume`；Codex 会重新观察该条件、保存新证据并解除已满足的需求，不会重做已经确认的业务写入。只有 `--opaque-test-data` 受限模式仍会把未注册 origin 作为浏览器阻断。

启动窗口会持续显示带时间的执行进度，包括当前 case 窗口编号、累计完成 case 数、读取页面结构、填写表单、运行测试辅助脚本、更新 run 工作区、记录证据、核对 Mutation Ledger 和生成最终结果。模型或页面动作暂时没有新事件时，窗口每约 20 秒输出一次“框架仍在运行”心跳，因此可以区分正常思考、自动重连和明确阻断。进度只显示动作类别，不显示模型推理正文、命令内容、表单值、工具参数、Cookie、验证码或 API 信息。

这些进度表示 Codex 仍在工作，不代表测试已经通过。最终结论以 `codex-agent.result.json`、其中引用的实际证据以及 Mutation Ledger 的终态为准；Execution Plan 和字段 Gate 不再是必需产物。

结束时直接显示以下三类结果：

- `测试通过`：页面操作、业务断言、证据和最终恢复状态全部通过；
- `发现产品或业务结果不符合预期`：测试操作完成，但预期结果没有成立；
- `测试暂时无法继续`：测试执行未完成，框架会说明原因和恢复方式。

非通过结果会按固定顺序显示：失败位置、原因类别、直接原因、需要补充的环境、建议操作、完成情况、业务残留和证据路径。原因类别只有五类：产品缺陷、代理执行失败、输入资料问题、环境阻断和基础设施故障。

该摘要只整理同一份 `codex-agent.result.json`、Environment Requirement 和 Mutation Ledger，不会启动另一个 AI Reporter。详细技术异常仍保留在脱敏的 `codex-agent.events.jsonl` 中，避免把模型事件、工具参数或表单值直接输出给测试人员。

## 可选命令行

日常推荐双击启动器。需要接入脚本时仍通过启动器调用，以便自动加载加密的 API Key：

```powershell
.\Auto-Test.cmd run `
  --file "C:/TestData/cases.xlsx" `
  --url "https://app.example.test/" `
  --url "https://admin.example.test/" `
  --headed `
  --slow-mo 150 `
  --case-batch-size 8 `
  --one
```

`--headed` 会显示认证刷新和 Codex 测试代理的浏览器操作；`--headless` 适合无人值守执行。浏览器在运行结束后会正常关闭，页面证据和结构化结果仍保存在本次结果目录中。

默认模式给予 Codex 原始测试材料、可写 run 工作区、shell、网络、Web Search 和完整 Playwright。它只能在 run 工作区写文件，不应修改 Auto-Test 或被测应用源码。需要恢复旧的只读、MCP-only、origin 受限模式时显式加入 `--opaque-test-data`。

如果电脑睡眠、网络、模型连接、浏览器或 MCP 导致运行中断，恢复网络后复用原命令、原 Excel、原环境和原结果目录，并增加 `--resume`：

```powershell
.\Auto-Test.cmd run `
  --file "C:/TestData/cases.xlsx" `
  --url "https://app.example.test/" `
  --url "https://admin.example.test/" `
  --profile staging `
  --output-dir "D:/Auto-Test-results/interrupted-run" `
  --resume `
  --headed
```

恢复继续使用同一个 run 和 Mutation Ledger。框架会先校验已有逐 case 交付；如果输入身份、执行回执、证据、环境需求和 Ledger 全部完整且没有 pending Mutation，就直接生成正式结果。否则只恢复状态文件中 `activeBatch` 对应的 Codex thread，已经完成的 case 窗口不会重跑。Excel、URL、Profile、风险策略、窗口大小和原有 origin 必须保持不变；对于本次 run 已记录为环境需求、后来完成注册的 origin，框架允许在同一 Profile 下追加并恢复，其他环境替换或权限收窄都会拒绝恢复。

只有排查旧链路兼容性时才使用：

```powershell
.\Auto-Test.cmd run --file "C:/TestData/cases.xlsx" --url "https://app.example.test/" --legacy-runtime
```

其他命令：

```powershell
.\Auto-Test.cmd doctor
.\Auto-Test.cmd status
.\Auto-Test.cmd register --profile test-95 --url "https://example.test/"
```

两个 API Key 使用同一个 Base URL 时，可以只在本次运行临时指定另一个 Key。默认 Key 不会被替换，也不会把临时 Key 写入 DPAPI：

```powershell
.\Auto-Test.cmd --api-key "<temporary-api-key>" --setup-only
.\Auto-Test.cmd run `
  --file "C:/TestData/cases.xlsx" `
  --url "https://app.example.test/" `
  --api-key "<temporary-api-key>" `
  --headed
```

`--api-key` 只影响当前启动的 Codex 进程，Base URL 和模型仍使用现有 Provider 配置；不带该参数时继续使用私有包内置的默认 Key。命令行参数可能出现在本机进程列表或 PowerShell 历史中，只在受控测试机使用，不要把真实 Key 写进脚本、Excel 或文档。

需要永久重新配置默认 Provider（包括 Base URL、模型或默认 Key）时，才执行：

```powershell
.\Auto-Test.cmd --reconfigure-api --setup-only
```

管理员批量部署时仍可以覆盖内置配置并静默准备：

```powershell
$env:AUTO_TEST_CODEX_BASE_URL = "https://model-api.example/v1"
$env:AUTO_TEST_CODEX_MODEL = "your-model-id"
$env:AUTO_TEST_MODEL_API_KEY = "deployment-secret"
$env:AUTO_TEST_PERSIST_API_KEY = "0"
.\Auto-Test.cmd --setup-only
```

内部私有包正常使用时无需输入 API Key。只有调试公开源码包或主动轮换凭据时，安装器才会使用隐藏输入；不要把 Key 写进命令行。

私有包的完整打包流程、非交互构建方式、复制到 Windows 和 SHA-256 记录见[Windows 私有包快速打包](windows-package-quick-start.md)。本文只保留 Provider 轮换和运行时配置说明。

## 注意事项

- 测试运行时关闭正在编辑的 Excel，避免文件锁；
- 使用本地输出目录，不要使用公共共享盘；
- 长流程运行前关闭系统自动休眠；
- OTP 来源、租户权限、真实设备状态等无法从 URL 自动推断，缺失时框架仍会安全阻断并提示补充；
- 框架不会保存登录表单中的明文密码，但会把登录后的会话令牌保存在当前 Windows 用户的私有配置目录；不要把该目录同步或共享，也不要把密码写进 Excel、补充说明或命令行。

高级 Profile、自动表单登录及故障排查配置见 [完整快速指南](quick-start.md)。
