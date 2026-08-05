# Codex-native 跨场景测试快速指南

默认流程是：

`Excel Intake -> 环境与认证 -> 持久 Codex thread -> 页面探索与动态计划 -> 执行与断言 -> 同 thread 恢复 -> 逐 case 结果`

测试工程师不需要编写 Execution Plan。默认所有用例在同一持久 Codex thread 中执行；只有显式加入 `--case-batch-size` 才启用独立上下文作为容量和恢复兜底。Codex 直接读取原始材料、根据页面证据修订自己的工作计划并使用 Playwright MCP 操作网站。框架不解释业务语义，也不会替代 Codex 生成结论。旧 IR/Runtime 只有显式加入 `--legacy-runtime` 时才启用。

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

### Intake 的边界

Codex-native 入口会按 Excel 的每个来源行建立完整 case 索引，不会因为重复用例编号、缺少步骤/预期结果或自由文本测试数据而丢弃整份工作簿。重复编号会按来源行生成稳定的内部 ID，缺字段会作为该 case 的来源疑点交给 Codex 结合原始 Excel 判断。

解析诊断是审计提示，不是 Agent 启动门。只有无法建立不可变输入合同的情况才会在浏览器执行前阻断：原始文件身份无效、没有目标 URL、没有任何可追踪 case 或 Manifest case ID 不唯一。写入权限只由 Environment Profile 的最高授权风险控制；Manifest 中的风险推断不能替代 Codex 对当前页面动作的判断。

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
- `--model-profile <id>`：切换到已注册的模型供应商 Profile（见“多模型供应商”）；省略时使用注册表默认项，未配置注册表时使用源 Codex 配置；
- `--max-iterations <N>`：列表型数据先执行 N 条 canary；
- `--case-batch-size <N>`：显式启用 case-window 兜底，每个 Codex 上下文负责 N 个 case；省略时使用一个持续的 native Codex thread；恢复时必须与原 run 一致；
- `--headed` / `--headless`：显示或隐藏浏览器。

### 多模型供应商

当某个模型供应商返回容量不足（如 `Selected model is at capacity`）或临时不可用时，可以切换到另一个已注册的供应商继续。注册表位于 `~/.config/auto-test/model-profiles.json`（Linux/macOS）或 `%APPDATA%\auto-test\model-profiles.json`（Windows），模板见 [model-profiles.example.json](../templates/model-profiles.example.json)：

```json
{
  "version": "1.0",
  "defaultProfileId": "primary",
  "profiles": [
    { "id": "primary", "model": "gpt-4.1", "providerId": "primary_api", "baseUrl": "https://model-api.example.test/v1", "wireApi": "responses", "envKey": "AUTO_TEST_MODEL_API_KEY" },
    { "id": "glm", "model": "glm-4.6", "providerId": "glm_api", "baseUrl": "https://open.bigmodel.cn/api/paas/v4", "wireApi": "chat", "envKey": "GLM_API_KEY" }
  ]
}
```

每个 Profile 声明模型、Provider 段名、base URL、wire 协议（`responses` 或 `chat`）和持有 API Key 的环境变量名；Key 本身不写入注册表。运行时用 `--model-profile glm` 切换，或在交互菜单中选择。未配置注册表时，运行回退到源 Codex 配置中的 Provider。

容量不足会被归类为可恢复的 `infrastructure` 阻断：使用 `--model-profile` 切换到另一个供应商后，用原 `--output-dir` 执行 `--resume` 即可继续同一个 Codex thread，无需重新执行已验证的业务写入。


## 5. 运行机制

每次运行使用独立 Codex Home 和可写 Agent 工作区。默认向同一个 native Codex thread 提供：

- 原始 Excel、说明、图片和本轮测试值；
- shell、临时脚本、网络和 Web Search；
- 完整 Playwright MCP，包括页面 JavaScript、网络、视觉和 Playwright 代码执行；
- 可选 Auto-Test Control MCP 日志和 Mutation Ledger。

Codex 自己决定工作计划、case 顺序和执行方式。Runner 被动记录 Playwright 操作和进度；Control MCP 的 case episode、Execution Plan 和 checkpoint 都是可选工作记忆，不是浏览器执行前置条件。对于需要中断恢复的外部业务写入，应以完整业务操作为单位登记 Mutation；普通导航、读取和字段输入不需要登记。仍有 pending Mutation 时，结果必定是 `blocked`。

只有显式提供 `--case-batch-size` 时，Runner 才按原顺序创建 `batch-0001`、`batch-0002` 等窗口。每个窗口使用新的 Codex 对话上下文，作为容量或中断恢复兜底；原始 Excel、登录状态、workspace、证据目录、环境需求和 Ledger 仍属于同一个 run。默认 native 模式不切断跨 case 页面探索上下文，也不要求 Codex 先完成 case bookkeeping 才能操作。它不把标题映射成固定动作，也不生成第二份 Execution Plan。

## 6. 结果

`execution_receipts` MCP 查询默认返回当前 run 的紧凑回执摘要；显式 case-window 时才收窄到当前窗口。完整回执文件仍用于确定性校验和审计。回执 ID 包含执行命名空间和 turn 序号，跨上下文或恢复时重复出现的 `item_*` 不会互相覆盖。

