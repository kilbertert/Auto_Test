param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $AutoTestArgs
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
try {
  Add-Type -AssemblyName System.Security -ErrorAction Stop
} catch {
  Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop
}

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepositoryRoot

$NodeVersion = '24.15.0'
$CodexVersion = '0.146.0'
$ProviderId = 'auto_test_api'
$ProviderName = 'Auto-Test Model API'
$ProviderKeyEnvironment = 'AUTO_TEST_MODEL_API_KEY'
$LegacyProviderId = 'cliproxyapi'
$BootstrapSecretFileName = 'Auto-Test.private-key'
$BootstrapProviderFileName = 'Auto-Test.private-provider.json'
$script:ApiConfigurationChanged = $false
$script:ProviderConfigPath = ''
$script:ProviderSecretPath = ''
$script:BootstrapSecretPath = ''
$script:BootstrapProviderPath = ''
$script:BootstrapSecretUsed = $false
$script:BootstrapProviderUsed = $false
$script:PreviousConfigExists = $false
$script:PreviousConfigContent = ''
$script:PreviousSecretExists = $false
$script:PreviousSecretContent = ''
$script:NodeExecutable = ''
$script:NpmCliPath = ''

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

function Use-NodeRuntime([string] $NodeHome) {
  $nodeExecutable = Join-Path $NodeHome 'node.exe'
  $npmCliPath = Join-Path $NodeHome 'node_modules\npm\bin\npm-cli.js'
  if (-not (Test-Path $nodeExecutable)) { throw 'Auto-Test 独立 Node.js 缺少 node.exe。' }
  if (-not (Test-Path $npmCliPath)) { throw 'Auto-Test 独立 Node.js 缺少 npm CLI。' }
  $env:Path = "$NodeHome;$env:Path"
  $script:NodeExecutable = $nodeExecutable
  $script:NpmCliPath = $npmCliPath
}

function Ensure-Node {
  $toolsHome = Resolve-ToolsHome
  $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $archiveStem = "node-v$NodeVersion-win-$architecture"
  $nodeHome = Join-Path $toolsHome $archiveStem
  $nodeExecutable = Join-Path $nodeHome 'node.exe'
  if ((Get-NodeVersion $nodeExecutable) -eq $NodeVersion) {
    Use-NodeRuntime $nodeHome
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
  Use-NodeRuntime $nodeHome
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
  $codexCommand = Join-Path $toolsHome 'node_modules\.bin\codex.cmd'
  $targetTriple = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
  $platformPackage = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'codex-win32-arm64' } else { 'codex-win32-x64' }
  $codexExecutable = Join-Path $toolsHome "node_modules\@openai\$platformPackage\vendor\$targetTriple\bin\codex.exe"
  $installed = Get-CodexVersion $codexCommand
  if ($installed -eq $CodexVersion) {
    if (-not (Test-Path $codexExecutable)) { throw 'Codex CLI 缺少 Windows 原生 codex.exe。' }
    $env:Path = "$(Split-Path -Parent $codexCommand);$env:Path"
    $env:AUTO_TEST_CODEX_BIN = $codexExecutable
    Write-Host "[OK] Codex CLI $installed"
    return
  }

  Write-Host "[安装] 正在为 Auto-Test 安装独立 Codex CLI $CodexVersion……"
  New-Item -ItemType Directory -Force -Path $toolsHome | Out-Null
  & $script:NodeExecutable $script:NpmCliPath install --prefix $toolsHome "@openai/codex@$CodexVersion" --no-save --no-package-lock --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { throw 'Codex CLI 安装失败。请检查 npm 网络或代理配置。' }
  $env:Path = "$(Split-Path -Parent $codexCommand);$env:Path"
  $env:AUTO_TEST_CODEX_BIN = $codexExecutable
  $installed = Get-CodexVersion $codexCommand
  if (-not (Test-Path $codexExecutable)) { throw 'Codex CLI 安装后缺少 Windows 原生 codex.exe。' }
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

function Protect-Secret([string] $Value) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Value)
  $entropy = [Text.UTF8Encoding]::new($false).GetBytes('Auto-Test Model API Key v1')
  $protected = $null
  try {
    $protected = [Security.Cryptography.ProtectedData]::Protect(
      $bytes,
      $entropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    return [Convert]::ToBase64String($protected)
  } finally {
    if ($bytes.Length -gt 0) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($entropy.Length -gt 0) { [Array]::Clear($entropy, 0, $entropy.Length) }
    if ($protected -and $protected.Length -gt 0) { [Array]::Clear($protected, 0, $protected.Length) }
  }
}

