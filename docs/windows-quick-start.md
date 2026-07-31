# Windows 快速操作指南

本框架支持在 Windows 10/11 的 PowerShell 中运行。日常输入仍然只有目标网站 URL、测试用例 Excel，以及首次环境注册时配置的登录与权限信息。

## 1. 安装

准备以下软件：

- Node.js 24 或更高版本；
- Git；
- 已登录且可执行的 Codex CLI；
- PowerShell 5.1 或更高版本。

在 PowerShell 中进入仓库根目录并检查环境：

```powershell
node --version
npm --version
codex --version

npm ci
npx playwright install chromium
npm run check
```

如果 `codex --version` 不可用，先安装并登录组织批准的 Codex CLI。Claude CLI 仅作为模型额度不足时的可选备用，不是必需项。

## 2. 首次注册环境

Windows 的默认配置目录是：

```text
%APPDATA%\auto-test
```

创建目录并复制模板：

```powershell
$ConfigDir = Join-Path $env:APPDATA "auto-test"
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
Copy-Item ".\templates\environment-profiles.example.json" `
  (Join-Path $ConfigDir "environment-profiles.json")
```

模板中的私有文件路径均相对于该目录解析。编辑以下文件：

```powershell
notepad (Join-Path $ConfigDir "environment-profiles.json")
notepad (Join-Path $ConfigDir "staging-secrets.json")
notepad (Join-Path $ConfigDir "staging-planner-context.txt")
```

Secret Vault 保存账号及测试数据，例如：

```json
{
  "staging.admin.username": "your-test-user",
  "staging.admin.password": "your-test-password"
}
```

Profile 中需要配置：

- `origins`：允许访问的网站 origin；
- `auth`：登录地址、登录成功判据和已确认的登录控件；
- `policy`：是否允许写入、删除及自动修订次数；
- `plannerContextPath`：不含密码的环境说明和业务规则。

登录适配器引用的 `storageState` 必须先存在。使用无 BOM 的 UTF-8 创建空文件：

```powershell
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText(
  (Join-Path $ConfigDir "admin.storage-state.json"),
  '{"cookies":[],"origins":[]}',
  $Utf8NoBom
)
```

只有网站确实依赖 `sessionStorage` 时才保留 `sessionStoragePath`。首次创建示例：

```powershell
[System.IO.File]::WriteAllText(
  (Join-Path $ConfigDir "admin.session-storage.json"),
  '{"origin":"https://admin.example.test","entries":{}}',
  $Utf8NoBom
)
```

将示例 origin 替换为实际后台 origin。配置目录必须放在当前 Windows 用户的个人目录中，并通过“属性 -> 安全”确认普通其他用户没有读取权限；可以使用 `icacls $ConfigDir` 查看 ACL。不要把这些文件放进仓库、OneDrive 公共目录或共享盘。

## 3. 执行测试

建议先执行一条数据 canary。PowerShell 使用反引号续行，反引号后不能有空格：

```powershell
npm run autonomous:workflow -- `
  --file "C:/Auto-Test-Data/cases.xlsx" `
  --url "https://app.example.test/" `
  --url "https://admin.example.test/" `
  --profile "staging-example" `
  --max-iterations 1 `
  --iteration-offset 0 `
  --output-dir "artifacts/runs/example-canary"
```

路径推荐使用 `C:/folder/file.xlsx` 形式，避免 JSON 中反斜杠转义。补充说明和外部截图可分别增加 `--brief`、`--image`。

canary 通过后执行完整数据集：

```powershell
npm run autonomous:workflow -- `
  --file "C:/Auto-Test-Data/cases.xlsx" `
  --url "https://app.example.test/" `
  --url "https://admin.example.test/" `
  --profile "staging-example" `
  --output-dir "artifacts/runs/example-full"
```

## 4. 查看结果

PowerShell 不需要安装 `jq`：

```powershell
$State = Get-Content `
  "artifacts/runs/example-full/autonomous-job.state.json" `
  -Raw -Encoding UTF8 | ConvertFrom-Json

$State | Select-Object status, outcome, stage, round, executionAttempts, `
  humanInputRequestPath, runtimeResultPath
```

- `passed`：执行和业务断言通过；
- `product_failed`：页面操作完成，但业务预期不成立；
- `blocked`：缺少账号、权限、业务规则、测试数据、恢复能力或环境条件。

出现 `blocked` 时查看框架生成的问题：

```powershell
Get-Content "artifacts/runs/example-full/human-input-request.json" `
  -Raw -Encoding UTF8 | ConvertFrom-Json | Format-List
```

只补充账号、权限或租户状态时，使用原 `--output-dir` 重跑即可继续。修改 URL、Profile、补充说明、图片或 Planner Context 后，需要使用新的输出目录。

## Windows 注意事项

- 长时间测试前关闭系统自动休眠；锁屏不影响无头浏览器。
- 测试运行时关闭正在编辑的 Excel，避免读到未保存内容或文件锁。
- 输出目录使用本地磁盘，避免 OneDrive、网络盘和杀毒软件同步造成文件锁竞争。
- Windows 使用 NTFS ACL，不使用 Unix `chmod 600`；框架只在 Linux/macOS 校验 POSIX 权限位。
- 账号、验证码和 Token 只放 Secret Vault，不要写在 PowerShell 命令或测试说明中。
