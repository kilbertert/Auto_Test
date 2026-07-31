param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $AutoTestArgs
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepositoryRoot

$NodeVersion = '24.15.0'
$CodexVersion = '0.144.5'
$ProviderId = 'auto_test_api'
$ProviderName = 'Auto-Test Model API'
$ProviderKeyEnvironment = 'AUTO_TEST_MODEL_API_KEY'
$LegacyProviderId = 'cliproxyapi'
$script:ApiConfigurationChanged = $false
$script:ProviderConfigPath = ''
$script:ProviderSecretPath = ''
$script:PreviousConfigExists = $false
$script:PreviousConfigContent = ''
$script:PreviousSecretExists = $false
$script:PreviousSecretContent = ''

function Resolve-ToolsHome {
  if ($env:AUTO_TEST_TOOLS_HOME) { return $env:AUTO_TEST_TOOLS_HOME }
  return Join-Path $env:APPDATA 'auto-test\tools'
}

function Get-NodeVersion([string] $Executable) {
  if (-not (Test-Path $Executable)) { return '' }
  try {
    return (& $Executable -p "process.versions.node" | Out-String).Trim()
  } catch {
    return ''
  }
}

function Get-Sha256([string] $Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Ensure-Node {
  $toolsHome = Resolve-ToolsHome
  $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $archiveStem = "node-v$NodeVersion-win-$architecture"
  $nodeHome = Join-Path $toolsHome $archiveStem
  $nodeExecutable = Join-Path $nodeHome 'node.exe'
  if ((Get-NodeVersion $nodeExecutable) -eq $NodeVersion) {
    $env:Path = "$nodeHome;$env:Path"
    Write-Host "[OK] Node.js v$NodeVersion"
    return
  }

  Write-Host "[安装] 正在为 Auto-Test 下载独立 Node.js v$NodeVersion……"
  New-Item -ItemType Directory -Force -Path $toolsHome | Out-Null
  $archivePath = Join-Path $env:TEMP "$archiveStem-$([Guid]::NewGuid().ToString('N')).zip"
  $checksumPath = "$archivePath.sha256"
  $extractPath = Join-Path $toolsHome "node-extract-$([Guid]::NewGuid().ToString('N'))"
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $releaseBase = "https://nodejs.org/dist/v$NodeVersion"
    Invoke-WebRequest -Uri "$releaseBase/$archiveStem.zip" -OutFile $archivePath -UseBasicParsing
    Invoke-WebRequest -Uri "$releaseBase/SHASUMS256.txt" -OutFile $checksumPath -UseBasicParsing
    $checksumLine = Get-Content $checksumPath | Where-Object { $_ -match "\s+$([Regex]::Escape($archiveStem)).zip$" } | Select-Object -First 1
    if (-not $checksumLine) { throw 'Node.js 官方校验文件中没有找到目标 Windows 发布包。' }
    $expectedHash = ($checksumLine -split '\s+')[0].ToUpperInvariant()
    $actualHash = (Get-Sha256 $archivePath).ToUpperInvariant()
    if ($actualHash -ne $expectedHash) { throw 'Node.js 发布包 SHA-256 校验失败，已拒绝安装。' }
    Expand-Archive -Path $archivePath -DestinationPath $extractPath -Force
    $extractedHome = Join-Path $extractPath $archiveStem
    if (-not (Test-Path (Join-Path $extractedHome 'node.exe'))) { throw 'Node.js 发布包结构无效。' }
    if (Test-Path $nodeHome) { Remove-Item -Recurse -Force $nodeHome }
    Move-Item -Path $extractedHome -Destination $nodeHome
  } finally {
    Remove-Item -Force $archivePath -ErrorAction SilentlyContinue
    Remove-Item -Force $checksumPath -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $extractPath -ErrorAction SilentlyContinue
  }
  if ((Get-NodeVersion $nodeExecutable) -ne $NodeVersion) { throw 'Node.js 私有安装验证失败。' }
  $env:Path = "$nodeHome;$env:Path"
  Write-Host "[OK] Node.js v$NodeVersion"
}

function Get-CodexVersion([string] $Executable) {
  if (-not (Test-Path $Executable)) { return '' }
  $output = (& $Executable --version 2>$null | Out-String).Trim()
  if ($output -match '(\d+\.\d+\.\d+)') { return $Matches[1] }
  return ''
}