主要文件：

- `codex-agent.state.json`：运行状态、Codex 线程 ID 和结果路径；
- `codex-agent.result.json`：`passed`、`product_failed` 或 `blocked` 的结构化交付；
- `agent-workspace/execution-receipts.json`：Runner 被动捕获的 Playwright 调用回执；只保留工具名、类型、状态和可观察到的 case 归属，不保留表单参数或响应正文；
- `原文件名-Auto-Test-结果.xlsx`：原 Excel 的结果副本，按来源行回写每条 case 的状态、失败归类、摘要、证据索引和环境需求；原文件保持不变；
- `codex-agent.events.jsonl`：脱敏后的 Codex 事件；
- `agent-workspace/input/`：原始测试材料和本轮输入；
- Codex 在 `agent-workspace/` 内创建的临时脚本、计划和证据记录；
- `.agent-private/mutation-ledger.json`：私有 Mutation Ledger；
- `.agent-private/case-batches/`：显式 case-window 模式中每个已完成窗口的结构化结果；
- `agent-workspace/active-case-window.json`：显式 case-window 模式的当前窗口 ID、顺序和 case 范围；
- `agent-workspace/evidence/`：截图、快照、网络和控制台证据。
- `agent-workspace/case-results.json`：全部窗口完成后的逐 case 聚合恢复文件；当最终结构化响应无法被接受，或后续 `--resume` 可以直接完成同一份交付时，框架会校验输入身份、完整覆盖、逐 case 回执、证据路径、环境需求和权威 Ledger 终态后使用它。

终态含义：

- `passed`：所有用例、断言和最终状态均已验证通过；
- `product_failed`：操作完成，但测试工程师定义的业务预期未成立；
- `blocked`：缺少数据、权限、认证、恢复能力，或模型/MCP/浏览器等执行依赖不可用；
- `failed`：未知框架编程异常，没有被误分类为业务阻断。

对于非通过结果，中文菜单会直接显示失败位置、原因类别、直接原因、建议操作、完成用例数、Mutation Ledger 终态和证据路径。这些内容来自同一份 `codex-agent.result.json`、Environment Requirement 和 Ledger，不会启动第二个 Reporter 重新解释业务结果。

失败来源分为：

- `product`：正确执行操作后，产品或业务结果与预期不符；
- `agent_execution`：输入和环境已足够，但 Codex 未能正确完成操作或验证；
- `input`：Excel、图片、brief 或 sidecar 缺失、矛盾或有歧义；
- `environment`：缺少目标网站登录、权限、测试数据、目标服务或物理条件；
- `infrastructure`：模型 Provider、Codex CLI、浏览器进程、MCP、本地文件系统或本地网络异常。

模型、网络、浏览器或 MCP 在执行中断后，使用相同 Excel、URL、环境 Profile 和原输出目录显式恢复：

```bash
npm run easy -- run \
  --file /private/cases.xlsx \
  --profile staging \
  --output-dir artifacts/runs/interrupted-run \
  --resume
```

恢复会复用原始材料副本、工作区脚本、证据和 Mutation Ledger。框架先确定性校验已有交付；输入身份、证据、环境需求和 Ledger 全部完整且实际没有 pending Mutation 时，会直接生成正式结果。native 模式恢复同一个 Codex thread；只有显式 case-window 运行才恢复 `activeBatch`，已完成窗口不重新执行。环境身份、权限策略或窗口大小不一致会 fail closed；不要删除 Ledger、改换输出目录或放宽预期结果来规避阻断。

## 7. 当前验收状态

以下已经通过确定性验证：Excel/图片 Intake、URL 自动发现、环境选择、认证刷新、Storage State 合并、原始材料和 run-values 工作区、完整与受限两种 Agent 配置、strict Provider 结构化结果 Schema、长 suite case 分窗、逐窗口回执隔离、当前窗口恢复、Codex 直接结果校验、Mutation Ledger、Windows 启动器、Linux Verify 和 Windows Verify。长 suite 分窗目前先由业务无关的合成 fixture 验证，不能替代新的真实业务 canary。

2026-08-03，基于 `c94ad77` 的最终 thin harness Windows 私有包使用充电 Excel、测试 URL 和一次 Environment Profile 注册完成真实业务 canary：同一个 Codex thread 自主执行 3/3 manifest case 和 7 组测试数据，记录 26 条 Mutation Ledger 且 pending 为 0，生成 129 个证据文件，最终结果为 `passed`。运行中的模型重连和页面工具错误由同一 thread 恢复，没有人工编辑 Execution Plan。

本轮 manifest 加载了 Excel 的 6 张内嵌图片，但没有加载同名 `.auto-test` sidecar 的补充说明和图片，因此该 `passed` 不覆盖历史 sidecar 中的扩展步骤。该结果证明当前架构可以在一个复杂、多站点、含真实写入与清理的 Windows manifest 中自主闭环并安全恢复，但不构成对任意未知网站的无条件保证。新业务首次接入仍应从一条授权 canary 开始，根据 `passed`、`product_failed` 或 `blocked` 的结构化证据决定是否扩大测试范围。Windows 从全新目录复现时按 [Windows 从零验收清单](windows-acceptance-runbook.md) 操作。
