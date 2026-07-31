# Windows 使用：双击即可开始

日常使用不需要编辑 JSON、不需要创建 `storageState`，也不需要记住长命令。

## 第一次使用

直接双击仓库根目录的 `Auto-Test.cmd`。

启动器会自动完成：

1. 从 Node.js 官方发布包安装 Auto-Test 私有的固定版本 Node.js 24，并校验官方 SHA-256；
2. 在 Auto-Test 私有工具目录安装与服务器一致的 Codex CLI 固定版本；
3. 使用内置的模型 API 配置准备 Auto-Test 独立的 Codex API Provider；
4. 发送一次最小模型请求，验证 API 地址、Key 和模型真实可用；
5. 安装项目依赖和 Chromium；
6. 打开中文操作菜单。

不需要执行 `codex login`，也不使用 ChatGPT 账号额度。

内部私有 Windows 包已经内置：

- `API Base URL`：`https://api.psydo.top/v1`；
- `模型 ID`：`gpt-5.6-sol`；
- 私有 API Key：首次双击时自动导入当前 Windows 用户的 DPAPI，然后删除解压目录中的明文引导文件。

因此测试工程师不需要填写任何模型信息。Windows 会直接调用上述 API，不需要连接或暴露 Auto-Test 服务器，也不要求安装 CLIProxyAPI。安装器使用通用的直接 API Provider：

```toml
model = "gpt-5.6-sol"
model_provider = "auto_test_api"

[model_providers.auto_test_api]
name = "Auto-Test Model API"
base_url = "https://api.psydo.top/v1"
wire_api = "responses"
env_key = "AUTO_TEST_MODEL_API_KEY"
requires_openai_auth = false
```

Node.js 和 Codex CLI 都安装在 `%APPDATA%\auto-test\tools`，Codex 配置保存在 `%APPDATA%\auto-test\codex-home`。整个过程不需要管理员权限，不会安装或覆盖电脑上的全局 Node/Codex，也不会修改已有的 `%USERPROFILE%\.codex`。API Key 使用 Windows DPAPI 加密保存，仅当前 Windows 用户能够解密；启动时只加载到 Auto-Test 当前进程的 `AUTO_TEST_MODEL_API_KEY`，不会写入仓库、TOML 或明文用户环境变量。

旧版本如果检测到 `cliproxyapi` 配置，会自动改用上述直连接入。新配置通过真实 API 探针后才会替换旧配置；验证失败会自动恢复。

Chromium 首次下载默认优先使用适合当前 Windows 部署区域的 Playwright 镜像；镜像失败会自动回退官方 CDN。企业网络如果有自己的制品镜像，可以在启动前临时指定：

```powershell
$env:AUTO_TEST_PLAYWRIGHT_DOWNLOAD_HOST = "https://your-mirror.example/playwright"
.\Auto-Test.cmd --setup-only
```

浏览器安装完成后会复用本机缓存，后续启动不会重复下载 190 MiB 以上的 Chromium 压缩包。

公开 GitHub 源码和公开 Release 不包含 API Key。只有服务器生成、私下交付的 `Auto-Test-Windows-private-*.zip` 才能零输入启动；该 ZIP 本身属于敏感凭据载体，分发后应从聊天工具、网盘和下载目录删除。更推荐为 Auto-Test 使用独立、限额、可随时撤销的 Key，而不是长期共享个人或服务器主 Key。

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

Planner、页面探索、Refiner 和 Runtime 在运行期间会持续显示当前轮次和等待时间，不再长时间静默。每次运行目录中的 `run-events.jsonl` 保存了脱敏后的阶段、模型轮次、结构规范化、校验失败和耗时记录；测试阻断或异常结束时，中文结果摘要会直接给出该诊断文件的位置。

结束时直接显示以下三类结果：

- `测试通过`：Execution Plan、页面操作和业务断言全部通过；
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

`--headed` 会显示页面探索、认证刷新和最终 Runtime 的浏览器操作；`--headless` 适合无人值守执行。浏览器在运行结束后会正常关闭，截图、Trace 和结果报告仍保存在本次结果目录中。

其他命令：

```powershell
.\Auto-Test.cmd doctor
.\Auto-Test.cmd status
.\Auto-Test.cmd register --profile test-95 --url "https://example.test/"
```

需要临时改用其他 API 或轮换 API Key 时执行：

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

私有发行管理员在受控服务器上构建零输入包时，通过标准输入或私有进程环境把专用 Key 交给 `scripts/build-private-windows-package.sh`。脚本只允许从干净、已提交的工作树构建，输出位于被 Git 忽略的 `artifacts/private-release/`，且不会打印 Key。

## 注意事项

- 测试运行时关闭正在编辑的 Excel，避免文件锁；
- 使用本地输出目录，不要使用公共共享盘；
- 长流程运行前关闭系统自动休眠；
- OTP 来源、租户权限、真实设备状态等无法从 URL 自动推断，缺失时框架仍会安全阻断并提示补充；
- 框架不会保存登录表单中的明文密码，但会把登录后的会话令牌保存在当前 Windows 用户的私有配置目录；不要把该目录同步或共享，也不要把密码写进 Excel、补充说明或命令行。

高级 Profile、自动表单登录及故障排查配置见 [完整快速指南](quick-start.md)。