function Ensure-CodexCli {
  $toolsHome = Resolve-ToolsHome
  $codexExecutable = Join-Path $toolsHome 'node_modules\.bin\codex.cmd'
  $installed = Get-CodexVersion $codexExecutable
  if ($installed -eq $CodexVersion) {
    $env:Path = "$(Split-Path -Parent $codexExecutable);$env:Path"
    $env:AUTO_TEST_CODEX_BIN = $codexExecutable
    Write-Host "[OK] Codex CLI $installed"
    return
  }

  Write-Host "[安装] 正在为 Auto-Test 安装独立 Codex CLI $CodexVersion……"
  New-Item -ItemType Directory -Force -Path $toolsHome | Out-Null
  & npm install --prefix $toolsHome "@openai/codex@$CodexVersion" --no-save --no-package-lock --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { throw 'Codex CLI 安装失败。请检查 npm 网络或代理配置。' }
  $env:Path = "$(Split-Path -Parent $codexExecutable);$env:Path"
  $env:AUTO_TEST_CODEX_BIN = $codexExecutable
  $installed = Get-CodexVersion $codexExecutable
  if ($installed -ne $CodexVersion) { throw "Codex CLI 版本验证失败，期望 $CodexVersion，实际 $installed。" }
  Write-Host "[OK] Codex CLI $installed"
}