function Unprotect-Secret([string] $Value) {
  $protected = [Convert]::FromBase64String($Value)
  $entropy = [Text.UTF8Encoding]::new($false).GetBytes('Auto-Test Model API Key v1')
  $bytes = $null
  try {
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect(
      $protected,
      $entropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    return [Text.UTF8Encoding]::new($false).GetString($bytes)
  } finally {
    if ($protected.Length -gt 0) { [Array]::Clear($protected, 0, $protected.Length) }
    if ($entropy.Length -gt 0) { [Array]::Clear($entropy, 0, $entropy.Length) }
    if ($bytes -and $bytes.Length -gt 0) { [Array]::Clear($bytes, 0, $bytes.Length) }
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

function Ensure-ApiProvider([switch] $ForcePrompt, [string] $ApiKeyOverride) {
  $hasApiKeyOverride = -not [string]::IsNullOrWhiteSpace($ApiKeyOverride)
  if ($hasApiKeyOverride -and $ApiKeyOverride -match '\s') {
    throw '临时 API Key 不能包含空白字符。'
  }
  $codexHome = Resolve-CodexHome
  New-Item -ItemType Directory -Force -Path $codexHome | Out-Null
  $env:CODEX_HOME = $codexHome
  $env:AUTO_TEST_CODEX_HOME = $codexHome
  $env:AUTO_TEST_CODEX_ENV_KEY = $ProviderKeyEnvironment

  $configPath = Join-Path $codexHome 'config.toml'
  $secretPath = Join-Path $codexHome 'provider-key.dpapi'
  $bootstrapSecretPath = Join-Path $RepositoryRoot $BootstrapSecretFileName
  $bootstrapProviderPath = Join-Path $RepositoryRoot $BootstrapProviderFileName
  $script:ProviderConfigPath = $configPath
  $script:ProviderSecretPath = $secretPath
  $script:BootstrapSecretPath = $bootstrapSecretPath
  $script:BootstrapProviderPath = $bootstrapProviderPath
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
  if (-not $ForcePrompt -and (Test-Path $bootstrapProviderPath)) {
    try {
      $bootstrapProvider = Get-Content -Raw -Encoding UTF8 $bootstrapProviderPath | ConvertFrom-Json
    } catch {
      throw '私有安装包中的模型 Provider 配置不是有效 JSON。'
    }
    if (-not $baseUrl) { $baseUrl = [string] $bootstrapProvider.baseUrl }
    if (-not $model) { $model = [string] $bootstrapProvider.model }
    $script:BootstrapProviderUsed = $true
  }
  $apiKey = [Environment]::GetEnvironmentVariable($ProviderKeyEnvironment, 'Process')
  $apiKeyFromProcess = -not [string]::IsNullOrWhiteSpace($apiKey)
  if (-not $apiKeyFromProcess) { $apiKey = '' }
  $apiKeyFromBootstrap = $false
  if (-not $ForcePrompt -and (Test-Path $bootstrapSecretPath)) {
    $apiKey = (Get-Content -Raw -Encoding UTF8 $bootstrapSecretPath).Trim()
    if ([string]::IsNullOrWhiteSpace($apiKey)) { throw '私有安装包中的模型 API Key 为空。' }
    $apiKeyFromBootstrap = $true
    $script:BootstrapSecretUsed = $true
  }
  $apiKeyLoadedFromDpapi = $false
  if (-not $ForcePrompt -and $providerReady -and -not $apiKey -and (Test-Path $secretPath)) {
    try {
      $encrypted = Get-Content -Raw -Encoding UTF8 $secretPath
      try {
        $apiKey = Unprotect-Secret $encrypted.Trim()
      } catch {
        $apiKey = Convert-SecureText (ConvertTo-SecureString $encrypted.Trim())
      }
      $apiKeyLoadedFromDpapi = $true
    } catch {
      throw '已保存的 API Key 无法由当前 Windows 用户解密，请使用 --reconfigure-api 重新配置。'
    }
  }
  $defaultApiKey = $apiKey
  $script:ApiConfigurationChanged = $ForcePrompt -or $legacyProvider -or $apiKeyFromBootstrap -or $script:BootstrapProviderUsed -or -not $providerReady -or
    $apiKeyFromProcess -or -not $apiKeyLoadedFromDpapi -or $hasApiKeyOverride
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
    Write-Host '       正在自动改用内置的直连模型 API，不需要暴露 Auto-Test 服务器。'
  }

  if ($hasApiKeyOverride) {
    $apiKey = $ApiKeyOverride
    Write-Host '[配置] 本次启动使用临时 API Key；默认 Key 不会被替换。'
  }

  if (-not $baseUrl -and $providerReady -and $existingBaseUrl) {
    $baseUrl = $existingBaseUrl
  }
  if (-not $model -and $providerReady -and $existingModel) {
    $model = $existingModel
  }
  if (-not $baseUrl) {
    if ([Console]::IsInputRedirected) {
      throw '缺少模型 API Base URL。请设置 AUTO_TEST_CODEX_BASE_URL，或使用包含私有 Provider 配置的安装包。'
    }
    $baseUrl = (Read-Host 'API Base URL').Trim()
  }
  if (-not (Test-HttpUrl $baseUrl)) { throw "API Base URL 无效：$baseUrl" }

  if (-not $model) {
    if ([Console]::IsInputRedirected) {
      throw '缺少模型 ID。请设置 AUTO_TEST_CODEX_MODEL，或使用包含私有 Provider 配置的安装包。'
    }
    $model = (Read-Host '模型 ID').Trim()
  }
  if ([string]::IsNullOrWhiteSpace($model) -or $model -match '[\r\n]') {
    throw '模型 ID 无效。'
  }

  $keyProvidedNow = if ($hasApiKeyOverride) { $apiKeyFromBootstrap } else { $apiKeyFromProcess -or $apiKeyFromBootstrap }
  if (-not $apiKey) {
    if ([Console]::IsInputRedirected) {
      throw '当前是公开源码包，没有包含私有模型 API Key。请使用内部私有 Windows 安装包。'
    }
    $secureKey = Read-Host 'API Key（公开源码包首次使用时需要；输入过程不会显示）' -AsSecureString
    $apiKey = Convert-SecureText $secureKey
    if ([string]::IsNullOrWhiteSpace($apiKey)) { throw 'API Key 不能为空。' }
    $keyProvidedNow = $true
  }
  if ($keyProvidedNow) {
    $keyToPersist = if ($hasApiKeyOverride -and $apiKeyFromBootstrap) { $defaultApiKey } else { $apiKey }
    if ($env:AUTO_TEST_PERSIST_API_KEY -eq '0') {
      Remove-Item -Force $secretPath -ErrorAction SilentlyContinue
    } else {
      $encrypted = Protect-Secret $keyToPersist
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

function Complete-BootstrapImport {
  $removed = $false
  if ($script:BootstrapSecretUsed -and $script:BootstrapSecretPath) {
    Remove-Item -Force $script:BootstrapSecretPath -ErrorAction Stop
    $removed = $true
  }
  if ($script:BootstrapProviderUsed -and $script:BootstrapProviderPath) {
    Remove-Item -Force $script:BootstrapProviderPath -ErrorAction Stop
    $removed = $true
  }
  if ($removed) { Write-Host '[OK] 私有模型配置已导入当前 Windows 用户并清除引导文件' }
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

function Parse-ApiKeyOverride([string[]] $Arguments) {
  $remaining = [Collections.Generic.List[string]]::new()
  $apiKey = ''
  for ($index = 0; $index -lt $Arguments.Count; $index++) {
    $argument = [string] $Arguments[$index]
    if ($argument -eq '--api-key') {
      if ($index + 1 -ge $Arguments.Count) { throw '--api-key 缺少值。' }
      $index++
      $candidate = [string] $Arguments[$index]
      if ([string]::IsNullOrWhiteSpace($candidate) -or $candidate.StartsWith('-')) { throw '--api-key 的值无效。' }
      if ($apiKey) { throw '--api-key 只能指定一次。' }
      $apiKey = $candidate
      continue
    }
    if ($argument.StartsWith('--api-key=')) {
      $candidate = $argument.Substring('--api-key='.Length)
      if ([string]::IsNullOrWhiteSpace($candidate) -or $candidate.StartsWith('-')) { throw '--api-key 的值无效。' }
      if ($apiKey) { throw '--api-key 只能指定一次。' }
      $apiKey = $candidate
      continue
    }
    $remaining.Add($argument)
  }
  [pscustomobject]@{
    ApiKey = $apiKey
    Arguments = @($remaining)
  }
}

function Get-CodexProbeFailureHint([string] $Output, [int] $ExitCode) {
  if ($Output -match '(?i)\b401\b|unauthorized|invalid[^\r\n]*api[^\r\n]*key|api[_ -]?key[^\r\n]*disabled') {
    return 'API Key 被模型服务拒绝。'
  }
  if ($Output -match '(?i)\b403\b|forbidden') {
    return '模型服务拒绝了当前 Key 的访问权限。'
  }
  if ($Output -match '(?i)\b429\b|rate.?limit|quota|insufficient[^\r\n]*credit') {
    return '模型服务额度不足或请求频率受限。'
  }
  if ($Output -match '(?i)\b404\b|model[^\r\n]*(not found|does not exist|unsupported)') {
    return '模型 ID 不存在或当前 API 不支持该模型。'
  }
  if ($Output -match '(?i)dns|resolve|connection|connect|certificate|tls|timed? out|timeout') {
    return '无法连接模型 API，请检查 Windows 网络、代理、DNS 或 TLS。'
  }
  return "Codex CLI 返回退出码 $ExitCode。"
}

function Get-CodexProbeTimeoutSeconds {
  if (-not $env:AUTO_TEST_CODEX_PROBE_TIMEOUT_SECONDS) { return 120 }
  $timeoutSeconds = 0
  if (-not [int]::TryParse($env:AUTO_TEST_CODEX_PROBE_TIMEOUT_SECONDS, [ref] $timeoutSeconds) -or
      $timeoutSeconds -lt 1 -or $timeoutSeconds -gt 3600) {
    throw 'AUTO_TEST_CODEX_PROBE_TIMEOUT_SECONDS 必须是 1 到 3600 的整数秒。'
  }
  return $timeoutSeconds
}

function ConvertTo-NativeArgument([string] $Value) {
  if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Start-CodexProbeProcess([string] $Executable) {
  $arguments = @(
    'exec',
    'Reply with exactly AUTO_TEST_API_READY.',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--color',
    'never',
    '-C',
    $RepositoryRoot
  )
  $argumentLine = (($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
  $processExecutable = $Executable
  $processArguments = $argumentLine
  if ([IO.Path]::GetExtension($Executable) -match '(?i)^\.(cmd|bat)$') {
    $processExecutable = $env:ComSpec
    $processArguments = "/d /s /c `"`"$Executable`" $argumentLine`""
  }
  # Native Process APIs preserve the real exit code on Windows PowerShell 5.1.
  # Read both streams asynchronously so neither pipe can block the probe process.
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $processExecutable
  $startInfo.Arguments = $processArguments
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    $process.Start() | Out-Null
    return [pscustomobject]@{
      Process = $process
      StandardOutput = $process.StandardOutput.ReadToEndAsync()
      StandardError = $process.StandardError.ReadToEndAsync()
    }
  } catch {
    $process.Dispose()
    throw
  }
}

function Wait-CodexProbeProcess([Diagnostics.Process] $Process, [int] $TimeoutSeconds) {
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  $nextHeartbeatSeconds = 20
  while ($stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    $remainingMilliseconds = [int] [Math]::Ceiling(($TimeoutSeconds - $stopwatch.Elapsed.TotalSeconds) * 1000)
    $waitMilliseconds = [Math]::Max(1, [Math]::Min(1000, $remainingMilliseconds))
    if ($Process.WaitForExit($waitMilliseconds)) {
      $Process.WaitForExit()
      return $true
    }
    if ($stopwatch.Elapsed.TotalSeconds -ge $nextHeartbeatSeconds) {
      $elapsedSeconds = [int] [Math]::Floor($stopwatch.Elapsed.TotalSeconds)
      Write-Host "[检查] 模型 API 仍在响应中（已等待 $elapsedSeconds 秒，最多 $TimeoutSeconds 秒）……"
      $nextHeartbeatSeconds += 20
    }
  }
  return $Process.HasExited
}

function Stop-CodexProbeProcess([Diagnostics.Process] $Process) {
  if ($Process.HasExited) { return }
  $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  if (Test-Path $taskkill) {
    try { & $taskkill /PID $Process.Id /T /F *> $null } catch {}
  }
  if (-not $Process.HasExited) {
    try { $Process.Kill() } catch {}
  }
  try { $Process.WaitForExit(5000) | Out-Null } catch {}
}

function Test-CodexProvider {
  if (-not $script:ApiConfigurationChanged -or $env:AUTO_TEST_SKIP_API_PROBE -eq '1') { return }
  $codexExecutable = if ($env:AUTO_TEST_CODEX_PROBE_BIN) { $env:AUTO_TEST_CODEX_PROBE_BIN } else { $env:AUTO_TEST_CODEX_BIN }
  if (-not $codexExecutable -or -not (Test-Path $codexExecutable)) { throw '找不到 Auto-Test 私有 Codex CLI。' }
  $probeInvocation = $null
  $probeProcess = $null
  try {
    try {
      $timeoutSeconds = Get-CodexProbeTimeoutSeconds
      Write-Host "[检查] 正在验证模型 API 地址、Key 和模型可用性（最多等待 $timeoutSeconds 秒）……"
      try {
        $probeInvocation = Start-CodexProbeProcess $codexExecutable
        $probeProcess = $probeInvocation.Process
      } catch {
        throw "无法启动模型 API 探针：$($_.Exception.Message)"
      }
      if (-not (Wait-CodexProbeProcess $probeProcess $timeoutSeconds)) {
        Stop-CodexProbeProcess $probeProcess
        throw "模型 API 探针在 $timeoutSeconds 秒内未完成，已终止卡住的 Codex 进程。请检查模型服务、Windows 网络、代理或流式响应稳定性；仅在网关确实较慢时调整 AUTO_TEST_CODEX_PROBE_TIMEOUT_SECONDS。"
      }
      $probeExitCode = $probeProcess.ExitCode
      $standardOutput = $probeInvocation.StandardOutput.GetAwaiter().GetResult()
      $standardError = $probeInvocation.StandardError.GetAwaiter().GetResult()
      $probe = @($standardOutput, $standardError) -join [Environment]::NewLine
      if ($probeExitCode -ne 0) {
        $hint = Get-CodexProbeFailureHint $probe $probeExitCode
        throw "模型 API 探针失败。$hint"
      }
      if ($probe -notmatch '(?m)^\s*AUTO_TEST_API_READY\s*$') {
        throw '模型 API 已响应但健康检查结果异常。'
      }
      Write-Host '[OK] 模型 API 调用验证通过'
    } catch {
      Restore-PreviousProviderConfig
      throw "$($_.Exception.Message) 已恢复上一版配置。"
    }
  } finally {
    if ($probeInvocation -and $probeProcess -and $probeProcess.HasExited) {
      try { $probeInvocation.StandardOutput.GetAwaiter().GetResult() | Out-Null } catch {}
      try { $probeInvocation.StandardError.GetAwaiter().GetResult() | Out-Null } catch {}
    }
    if ($probeProcess) { $probeProcess.Dispose() }
  }
}

function Get-PlaywrightDownloadHosts {
  $configuredHost = $env:AUTO_TEST_PLAYWRIGHT_DOWNLOAD_HOST
  if (-not $configuredHost) { $configuredHost = $env:PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST }
  if (-not $configuredHost) { $configuredHost = $env:PLAYWRIGHT_DOWNLOAD_HOST }
  if ($configuredHost) { return @($configuredHost.TrimEnd('/')) }

  # The mirror is substantially faster for the default Windows deployment region;
  # an empty entry keeps the official Playwright CDN as a deterministic fallback.
  return @('https://npmmirror.com/mirrors/playwright', '')
}

function Restore-EnvironmentVariable([string] $Name, [string] $PreviousValue) {
  if ($null -eq $PreviousValue) {
    Remove-Item "Env:$Name" -ErrorAction SilentlyContinue
  } else {
    Set-Item "Env:$Name" $PreviousValue
  }
}

function Install-PlaywrightChromium {
  $playwrightCli = Join-Path $RepositoryRoot 'node_modules\@playwright\test\cli.js'
  if (-not $script:NodeExecutable -or -not (Test-Path $script:NodeExecutable)) {
    throw '找不到 Auto-Test 独立 Node.js，无法安装 Chromium。'
  }
  if (-not (Test-Path $playwrightCli)) {
    throw '找不到项目内的 Playwright CLI，请重新运行 Auto-Test 安装。'
  }
  $previousDownloadHost = [Environment]::GetEnvironmentVariable('PLAYWRIGHT_DOWNLOAD_HOST', 'Process')
  $previousChromiumDownloadHost = [Environment]::GetEnvironmentVariable('PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST', 'Process')
  $previousConnectionTimeout = [Environment]::GetEnvironmentVariable('PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT', 'Process')
  $hosts = @(Get-PlaywrightDownloadHosts)
  $lastExitCode = 1
  try {
    foreach ($downloadHost in $hosts) {
      if ($downloadHost) {
        $env:PLAYWRIGHT_DOWNLOAD_HOST = $downloadHost
        $env:PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST = $downloadHost
        Write-Host "[安装] 正在通过 $downloadHost 下载 Chromium 浏览器……"
      } else {
        Remove-Item Env:PLAYWRIGHT_DOWNLOAD_HOST -ErrorAction SilentlyContinue
        Remove-Item Env:PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST -ErrorAction SilentlyContinue
        Write-Host '[重试] 镜像下载失败，回退 Playwright 官方 CDN……'
      }
      if (-not $env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT) {
        $env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT = '120000'
      }

      $previousErrorActionPreference = $ErrorActionPreference
      try {
        # Invoke the project CLI with the pinned portable Node runtime. This avoids
        # npm.ps1/npx.ps1 prefix discovery failures on otherwise clean Windows hosts.
        $ErrorActionPreference = 'Continue'
        & $script:NodeExecutable $playwrightCli install chromium
        $lastExitCode = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }
      if (Test-PlaywrightChromiumReady) {
        if ($lastExitCode -ne 0) {
          Write-Host "[OK] Chromium 文件已验证可用（安装命令退出码：$lastExitCode）"
        }
        return
      }
      Write-Host "[提示] Playwright 安装命令退出码：$lastExitCode，且尚未找到可用的 Chromium。"
    }
  } finally {
    Restore-EnvironmentVariable 'PLAYWRIGHT_DOWNLOAD_HOST' $previousDownloadHost
    Restore-EnvironmentVariable 'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST' $previousChromiumDownloadHost
    Restore-EnvironmentVariable 'PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT' $previousConnectionTimeout
  }
  throw 'Chromium 安装失败。请检查网络，或设置 AUTO_TEST_PLAYWRIGHT_DOWNLOAD_HOST 后重试。'
}

function Test-PlaywrightChromiumReady {
  if (-not $script:NodeExecutable -or -not (Test-Path $script:NodeExecutable)) { return $false }
  $browserCheck = Join-Path $RepositoryRoot 'scripts\check-playwright-browser.cjs'
  if (-not (Test-Path $browserCheck)) { return $false }
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $checkOutput = (& $script:NodeExecutable $browserCheck 2>&1 | Out-String).Trim()
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($checkOutput -match '(?m)^AUTO_TEST_CHROMIUM_READY\s*$') { return $true }
  if ($checkOutput) { Write-Host $checkOutput }
  return $false
}

function Ensure-ProjectRuntime {
  $tsx = Join-Path $RepositoryRoot 'node_modules\.bin\tsx.cmd'
  if (-not (Test-Path $tsx)) {
    Write-Host '[安装] 正在安装 Auto-Test 项目依赖……'
    & $script:NodeExecutable $script:NpmCliPath ci
    if ($LASTEXITCODE -ne 0) { throw 'Auto-Test 项目依赖安装失败。' }
  }

  $browserReady = Test-PlaywrightChromiumReady
  if (-not $browserReady) {
    Install-PlaywrightChromium
    if (-not (Test-PlaywrightChromiumReady)) {
      throw 'Chromium 安装命令已结束，但没有找到可用的浏览器文件。'
    }
  }
  Write-Host '[OK] Auto-Test 项目依赖和浏览器已就绪'
}

try {
  $parsedApiKey = Parse-ApiKeyOverride $AutoTestArgs
  $setupOnly = $parsedApiKey.Arguments -contains '--setup-only'
  $reconfigureApi = $parsedApiKey.Arguments -contains '--reconfigure-api'
  if ($reconfigureApi -and $parsedApiKey.ApiKey) {
    throw '--api-key 不能和 --reconfigure-api 同时使用；临时 Key 不会覆盖默认配置。'
  }
  $forwardArgs = @($parsedApiKey.Arguments | Where-Object { $_ -ne '--setup-only' -and $_ -ne '--reconfigure-api' })
  Ensure-Node
  Ensure-CodexCli
  Ensure-ApiProvider -ForcePrompt:$reconfigureApi -ApiKeyOverride $parsedApiKey.ApiKey
  Test-CodexProvider
  Complete-BootstrapImport
  Ensure-ProjectRuntime

  if ($setupOnly) {
    Write-Host ''
    Write-Host 'Auto-Test 自动安装和 API 配置已完成。'
    exit 0
  }

  if ($forwardArgs.Count -eq 0) {
    & $script:NodeExecutable $script:NpmCliPath run easy
  } else {
    & $script:NodeExecutable $script:NpmCliPath run easy -- @forwardArgs
  }
  exit $LASTEXITCODE
} catch {
  Write-Host ''
  Write-Host "自动准备失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
