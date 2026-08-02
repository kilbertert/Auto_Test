# Windows 使用：双击即可开始

日常使用不需要编辑 JSON、不需要创建 `storageState`，也不需要记住长命令。

准备在新 Windows 目录中完整复现一次真实验收时，直接按 [Windows 从零验收清单](windows-acceptance-runbook.md) 操作；本文保留安装原理、私有 Provider 和高级命令细节。

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

旧版本如果检测到 `cliproxyapi` 配置，会自动改用上述直连接入。新配置通过真实 API 探针后才会替换旧配置；验证失败会自动恢复。

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

选择“开始一次新测试”：

1. 在弹出的窗口中选择测试用例 Excel；
2. 粘贴网站 URL；
3. 默认先执行一条数据做安全验证；
4. 选择是否显示浏览器中的自动化操作；Windows 默认显示，并对动作做轻微减速以便观察；
5. 等待框架显示最终结果。

框架会先解析 Excel，并把单元格中出现但没有手工输入的网站 URL 自动加入本次目标范围。如果已有环境只覆盖其中一部分，菜单会明确列出缺少的网站并进入环境更新向导；直接使用向导默认值会保留原环境的登录状态和权限范围。环境完整后，框架会自动选择并复用登录状态。每次运行的输出目录也会自动创建。

默认执行主体是一个持久 Codex 测试线程。它通过 Playwright MCP 查看真实页面、持续更新动态计划、执行操作、验证业务结果并完成恢复；测试工程师不需要编辑 Execution Plan。旧 Planner/Refiner/Runtime 只在命令行显式加入 `--legacy-runtime` 时使用。

一个逻辑测试值如果在页面上被拆成选择器、输入框、显示前缀或其他组件，代理必须在提交前通过通用的复合字段输入 Gate。当前默认使用 execution-first：模型可以按需读取本次 Excel/Profile 中的测试值，自主派生各页面组件所需的值；它仍无法通过该接口读取模型 API Key、Cookie、浏览器存储或宿主机凭据。Gate 会根据组件的 `segment/context/none` 关系私下重建原始逻辑值，并从持久化记录中删除派生明文；重复、遗漏、未知表示或缺少填充后证据会直接阻断提交。只有 Gate 已通过、应用仍拒绝正确表示时，结果才能记为产品缺陷；代理填错必须记为 `blocked/agent_execution`。需要恢复严格别名模式时，在命令行加入 `--opaque-test-data`。

每次运行目录中的 `codex-agent.events.jsonl` 保存脱敏后的线程和工具事件，`codex-agent.result.json` 保存最终结果，`agent-workspace/evidence/` 保存页面证据，`.agent-private/field-compositions.json` 保存复合字段 Gate。模型额度、MCP、浏览器或网络不可用时会返回 `blocked` 并写明原因，不会把基础设施错误误报为测试通过。

如果测试材料或页面证据提出了环境 Profile 未注册的新网站 origin，代理不会直接访问或猜测替代路由，而会在 `.agent-private/environment-requirements.json` 和 `codex-agent.result.json` 中记录待补充 origin。完成环境注册后，使用原 Excel、原 Profile 和原输出目录执行 `--resume`；这不会重做已经确认的业务写入。

启动窗口会持续显示带时间的执行进度，包括读取测试材料、校验环境、启动或恢复 Codex 线程、读取页面结构、填写表单、更新动态 Execution Plan、记录证据、核对 Mutation Ledger 和最终化补齐。模型或页面动作暂时没有新事件时，窗口每约 20 秒输出一次“框架仍在运行”心跳，因此可以区分正常思考、自动重连和明确阻断。进度只显示受控动作类别，不显示模型推理正文、表单值、工具参数、Cookie、验证码或 API 信息。

这些进度表示框架仍在工作，不代表测试已经通过。最终结论仍以 `codex-agent.result.json`、Execution Plan、证据、Environment Requirements 和 Mutation Ledger 的终态为准。

结束时直接显示以下三类结果：

- `测试通过`：页面操作、业务断言、证据和最终恢复状态全部通过；
- `发现产品或业务结果不符合预期`：测试操作完成，但预期结果没有成立；
- `测试暂时无法继续`：框架会用中文列出需要补充的账号、权限、业务规则或测试数据。

## 可选命令行

日常推荐双击启动器。需要接入脚本时仍通过启动器调用，以便自动加载加密的 API Key：

```powershell
.\Auto-Test.cmd run `
  --file "C:/TestData/cases.xlsx" `
  --url "https://app.example.test/" `
  --url "https://admin.example.test/" `
  --headed `
  --slow-mo 150 `
  --one
```

`--headed` 会显示认证刷新和 Codex 测试代理的浏览器操作；`--headless` 适合无人值守执行。浏览器在运行结束后会正常关闭，页面证据和结构化结果仍保存在本次结果目录中。

默认 direct 测试数据模式只扩大模型对本次运行测试值的可见性，不放开 origin allowlist、Mutation Ledger、身份匹配、清理和最终结果门禁。

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

恢复继续使用同一个 Codex thread 和 Mutation Ledger。它只重建浏览器/MCP 进程，并先根据页面证据核对未完成业务写入。Excel、URL、Profile、风险策略和原有 origin 必须保持不变；对于本次 run 已记录为环境需求、后来完成注册的 origin，框架允许在同一 Profile 下追加并恢复，其他环境替换或权限收窄都会拒绝恢复。

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

私有发行管理员在受控服务器上构建零输入包时，可以直接运行快速脚本：

```bash
AUTO_TEST_CODEX_BASE_URL="https://model-api.example/v1" \
AUTO_TEST_CODEX_MODEL="your-model-id" \
bash scripts/build-private-windows-package-quick.sh
```

脚本会隐藏读取 API Key，完成后输出 ZIP 的绝对路径和 SHA-256。也可以使用底层脚本进行自动化构建：

```bash
printf '%s\n' "$MODEL_API_KEY" | \
  AUTO_TEST_CODEX_BASE_URL="https://model-api.example/v1" \
  AUTO_TEST_CODEX_MODEL="your-model-id" \
  bash scripts/build-private-windows-package.sh
```

两种脚本都只允许从干净、已提交的工作树构建，输出位于被 Git 忽略的 `artifacts/private-release/`。包名形如 `Auto-Test-Windows-private-<commit>.zip`；把它复制到 Windows 后解压，双击 `Auto-Test.cmd` 即可。包内含可提取的模型 API Key，禁止提交 Git、上传 GitHub、网盘或公开制品库。

## 注意事项

- 测试运行时关闭正在编辑的 Excel，避免文件锁；
- 使用本地输出目录，不要使用公共共享盘；
- 长流程运行前关闭系统自动休眠；
- OTP 来源、租户权限、真实设备状态等无法从 URL 自动推断，缺失时框架仍会安全阻断并提示补充；
- 框架不会保存登录表单中的明文密码，但会把登录后的会话令牌保存在当前 Windows 用户的私有配置目录；不要把该目录同步或共享，也不要把密码写进 Excel、补充说明或命令行。

高级 Profile、自动表单登录及故障排查配置见 [完整快速指南](quick-start.md)。
