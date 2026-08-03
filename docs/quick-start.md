# Codex-native 跨场景测试快速指南

默认流程是：

`Excel Intake -> 环境与认证 -> 持久 Codex 线程 -> 页面探索与动态计划 -> 执行与断言 -> 恢复 -> 结构化结果`

测试工程师不需要编写 Execution Plan。Codex 在同一线程里根据实际页面证据持续修订工作计划，并直接使用 Playwright MCP 操作网站。旧 IR/Runtime 只有显式加入 `--legacy-runtime` 时才启用。

## 1. 首次准备

```bash
npm ci
npx playwright install chromium
npm run check
```

还需要一个可工作的 Codex CLI Provider。Windows 私有包会自动安装固定版本 Codex CLI、配置 Provider 并验证最小请求；Linux/macOS 复用当前用户已经可用的 Codex 配置。Windows 私有包的构建流程统一见[Windows 私有包快速打包](windows-package-quick-start.md)。

## 2. 注册测试环境

日常推荐运行：

```bash
npm run easy
```

选择“注册或更新测试环境”，登记所有可能访问的网站、登录会话和本环境允许的最高风险：

- `read`：只读查看和断言；
- `write`：允许新增、修改、提交、启动等操作；
- `destructive`：还允许对授权测试数据执行删除、停止、结算或回滚。

登录成功后的 Cookie、LocalStorage、IndexedDB 和 SessionStorage 保存在当前用户私有目录。环境只需注册一次，登录失效时再更新。

## 3. 准备 Excel

支持标准测试用例表和“阶段标题 + 详细说明”的流程表。用例至少应明确：

- 操作步骤；
- 可观察的预期结果；
- 测试数据与业务实体匹配规则；
- 写入后的保留或清理要求；
- 必要 URL、账号角色、权限和外部前置条件。

URL 可以通过运行参数提供，也可以写在 Excel 单元格中。Excel 内嵌图片和同名 `.auto-test/images/` 目录中的补充图片会作为视觉输入交给同一 Codex 线程。

默认完整 Agent 模式会把原始 Excel 和本轮 Environment Profile 测试值复制到权限受限的 run 工作区，让 Codex 能直接理解和转换业务数据。它们不会进入 Git。需要旧的 alias-only 行为时使用 `--opaque-test-data`。

## 4. 执行

交互菜单选择“开始一次新测试”，或运行：

```bash
npm run easy -- run \
  --file /private/cases.xlsx \
  --url https://app.example.test/ \
  --url https://admin.example.test/ \
  --profile staging \
  --headed \
  --slow-mo 150 \
  --one
```

直接调用底层入口：

```bash
npm run agent:test -- \
  --file /private/cases.xlsx \
  --profile staging \
  --output-dir artifacts/runs/example
```

常用选项：

- `--image <path>`：补充截图，可重复；
- `--brief <path>`：不含秘密的业务补充说明；
- `--model <id>`：覆盖当前 Provider 的默认模型；
- `--max-iterations <N>`：列表型数据先执行 N 条 canary；
- `--headed` / `--headless`：显示或隐藏浏览器。

## 5. 运行机制

每次运行使用独立 Codex Home 和可写 Agent 工作区。默认向同一个 Codex thread 提供：

- 原始 Excel、说明、图片和本轮测试值；
- shell、临时脚本、网络和 Web Search；
- 完整 Playwright MCP，包括页面 JavaScript、网络、视觉和 Playwright 代码执行；
- 可选 Auto-Test Control MCP 日志和 Mutation Ledger。

Codex 自己决定工作计划和执行方式。对于需要中断恢复的外部业务写入，应以完整业务操作为单位登记 Mutation；普通导航、读取和字段输入不需要登记。仍有 pending Mutation 时，结果必定是 `blocked`。

## 6. 结果

主要文件：

- `codex-agent.state.json`：运行状态、Codex 线程 ID 和结果路径；
- `codex-agent.result.json`：`passed`、`product_failed` 或 `blocked` 的结构化交付；
- `codex-agent.events.jsonl`：脱敏后的 Codex 事件；
- `agent-workspace/input/`：原始测试材料和本轮输入；
- Codex 在 `agent-workspace/` 内创建的临时脚本、计划和证据记录；
- `.agent-private/mutation-ledger.json`：私有 Mutation Ledger；
- `agent-workspace/evidence/`：截图、快照、网络和控制台证据。

终态含义：

- `passed`：所有用例、断言和最终状态均已验证通过；
- `product_failed`：操作完成，但测试工程师定义的业务预期未成立；
- `blocked`：缺少数据、权限、认证、恢复能力，或模型/MCP/浏览器等执行依赖不可用；
- `failed`：未知框架编程异常，没有被误分类为业务阻断。

模型、网络、浏览器或 MCP 在执行中断后，使用相同 Excel、URL、环境 Profile 和原输出目录显式恢复：

```bash
npm run easy -- run \
  --file /private/cases.xlsx \
  --profile staging \
  --output-dir artifacts/runs/interrupted-run \
  --resume
```

恢复会复用原 Codex thread、原始材料副本、工作区脚本、证据和 Mutation Ledger，只重建浏览器与 MCP 进程。框架会校验工作流来源哈希、环境身份和权限策略；任何不一致都会 fail closed。恢复 Agent 必须先重新观察 pending Mutation 的真实业务状态，不会把浏览器断线当成重复写操作的理由。不要删除 Ledger、改换输出目录或放宽预期结果来规避阻断。

## 7. 当前验收状态

以下已经通过确定性验证：Excel/图片 Intake、URL 自动发现、环境选择、认证刷新、Storage State 合并、原始材料和 run-values 工作区、完整与受限两种 Agent 配置、持久线程恢复、Codex 直接结构化结果校验、Mutation Ledger、Windows 启动器、Linux Verify 和 Windows Verify。

2026-08-03，基于 `c94ad77` 的最终 thin harness Windows 私有包使用充电 Excel、测试 URL 和一次 Environment Profile 注册完成真实业务 canary：同一个 Codex thread 自主执行 3/3 manifest case 和 7 组测试数据，记录 26 条 Mutation Ledger 且 pending 为 0，生成 129 个证据文件，最终结果为 `passed`。运行中的模型重连和页面工具错误由同一 thread 恢复，没有人工编辑 Execution Plan。

本轮 manifest 加载了 Excel 的 6 张内嵌图片，但没有加载同名 `.auto-test` sidecar 的补充说明和图片，因此该 `passed` 不覆盖历史 sidecar 中的扩展步骤。该结果证明当前架构可以在一个复杂、多站点、含真实写入与清理的 Windows manifest 中自主闭环并安全恢复，但不构成对任意未知网站的无条件保证。新业务首次接入仍应从一条授权 canary 开始，根据 `passed`、`product_failed` 或 `blocked` 的结构化证据决定是否扩大测试范围。Windows 从全新目录复现时按 [Windows 从零验收清单](windows-acceptance-runbook.md) 操作。
