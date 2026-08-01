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

还需要一个可工作的 Codex CLI Provider。Windows 私有包会自动安装固定版本 Codex CLI、配置 Provider 并验证最小请求；Linux/macOS 复用当前用户已经可用的 Codex 配置。

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

账号、验证码和手机号等值会在 Intake 时替换为 secretRef，真实值只进入私有 Secret Vault 或本次进程，不写入 Manifest、事件日志或工作区。

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

每次运行使用独立 Codex Home 和只读 Agent 工作区。Shell、Web Search、插件、Apps、Memory、Hooks 和多 Agent 均关闭，只启用：

- Playwright MCP：页面导航、可访问性快照、表单、点击、刷新、存储和确定性页面验证；
- Auto-Test Control MCP：不可变测试契约、动态计划、证据索引和 Mutation Ledger。

Agent 必须在业务写入前登记 Mutation，结束前验证其已补偿或被用例明确接受。仍有 pending Mutation 时，结果必定是 `blocked`。

## 6. 结果

主要文件：

- `codex-agent.state.json`：运行状态、Codex 线程 ID 和结果路径；
- `codex-agent.result.json`：`passed`、`product_failed` 或 `blocked` 的结构化交付；
- `codex-agent.events.jsonl`：脱敏后的 Codex 事件；
- `agent-workspace/execution-plan.json`：页面证据驱动的动态工作计划；
- `agent-workspace/evidence-index.json`：业务断言证据索引；
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

恢复会复用原 Codex thread、动态计划、证据、用例结论和 Mutation Ledger，只重建浏览器与 MCP 进程。框架会校验工作流来源哈希、目标 URL、环境身份和权限策略；任何不一致都会 fail closed。恢复 Agent 必须先重新观察 pending Mutation 的真实业务状态，不会把浏览器断线当成重复写操作的理由。不要删除 Ledger、改换输出目录或放宽预期结果来规避阻断。

## 7. 当前验收状态

以下已经通过确定性验证：Excel/图片 Intake、URL 自动发现、环境选择、认证刷新、Secret 隔离、Storage State 合并、同线程结果修正、Mutation Ledger、Windows 启动器，以及真实 Playwright MCP + Control MCP 启动和本地页面快照。

完整的“Codex 自主探索并执行两个无关业务场景”验收在 2026-08-01 因当前模型账户 `429 usage limit` 被正确交付为 `blocked`。额度恢复后必须重新运行只读目录场景和写入后恢复场景，二者都得到 `passed` 后，才能声称 Codex-native 跨场景 MVP 完成真实端到端验收。
