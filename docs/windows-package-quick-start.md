# Windows 私有包快速打包

这份文档是 Windows 私有包打包的唯一操作入口。它解决的是在 Linux/WSL 构建一个可复制到 Windows 的零输入 ZIP；Windows 上只负责解压、启动和验收，不需要安装 Git、Node.js 或 npm。

## 适用前提

- 在 Auto-Test 仓库的 Linux/WSL 工作副本中执行。
- 已切换到准备交付的 Git 提交。
- 模型 API Key 可用；Base URL 和模型默认是 `https://api.deepseek.com` 与 `deepseek-v4-flash`，其他 Provider 需显式覆盖。
- 工作树必须干净。脚本会拒绝从未提交改动构建。

公开仓库和公开 Release 不含 API Key。私有 ZIP 是敏感凭据载体，只能点对点交付；不要提交 Git、上传 GitHub、网盘或公开制品库。

## 推荐：一条命令完成

先进入仓库并确认版本：

~~~bash
cd /path/to/Auto-Test
git fetch --prune origin
git switch main
git pull --ff-only origin main
git status --short
git rev-parse --short HEAD
~~~

工作树必须没有输出。然后运行交互式快速脚本：

~~~bash
bash scripts/build-private-windows-package-quick.sh
~~~

脚本会显示默认 DeepSeek Base URL 和模型 ID；直接按回车即可接受，也可输入其他值覆盖，然后隐藏输入 API Key。完成后会输出 ZIP 绝对路径和 SHA-256。

默认输出目录：

~~~text
artifacts/private-release/
~~~

包名格式为 Auto-Test-Windows-private-<commit>.zip，其中 commit 是构建时 HEAD 的短提交号。

## 非交互构建

适合脚本或重复构建，但不要把真实 Key 写进命令历史：

~~~bash
read -r -s -p "API Key: " key
echo
printf '%s' "$key" | \
  bash scripts/build-private-windows-package.sh
unset key
~~~

上例生成默认 DeepSeek 包。构建其他 Provider 时，为同一命令设置 `AUTO_TEST_MODEL_BASE_URL` 和 `AUTO_TEST_MODEL_ID`；旧的 `AUTO_TEST_CODEX_BASE_URL` / `AUTO_TEST_CODEX_MODEL` 只保留兼容。底层脚本还会校验 zip 命令、干净工作树和必需参数。

## 复制到 Windows

1. 只复制生成的 ZIP，不要复制整个 Git 仓库。
2. 通过受控方式传到 Windows。
3. 在本地短路径解压，例如 D:\Auto-Test；不要直接在 ZIP、OneDrive、共享盘或 Program Files 中运行。
4. 双击 Auto-Test.cmd。首次启动会安装便携 Node.js、Codex CLI、依赖和 Chromium，并把一次性 API Key 导入当前 Windows 用户的 DPAPI。
5. 首次启动成功后，解压目录中的明文引导文件会被删除；ZIP 原文件仍可能包含 Key，验收完成后按公司安全要求处理。

## Windows 启动层验收

在 PowerShell 中执行：

~~~powershell
Set-Location D:\Auto-Test
.\Auto-Test.cmd --setup-only
.\Auto-Test.cmd doctor
~~~

默认 Codex 路径只有 Node.js、Codex CLI、Windows 默认 Provider/API 和 Chromium 均通过，才进入业务测试。OMP 或显式 Model Profile 不运行无关的 Codex 默认探针，必须用对应 AgentHost 的真实 canary 验证 Provider。任何启动层通过都不代表业务用例通过。

## 业务验收

推荐使用固定输出目录，并先跑一条安全 canary：

~~~powershell
$Cases = "D:\TestData\cases.xlsx"
$Profile = "acceptance-test"
$Run = "D:\Auto-Test-results\acceptance-$(Get-Date -Format yyyyMMdd-HHmmss)"

.\Auto-Test.cmd run `
  --file $Cases `
  --profile $Profile `
  --output-dir $Run `
  --headed `
  --one
~~~

Excel、同名 .auto-test sidecar 和必要 URL 必须一起交付；它们共同决定本轮 manifest。测试结束后，以 codex-agent.result.json、实际证据和 Mutation Ledger 为准。若验收 Codex/OMP 竞争，必须为两个宿主使用不同输出目录，再用 `npm run agent:compare` 只读比较，不能在同一业务实体上盲目重复破坏性操作。

构建脚本还会把不含密钥的 `Auto-Test.build.json` 写入私有 ZIP，运行结果会据此记录包版本和构建 commit；在没有该元数据的源码运行中，框架会尽力从 `package.json` 和 Git 读取版本，读取不到时不会伪造 commit。

## 常见失败

| 现象 | 处理 |
|---|---|
| 工作树存在未提交改动 | 提交当前改动，或从同一提交创建干净 worktree 后再构建；不要绕过检查。 |
| 缺少 zip 命令 | 在 Linux/WSL 安装 zip，然后重新运行脚本。 |
| `doctor` 显示默认 Profile 缺少环境变量 | 你拿到的是公开源码包，或私有 Provider 引导材料未正确导入；设置 Profile 的 `envKey`，或重新从本页流程构建。 |
| Provider 探针失败 | 先处理 API 地址、模型、Key、网络或额度；这属于启动层问题。 |
| 业务运行 blocked | 查看失败位置、原因类别、建议操作、Ledger 和证据路径；按验收清单恢复。 |

## 其他文档

- [Windows 快速操作指南](windows-quick-start.md)：安装原理、日常菜单、Provider 轮换和高级命令；不重复完整打包流程。
- [Windows 从零验收清单](windows-acceptance-runbook.md)：从已生成私有 ZIP 开始的真实业务验收。
- [跨场景自动化测试快速指南](quick-start.md)：输入包、运行语义和结果合同。