function Convert-SecureText([Security.SecureString] $SecureValue) {
  $secure = $SecureValue
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Escape-TomlString([string] $Value) {
  return $Value.Replace('\', '\\').Replace('"', '\"')
}

function Test-HttpUrl([string] $Value) {
  $uri = $null
  return [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref] $uri) -and
    ($uri.Scheme -eq 'http' -or $uri.Scheme -eq 'https')
}

function Resolve-CodexHome {
  if ($env:AUTO_TEST_CODEX_HOME) { return $env:AUTO_TEST_CODEX_HOME }
  return Join-Path $env:APPDATA 'auto-test\codex-home'
}

function Ensure-ApiProvider([switch] $ForcePrompt) {
  $codexHome = Resolve-CodexHome
  New-Item -ItemType Directory -Force -Path $codexHome | Out-Null
  $env:CODEX_HOME = $codexHome
  $env:AUTO_TEST_CODEX_HOME = $codexHome
  $env:AUTO_TEST_CODEX_ENV_KEY = $ProviderKeyEnvironment

  $configPath = Join-Path $codexHome 'config.toml'
  $secretPath = Join-Path $codexHome 'provider-key.dpapi'
  $script:ProviderConfigPath = $configPath
  $script:ProviderSecretPath = $secretPath
  $script:PreviousConfigExists = Test-Path $configPath
  $script:PreviousConfigContent = if ($script:PreviousConfigExists) { Get-Content -Raw -Encoding UTF8 $configPath } else { '' }
  $script:PreviousSecretExists = Test-Path $secretPath
  $script:PreviousSecretContent = if ($script:PreviousSecretExists) { Get-Content -Raw -Encoding UTF8 $secretPath } else { '' }

  $existingConfig = $script:PreviousConfigContent
  $providerMatch = [Regex]::Match($existingConfig, '(?m)^\s*model_provider\s*=\s*"([^"]+)"\s*$')
  $existingProviderId = if ($providerMatch.Success) { $providerMatch.Groups[1].Value } else { '' }
  $providerSectionPattern = "(?m)^\s*\[model_providers\.$([Regex]::Escape($ProviderId))\]\s*$"
  $baseUrlMatch = [Regex]::Match($existingConfig, '(?m)^\s*base_url\s*=\s*"([^"]+)"\s*$')
  $modelMatch = [Regex]::Match($existingConfig, '(?m)^\s*model\s*=\s*"([^"]+)"\s*$')
  $configuredBaseUrl = if ($baseUrlMatch.Success) { $baseUrlMatch.Groups[1].Value } else { '' }
  $configuredModel = if ($modelMatch.Success) { $modelMatch.Groups[1].Value } else { '' }
  $providerKeyPattern = '(?m)^\s*env_key\s*=\s*"' + [Regex]::Escape($ProviderKeyEnvironment) + '"\s*$'
  $providerReady = $existingProviderId -eq $ProviderId -and
    [Regex]::IsMatch($existingConfig, $providerSectionPattern) -and
    [Regex]::IsMatch($existingConfig, '(?m)^\s*wire_api\s*=\s*"responses"\s*$') -and
    [Regex]::IsMatch($existingConfig, $providerKeyPattern) -and
    [Regex]::IsMatch($existingConfig, '(?m)^\s*requires_openai_auth\s*=\s*false\s*$') -and
    -not [string]::IsNullOrWhiteSpace($configuredBaseUrl) -and
    -not [string]::IsNullOrWhiteSpace($configuredModel)
  $legacyProvider = $existingProviderId -eq $LegacyProviderId
  $existingBaseUrl = if ($providerReady) { $configuredBaseUrl } else { '' }
  $existingModel = if ($providerReady) { $configuredModel } else { '' }

  $baseUrl = $env:AUTO_TEST_CODEX_BASE_URL
  $model = $env:AUTO_TEST_CODEX_MODEL
  $apiKey = [Environment]::GetEnvironmentVariable($ProviderKeyEnvironment, 'Process')
  $apiKeyFromProcess = -not [string]::IsNullOrWhiteSpace($apiKey)
  if (-not $apiKeyFromProcess) { $apiKey = '' }
  $apiKeyLoadedFromDpapi = $false
  if (-not $ForcePrompt -and $providerReady -and -not $apiKey -and (Test-Path $secretPath)) {
    try {
      $encrypted = Get-Content -Raw -Encoding UTF8 $secretPath
      $apiKey = Convert-SecureText (ConvertTo-SecureString $encrypted.Trim())
      $apiKeyLoadedFromDpapi = $true
    } catch {
      throw '已保存的 API Key 无法由当前 Windows 用户解密，请使用 --reconfigure-api 重新配置。'
    }
  }
  $script:ApiConfigurationChanged = $ForcePrompt -or $legacyProvider -or -not $providerReady -or
    $apiKeyFromProcess -or -not $apiKeyLoadedFromDpapi
  if ($baseUrl -and $existingBaseUrl -and $baseUrl -ne $existingBaseUrl) {
    $script:ApiConfigurationChanged = $true
  }
  if ($model -and $existingModel -and $model -ne $existingModel) {
    $script:ApiConfigurationChanged = $true
  }

  if ($ForcePrompt) {
    $baseUrl = ''
    $model = ''
    $apiKey = ''
    $apiKeyFromProcess = $false
    $providerReady = $false
  }
  if ($legacyProvider) {
    $providerReady = $false
    Write-Host ''
    Write-Host '[迁移] 检测到旧的服务器 CLIProxyAPI 配置。'
    Write-Host '       请改为填写 Windows 能够直接访问的模型 API，不需要暴露 Auto-Test 服务器。'
  }

  if (-not $baseUrl -and $providerReady -and $existingBaseUrl) {
    $baseUrl = $existingBaseUrl
  }
  if (-not $model -and $providerReady -and $existingModel) {
    $model = $existingModel
  }
  if (-not $baseUrl) {
    if ([Console]::IsInputRedirected) {
      throw '缺少 AUTO_TEST_CODEX_BASE_URL，无法在非交互模式配置模型 API。'
    }
    Write-Host ''
    Write-Host '请输入现有的、Windows 能够直接访问的 Responses API 地址。'
    $baseUrl = (Read-Host 'API Base URL').Trim()
  }
  if (-not (Test-HttpUrl $baseUrl)) { throw "API Base URL 无效：$baseUrl" }

  if (-not $model) {
    if ([Console]::IsInputRedirected) {
      throw '缺少 AUTO_TEST_CODEX_MODEL，无法在非交互模式配置模型 API。'
    }
    $model = (Read-Host '模型 ID（由 API 服务提供方给出）').Trim()
  }
  if ([string]::IsNullOrWhiteSpace($model) -or $model -match '[\r\n]') {
    throw '模型 ID 无效。'
  }

  $secureKey = $null
  $keyProvidedNow = $apiKeyFromProcess
  if (-not $apiKey) {
    if ([Console]::IsInputRedirected) {
      throw "缺少 $ProviderKeyEnvironment，无法在非交互模式配置模型 API。"
    }
    $secureKey = Read-Host 'API Key（输入过程不会显示）' -AsSecureString
    $apiKey = Convert-SecureText $secureKey
    if ([string]::IsNullOrWhiteSpace($apiKey)) { throw 'API Key 不能为空。' }
    $keyProvidedNow = $true
  } elseif ($keyProvidedNow) {
    $secureKey = ConvertTo-SecureString $apiKey -AsPlainText -Force
  }
  if ($keyProvidedNow) {
    if ($env:AUTO_TEST_PERSIST_API_KEY -eq '0') {
      Remove-Item -Force $secretPath -ErrorAction SilentlyContinue
    } else {
      $encrypted = ConvertFrom-SecureString $secureKey
      [IO.File]::WriteAllText($secretPath, $encrypted, [Text.UTF8Encoding]::new($false))
    }
  }
  [Environment]::SetEnvironmentVariable($ProviderKeyEnvironment, $apiKey, 'Process')

  $config = @"
model = "$(Escape-TomlString $model)"
model_provider = "$ProviderId"
model_reasoning_effort = "xhigh"

[model_providers.$ProviderId]
name = "$ProviderName"
base_url = "$(Escape-TomlString $baseUrl)"
wire_api = "responses"
env_key = "$ProviderKeyEnvironment"
requires_openai_auth = false
"@
  [IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))
  Write-Host "[OK] Codex API Provider：$ProviderName / $model"
  Write-Host "     配置目录：$codexHome"
}

function Restore-PreviousProviderConfig {
  if ($script:PreviousConfigExists) {
    [IO.File]::WriteAllText($script:ProviderConfigPath, $script:PreviousConfigContent, [Text.UTF8Encoding]::new($false))
  } else {
    Remove-Item -Force $script:ProviderConfigPath -ErrorAction SilentlyContinue
  }
  if ($script:PreviousSecretExists) {
    [IO.File]::WriteAllText($script:ProviderSecretPath, $script:PreviousSecretContent, [Text.UTF8Encoding]::new($false))
  } else {
    Remove-Item -Force $script:ProviderSecretPath -ErrorAction SilentlyContinue
  }
}

function Test-CodexProvider {
  if (-not $script:ApiConfigurationChanged -or $env:AUTO_TEST_SKIP_API_PROBE -eq '1') { return }
  $codexExecutable = $env:AUTO_TEST_CODEX_BIN
  if (-not $codexExecutable -or -not (Test-Path $codexExecutable)) { throw '找不到 Auto-Test 私有 Codex CLI。' }
  $probePath = Join-Path $env:TEMP "auto-test-codex-probe-$([Guid]::NewGuid().ToString('N')).txt"
  try {
    Write-Host '[检查] 正在验证模型 API 地址、Key 和模型可用性……'
    & $codexExecutable exec 'Reply with exactly AUTO_TEST_API_READY.' --ephemeral --sandbox read-only --skip-git-repo-check --color never -C $RepositoryRoot *>&1 | Out-File -FilePath $probePath -Encoding utf8
    if ($LASTEXITCODE -ne 0) {
      Restore-PreviousProviderConfig
      throw '模型 API 探针失败，已恢复上一版配置。请检查 API Base URL、API Key 和模型 ID。'
    }
    $probe = Get-Content -Raw -Encoding UTF8 $probePath
    if ($probe -notmatch '(?m)^\s*AUTO_TEST_API_READY\s*$') {
      Restore-PreviousProviderConfig
      throw '模型 API 已响应但健康检查结果异常，已恢复上一版配置。'
    }
    Write-Host '[OK] 模型 API 调用验证通过'
  } finally {
    Remove-Item -Force $probePath -ErrorAction SilentlyContinue
  }
}

function Ensure-ProjectRuntime {
  $tsx = Join-Path $RepositoryRoot 'node_modules\.bin\tsx.cmd'
  if (-not (Test-Path $tsx)) {
    Write-Host '[安装] 正在安装 Auto-Test 项目依赖……'
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Auto-Test 项目依赖安装失败。' }
  }

  $browserReady = $false
  try {
    & node -e "const fs=require('fs'); const p=require('@playwright/test').chromium.executablePath(); process.exit(fs.existsSync(p)?0:1)"
    $browserReady = $LASTEXITCODE -eq 0
  } catch {
    $browserReady = $false
  }
  if (-not $browserReady) {
    Write-Host '[安装] 正在安装 Chromium 浏览器……'
    & npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Chromium 安装失败。' }
  }
  Write-Host '[OK] Auto-Test 项目依赖和浏览器已就绪'
}

try {
  $setupOnly = $AutoTestArgs -contains '--setup-only'
  $reconfigureApi = $AutoTestArgs -contains '--reconfigure-api'
  $forwardArgs = @($AutoTestArgs | Where-Object { $_ -ne '--setup-only' -and $_ -ne '--reconfigure-api' })
  Ensure-Node
  Ensure-CodexCli
  Ensure-ApiProvider -ForcePrompt:$reconfigureApi
  Test-CodexProvider
  Ensure-ProjectRuntime

  if ($setupOnly) {
    Write-Host ''
    Write-Host 'Auto-Test 自动安装和 API 配置已完成。'
    exit 0
  }

  if ($forwardArgs.Count -eq 0) {
    & npm run easy
  } else {
    & npm run easy -- @forwardArgs
  }
  exit $LASTEXITCODE
} catch {
  Write-Host ''
  Write-Host "自动准备失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
