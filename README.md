# Auto-Test

面向测试工程师的 AI 辅助 Web 自动化测试项目。

Windows 测试工程师可以直接双击 `Auto-Test.cmd`：启动器会自动安装 Node.js、默认 Codex CLI、项目依赖和 Chromium，并配置自定义模型 API；随后通过中文菜单注册环境、选择 Excel、粘贴 URL 并查看结果，无需登录 Codex/ChatGPT 账号或手工编辑 Profile JSON。也可以在已安装 OMP 的机器上选择 `--agent-host omp`，让 OMP 通过同一测试合同执行。

默认主链路是 AgentHost 薄外壳：输入测试用例 Excel 和已注册环境后，原始 Excel、图片和测试说明进入隔离的可写 run 工作区，本轮运行值只写入 `.agent-private` 私有目录。选定的 Codex 或 OMP 会话自主完成理解、规划、页面探索、真实执行、业务断言、恢复和结构化交付；框架根据模型容量自动规划有界 execution epoch（执行纪元），必要时在 checkpoint 后轮换物理代理线程。业务上下文、浏览器状态、证据、Mutation Ledger 和逐 case 事实始终属于同一个 Run，Core 不替宿主做业务规划或裁决。既有 IR/Runtime 只作为显式 `--legacy-runtime` 兼容路径和未来稳定回归加速器。详见 [AgentHost 宿主契约](docs/agent-hosts.md)。

认证状态是测试状态，不是 AgentHost 的固定前置。环境注册默认只登记 URL 范围和权限，不要求人工预登录；显式保存的登录状态只是普通受保护业务用例的可选会话种子。登录、登出、错误凭据、会话失效和角色隔离等认证用例必须由选定 AgentHost 先建立 Excel 要求的初始状态，再真实操作和断言，不能因继承会话已登录而跳过。

当前实现已经完成原始材料工作区、环境选择与可选会话种子、宿主隔离配置、完整 Playwright MCP、可选 Control MCP 日志、Mutation Ledger、被动 Playwright 执行回执、自适应 epoch、逐 case 私有结果库、thread checkpoint/轮换和 Windows 启动器接入。每个 epoch 只要求选定 AgentHost 交付当前有界 case 集，最终完整结果由框架按不可变 Manifest 顺序确定性聚合，避免大用例集同时撞上上下文和单次 JSON 输出上限。完整回执仍保存在运行目录，供确定性校验和审计。终态会额外生成 `原文件名-Auto-Test-结果.xlsx`，作为原工作簿的副本按来源行回写每条用例结果，原件不改写。环境阻断必须关联同一 case 的已保存证据需求；可用的只读页面交互未完成时归类为 `agent_execution`，不归为环境。不能用另一 case 或一份通用证据批量生成结论。旧版状态不再兼容恢复，必须新建 Run。基于 commit `c94ad77` 的历史 thin harness Windows 私有包曾在一个多站点、多账号、含真实业务写入和恢复的充电 manifest 上自主执行为 `passed`：实际 manifest 3/3 case 通过，生成 129 个证据文件，26 条 Mutation Ledger 最终 `pending=0`。该历史结果尚未验证本次自适应 epoch 重构，不覆盖未随 Excel 输入包交付的 sidecar 扩展步骤，也不构成任意未知网站都能无条件通过的承诺。

执行回执由 Runner 被动捕获；选定 AgentHost 可以按需使用 Control MCP 查询当前 Run 或显式 case episode，完整回执仍保存在运行目录，供确定性校验和审计。回执 ID 包含 epoch 命名空间和 turn 序号，避免物理 thread 轮换后重复使用 `item_*` 编号时互相覆盖。

测试结束后，Windows 菜单会把同一份结构化结果确定性地整理为测试人员摘要：失败位置、原因类别、直接原因、建议操作、完成情况、Mutation Ledger 终态和证据路径。产品缺陷、代理执行失败、输入资料问题、环境阻断和基础设施故障分开显示；该展示层不调用新模型，也不覆盖选定 AgentHost 的业务结论。

## 当前文档

- [跨场景自动化测试快速操作指南](docs/quick-start.md)
- [AgentHost 宿主契约与 Codex/OMP 比较](docs/agent-hosts.md)
- [Windows 快速操作指南](docs/windows-quick-start.md)
- [Windows 私有包快速打包](docs/windows-package-quick-start.md)
- [Windows 从零验收清单](docs/windows-acceptance-runbook.md)
- [自适应 Epoch Runtime 验证记录](docs/adaptive-epoch-validation.md)
- [仓库与历史方案审计](docs/repository-audit.md)
- [MVP 规格与执行链路](docs/mvp-spec.md)
- [测试用例 IR JSON Schema](schemas/test-case-ir.schema.json)
- [标准 Excel 测试用例模板](templates/test-cases.xlsx)
- [最小登录 IR 示例](examples/login-suite.ir.json)
- [可执行本地登录 IR 示例](examples/local-login-suite.ir.json)

## 默认使用

```bash
npm ci
npx playwright install chromium
npm run easy
```

命令行方式：

```bash
npm run agent:test -- \
  --file <path-to-cases.xlsx> \
  --url https://app.example.test/ \
  --profile staging \
  --output-dir artifacts/runs/example
```

选择 OMP 时只需替换宿主参数；同一个 Model Profile 会由 OMP 适配器写成隔离 `models.yml`。通用的 `--agent-bin` / `--agent-home` 覆盖当前宿主的可执行文件与原生 provider/auth 源目录；`--codex-*` / `--omp-*` 只保留为兼容别名：

```bash
npm run agent:test -- \
  --file <path-to-cases.xlsx> \
  --url https://app.example.test/ \
  --profile staging \
  --agent-host omp \
  --agent-bin <path-to-omp>
```

新 AgentHost Run 必须显式提供 `--url`；Excel 中的其他 URL 只作为材料上下文，不会自动成为环境注册要求。环境首次注册后，日常执行不需要手工编写或修改 Execution Plan。详见 [跨场景自动化测试快速操作指南](docs/quick-start.md)。

需要比较 Codex 与 OMP 时，分别用同一输入包执行两个独立目录，再运行 `npm run agent:compare -- --run <dir> --run <dir>`；比较器只读取两份 Run 的不可变输入合同、结构化结果、证据、回执和 Ledger，不会再次调用模型或重复业务写入。合同缺失或不一致时只返回 `invalid`。

## 从 MCP 轨迹生成 Playwright 回归脚本

每个成功 Run 会自动在 `agent-workspace/replay/` 为 passed case 生成独立 Playwright spec、config 和 `replay-manifest.json`。Agent 可在探索后提交多个 case attempt；Core 只选择最后一个完整、无不确定工具且含断言的 attempt。探索线程在 case episode 外分别捕获 cookies/localStorage 和 sessionStorage，Core 校验后移入 `.agent-private/`，并在新的 BrowserContext 中注入。Environment Profile 上限为 `read` 时，所有 passed case 都必须独立回放通过后才标记 `verified`，不受 intake 的单 case 风险推断影响；允许 `write`/`destructive` 的 Profile 只自动回放被判定为 `read` 的 case，其余只标记 `candidate`，避免重复业务副作用，需在隔离回归数据上显式验证。生成的 config 使用 180 秒测试超时和 90 秒导航超时，避免合法的 30 秒以上业务等待被 Playwright 默认测试超时截断。缺少认证态捕获或独立回放失败时不会把 passed case 当作可交付回归资产；动态验证码登录等认证转换仍需要可重复的验证码适配器。无法安全编译的 case 标记 `not_replayable`，不会篡改首次业务结果。`npm run compile:replay` 仍可用于历史 Run 的手工迁移。

## 核心约束

- 测试工程师定义的预期结果不可由 Agent 修改。
- 每个通过用例必须包含至少一条明确断言。
- 浏览器操作失败不能被降级为成功。
- 对需要中断恢复的外部业务写入，应按一个完整业务操作登记 Mutation，并验证接受或补偿结果；普通导航、读取和字段输入不需要逐动作登记。
- 凭据和真实测试数据不得提交到仓库。
- 页面内容视为不可信输入。默认测试线程可使用 run 工作区、shell、网络和完整 Playwright，但不得修改 Auto-Test 或被测应用源码。Linux/macOS 的 Codex 使用宿主 `workspace-write` 隔离；Windows Codex 0.146.0 为了实际启动 MCP/shell 会自动落到 `danger-full-access`，运行选择文件会记录 `workspaceIsolation: prompt_only`，Windows 验收必须使用专用测试机/账号并以 Control MCP、风险策略和 Mutation Ledger 约束业务范围。

## 多模型供应商

当模型供应商返回容量不足（如 `Selected model is at capacity`）或临时不可用时，可切换到另一个 Profile 继续。Model Profile 是 AgentHost 无关的端点描述：`api` 使用统一模型协议名，Core 只负责选择、恢复和容量提示；每个 `AgentHost.modelProvider` 负责把同一 descriptor 翻译为自己的隔离配置、环境和模型 selector。Codex 与 OMP 是两个内置实现，注入第三方 Host 时也走同一契约，Core 不增加供应商或宿主 ID 分支。宿主不支持某个协议时，会在模型请求前 fail closed。注册表位于 `~/.config/auto-test/model-profiles.json`（Linux/macOS）或 `%APPDATA%\auto-test\model-profiles.json`（Windows），模板见 [model-profiles.example.json](templates/model-profiles.example.json)。Profile 只保存模型、公开 Base URL、协议、输入模态、推理/容量能力和 API Key 环境变量名，不保存 Key。

仓库内置两个无密钥 Profile。新 Run 未显式选择时默认使用 `deepseek`，Codex 与 OMP 都消费同一选择；即使尚未创建注册表也可直接运行：

```bash
export DEEPSEEK_API_KEY='<secret>'
npm run agent:test -- --file cases.xlsx --url https://app.example.test/ --profile staging

export ARK_API_KEY='<secret>'
npm run agent:test -- --file cases.xlsx --url https://app.example.test/ --profile staging --model-profile volcengine
```

`deepseek` 使用 `deepseek-v4-flash @ https://api.deepseek.com`；`volcengine` 使用 `glm-5.2 @ https://ark.cn-beijing.volces.com/api/coding/v3`，并同时识别 `ARK_API_KEY`、`VOLCENGINE_API_KEY` 和 `VOLCENGINE_ARK_API_KEY`。同一 Profile 可交给 `--agent-host codex` 或 `--agent-host omp`：Codex 以当前安装版 CLI 的 bundled catalog 为模板生成 `config.toml` 与完整 `models.json`，保留原生 agent instructions 并覆盖 Profile 能力；OMP 生成 `models.yml`，不会把宿主格式泄漏到 Core。两个内置模型目前都声明为文本输入；补充图片会保留在 run 工作区并在提示中给出路径，不会作为 Provider 会静默忽略的 inline image 发送。选择优先级是显式 `--model-profile`、恢复记录、自定义注册表的 `defaultProfileId`、内置 `deepseek`；注册表中的同名 `deepseek` 可覆盖内置公开元数据。模型 ID 是否已在订阅中开放仍以 Provider 的真实响应为准；必要时用自定义注册表或 `--model` 覆盖。容量不足会被归类为可恢复的 `infrastructure` 阻断：切换 Profile 后，以原 `--output-dir` 执行 `--resume`；裸恢复会复用上次有效的 Profile 和 `--model`，显式传入新值才会切换。升级前创建且没有 `model-selection.json` 的旧 Run 在裸恢复时继续使用原 AgentHost Provider，避免迁移后静默换模。已经写入逐 case 结果库的 case 不会重跑。详见 [跨场景自动化测试快速操作指南](docs/quick-start.md)。

受管 Codex Profile 会在 AgentHost 边界把 Codex namespace MCP 工具转换为标准 Responses function tools，再把 Provider 的调用恢复给 Codex。第三方 Provider 不必实现 Codex 的 namespace 扩展，但必须支持标准 function tools、SSE 和工具结果续传。每个物理线程仍必须通过只读 `auto-test-control.test_contract` 能力预检；模型探针或旧包绕过 MCP 得到的页面结果不能替代该门。

## Legacy IR/Runtime

以下 Phase 1 到 Phase 5 文档描述旧的 IR/Runtime 工具链。它仍保留用于兼容、审计和后续稳定回归加速，但不是新场景的默认首次执行路线。通过 `npm run easy -- run ... --legacy-runtime` 才会显式启动旧自治链路。

## Phase 1 使用

```bash
npm install
npm run check

npm run import -- \
  --file templates/test-cases.xlsx \
  --url https://example.test/ \
  --output artifacts/import/example.ir.json
```

命令会同时生成 IR 和诊断报告。存在缺失字段、重复 ID、明文秘密或缺少清理步骤等阻断问题时，仍会保留脱敏后的草稿供审核，但默认返回非零退出码。使用 `--allow-errors` 只能用于审计预览，不能表示用例已具备执行条件。

单次最多处理 20 条有效用例：

```bash
npm run import -- --file /private/cases.xlsx --url https://example.test/ --limit 5
```

Phase 1 不会启动浏览器或访问目标网站。

## Phase 2 使用

编译已经审核批准、定位器和秘密引用均已补全的 IR：

```bash
npm run compile -- \
  --ir examples/local-login-suite.ir.json \
  --output artifacts/compiled/local-login.spec.ts
```

编译器会在生成代码前阻断以下输入：

- 未批准或仍有歧义的用例；
- `manual` 步骤、缺失定位器和不存在的数据引用；
- 未解析的 `secretRef` 或 IR 中的秘密明文；
- 不兼容的断言操作符/期望值；
- 被策略阻止的破坏性操作和缺少清理步骤的写操作；
- 不在 `allowedOrigins` 内的目标站点。

编译成功时会同时生成 `<suite>.spec.ts` 和 `<suite>.spec.map.json`。source map 保存源 Excel 文件、工作表、hash、用例行号，以及 IR 步骤/断言/清理步骤对应的生成代码行，供后续报告建立可验证的追溯关系。

安装 Chromium 后，可以使用合成凭据运行仓库内的真实浏览器演示：

```bash
npx playwright install chromium

AUTO_TEST_SECRET_DEMO_USERNAME=demo-user \
AUTO_TEST_SECRET_DEMO_PASSWORD=demo-pass \
npm run demo:test
```

演示会启动仅监听 `127.0.0.1:43117` 的本地登录站点，真实填写表单并断言跳转 URL 与当前用户文本。HTML 报告、截图、Trace 和生成脚本均写入被 Git 忽略的 `artifacts/`。

Phase 2 的编译和回放不调用 LLM。当前仍需人工或后续探索模块把导入草稿中的 `manual` 步骤转换为经验证的稳定定位器。

## Phase 3 使用

为已完成业务语义审核的用例启动 Playwright CLI 探索会话：

```bash
npm run explore -- open \
  --ir examples/local-login-suite.ir.json \
  --case local-login-001 \
  --session login-explore

npm run explore -- snapshot --session login-explore
```

探索账号类页面时，使用 IR 数据绑定注入秘密，不把值写进命令或报告：

```bash
AUTO_TEST_SECRET_DEMO_USERNAME=demo-user \
npm run explore -- action \
  --session login-explore \
  --action fill \
  --target e6 \
  --value-ref username
```

从快照 ref 生成候选定位器，并检查当前页面与刷新后的唯一性和可操作性：

```bash
npm run explore -- candidate \
  --session login-explore \
  --target step-2 \
  --ref e6
```

候选通过后，显式应用到新的 IR 文件。该命令不会覆盖原 IR，也不会修改动作、断言预期或审核状态：

```bash
npm run explore -- apply \
  --ir examples/local-login-suite.ir.json \
  --candidate artifacts/exploration/candidates/<candidate>.json \
  --output artifacts/exploration/applied/login.ir.json

npm run explore -- close --session login-explore
```

对完整 IR 进行两次独立 BrowserContext 重放，验证所有定位器的实际计数和动作状态：

```bash
AUTO_TEST_SECRET_DEMO_USERNAME=demo-user \
AUTO_TEST_SECRET_DEMO_PASSWORD=demo-pass \
npm run validate:locators -- \
  --ir examples/local-login-suite.ir.json \
  --replays 2
```

探索工作区、脱敏快照、候选和验证报告均位于私有且被 Git 忽略的 `artifacts/`。写入和破坏性用例默认阻断，需要显式风险参数；快照 ref 只保留在探索报告中，不会进入回归 IR。

刷新检查会把刷新后消失的弹窗、菜单等瞬态状态标记为不稳定。这类结果需要测试工程师判断是否改为通过前序步骤重建状态，不能直接自动批准。

## Phase 4 使用

对定位器验证报告进行规则式失败分类：

```bash
npm run classify -- \
  --ir artifacts/exploration/applied/login.ir.json \
  --report artifacts/validation/login.locator-report.json \
  --output artifacts/classification/login.classification.json
```

分类类别为：

- `product_defect`：定位器和操作已成功，但测试工程师定义的断言未满足；
- `test_code`：定位器零匹配、多匹配、不可操作或间歇性明确等待失败；
- `environment`：浏览器、BrowserContext、DNS、连接或导航环境故障；
- `data`：秘密环境变量、上传文件或其他运行数据缺失；
- `policy`：风险策略或 `allowedOrigins` 阻断；
- `unknown`：当前证据不足，必须人工分析。

使用 Phase 3 已验证候选执行受限修复：

```bash
AUTO_TEST_SECRET_DEMO_USERNAME=demo-user \
AUTO_TEST_SECRET_DEMO_PASSWORD=demo-pass \
npm run repair -- \
  --ir artifacts/exploration/applied/login.ir.json \
  --candidate artifacts/exploration/candidates/login-step-2.json \
  --max-attempts 2 \
  --replays 2 \
  --output artifacts/repair/login.repair-report.json \
  --output-ir artifacts/repair/login.repaired.ir.json
```

修复器先执行基线重放，再按 `policy.repair` 最多尝试两次。locator 修复必须引用已经通过刷新稳定性检查的候选；wait 修复只能增加现有明确 `waitCondition.timeoutMs`，且仅适用于跨重放呈现间歇性的等待失败。

每次尝试记录前后 locator/wait、理由、IR SHA-256、分类和完整重跑结果。保护投影会阻止动作、测试数据、风险等级、审核状态以及断言 kind/operator/expected 的变化。只有修复后的全部用例重放通过才写出 `repaired.ir.json`；产品缺陷、环境、数据和策略问题不会生成修复 IR。

## Phase 5 使用

将当前 IR 和对应 source map 与 Playwright、定位器验证、失败分类、受限修复证据聚合为一份 JSON 和一份可直接打开的静态 HTML 报告：

```bash
npm run report -- \
  --ir artifacts/repair/login.repaired.ir.json \
  --source-map artifacts/compiled/login.spec.map.json \
  --playwright-report artifacts/playwright/results.json \
  --validation artifacts/validation/login.locator-report.json \
  --classification artifacts/classification/login.classification.json \
  --repair artifacts/repair/login.repair-report.json \
  --output-json artifacts/report/login.run-report.json \
  --output-html artifacts/report/login.run-report.html
```

`--ir` 和 `--source-map` 必填，其余证据参数可选。报告关联以下链路：

- Excel 文件、sheet、hash 和原始行号；
- IR 用例、步骤、断言、清理步骤和不可变 oracle；
- 生成 Playwright Test 文件和准确代码行；
- Playwright 执行状态、重试、步骤耗时、错误和附件；
- locator 多次重放验证、失败分类证据，以及修复前后的结构化 diff。

报告生成器会校验 source map 的 IR hash、生成源码 hash；聚合 `repaired` 修复报告时还会校验其最终 IR hash。任何版本错配都会拒绝生成，避免把旧执行证据挂到新用例上。JSON 和 HTML 都写入私有且被 Git 忽略的 `artifacts/`，只记录秘密的 `secretRef`，不会保存 `AUTO_TEST_SECRET_*` 的实际值。HTML 不依赖外部 CDN，支持按状态筛选和搜索用例。

运行仓库内的端到端演示并生成基础集成报告：

```bash
AUTO_TEST_SECRET_DEMO_USERNAME=demo-user \
AUTO_TEST_SECRET_DEMO_PASSWORD=demo-pass \
npm run demo:report
```

## 工作流型 Excel Intake 与真实验收

标准 `npm run import` 只接受带“用例ID、用例标题、测试步骤、预期结果”表头的测试用例表。对于“阶段标题 + 操作说明 + 资源 + 截图”的工作流型 Excel，使用独立 intake：

```bash
npm run intake:workflow -- \
  --file /private/workflow.xlsx \
  --url https://first-target.example/ \
  --url https://second-target.example/ \
  --image /private/supplemental-step-1.png \
  --image /private/supplemental-step-2.png \
  --output artifacts/acceptance/workflow/workflow.json \
  --media-dir artifacts/acceptance/workflow/media
```

该入口会：

- 识别无标准用例表头的阶段式工作流；
- 解析 WPS `DISPIMG` 公式，提取内嵌图片并关联原 sheet、单元格和行；
- 接收提示词单独引用的补充图片，保存文件 hash 而不保留原私有路径；
- 将邮箱/密码、手机号列表和测试验证码转换为 `secretRef`；
- 标记跨 origin、新 BrowserContext、运行时实体捕获、验证码、物理状态、调度等待和破坏性批准等所需能力；
- 为工作流型输入生成来源索引和诊断清单；该独立 intake 命令本身不执行浏览器操作。

AgentHost 的 `npm run easy -- run` / `npm run agent:test` 会直接读取原始 Excel 并按每个来源行建立完整 case 合同。新 Run 的环境入口必须来自显式 `--url`；Excel 中的教程或外部参考链接仍保留在 Manifest 供 Agent 理解，但不会提前扩大 Profile。重复 ID、缺步骤/预期结果和无法解析的自由文本会保留在 Manifest 与诊断中，由同一 AgentHost 会话结合原始材料判断；它们不会再把整份业务输入提前挡在浏览器之外。真正的启动阻断仅限输入身份、显式目标 URL、case 索引和 Manifest 一致性无法建立的情况。写入权限只由 Environment Profile 控制，不由推断的 case 风险替代。

使用结构化执行证据生成工作流验收报告：

```bash
npm run report:workflow -- \
  --intake artifacts/acceptance/workflow/workflow.json \
  --evidence artifacts/acceptance/workflow/live-canary.evidence.json \
  --output-json artifacts/acceptance/workflow/live-canary.report.json \
  --output-html artifacts/acceptance/workflow/live-canary.report.html
```

工作流报告分别展示“业务 canary 是否真实闭环”和“产品是否已经从原始输入自动编译执行”。两者不会合并成一个模糊的通过状态。

历史充电闭环和当前 AgentHost 宿主验收的边界见 [充电闭环端到端验收](docs/e2e-charge-acceptance.md)。PR #28 后，Codex 与 OMP 已在 Linux x64 使用同一冻结 Manifest 分别完成一次真实写入型充电 canary，均为 `3/3 passed`、7 条业务写入全部核销且 `pending=0`；该结果证明的是这一输入合同和场景，不代表任意未知网站都能一次成功。

Model Profile/Provider 适配层的独立验收记录见 [AgentHost：宿主无关执行](docs/agent-hosts.md)：commit `88f8e5c` 上，Codex 与 OMP 使用同一内置 DeepSeek Profile 完成了三 case 合成写入型 canary，比较合同为 `valid/equivalent`，两次 Ledger 均为 `pending=0`。该结果用于证明 Provider 适配与共同测试合同，不替代 Windows 或真实业务场景验收。

## Workflow Runtime

### AI Workflow Pipeline

顶层 pipeline 将原始工作流输入串成一条受控链路：

`Workflow Intake → AI Planner → 页面探索 → Draft Execution Plan → Refiner → 审核门 → Runtime`

无人值守控制器入口：

```bash
npm run autonomous:workflow -- \
  --file /private/workflow.xlsx \
  --url https://target.example/ \
  --storage-state app=/private/app.storage-state.json \
  --allow-write \
  --allow-destructive \
  --output-dir artifacts/pipeline/autonomous
```

如果目标 origin 已在默认 Registry 中唯一注册，任务调用可以缩减为：Linux/macOS 使用 `~/.config/auto-test/environment-profiles.json`，Windows 使用 `%APPDATA%\auto-test\environment-profiles.json`。

```bash
npm run autonomous:workflow -- \
  --file /private/workflow.xlsx \
  --url https://target.example/ \
  --output-dir artifacts/pipeline/autonomous
```

Registry 模板见 [environment-profiles.example.json](templates/environment-profiles.example.json)。Profile 一次性登记 origin、权限策略及认证 adapter；认证文件在 Linux/macOS 必须为 `0600`，Windows 必须由当前用户的 NTFS ACL 保护，相对路径按 Registry 所在目录解析。CLI 显式参数仍可用于临时覆盖 Profile 的认证映射，但不会扩大 Profile 未授权的 URL origin。

自治模式会将阶段和产物持久化到 `autonomous-job.state.json`，自动完成探索、受保护 Refiner、策略审核和 Runtime。终态只有：

- `passed`：Execution Plan 和 Runtime 断言均通过；
- `product_failed`：在修订预算内仍不能满足不可变业务断言；
- `blocked`：认证、数据、权限、恢复能力或环境条件不足。

每个 `write` / `destructive` phase 必须提供可追溯的恢复契约：

```json
{
  "strategy": "compensate",
  "phaseIds": ["capture-created-order", "stop-created-order", "final-zero-active-audit"],
  "maxAttempts": 2,
  "sourceRefs": ["phase:cleanup", "policy:owned-entity-only"]
}
```

确认整阶段可幂等重放时可使用 `strategy: "retry"`。Runtime 会记录不含 Secret 和订单行文本的 Mutation Ledger；失败后只有补偿完成或被明确标记为幂等可重试，Controller 才会进入下一轮。缺少恢复契约或补偿失败会直接 `blocked`。

为旧 Draft 补充受保护的恢复契约：

```bash
npm run plan-recovery:workflow -- \
  --draft artifacts/planning/workflow.plan-draft.json \
  --output artifacts/planning/workflow.recovery.plan-draft.json
```

Recovery Planner 只能修改 phase 的 `recovery` 字段；任何步骤、断言、风险、阶段顺序、数据绑定或审核语义变化都会被拒绝。

Environment Profile Registry 会按 URL origin 自动解析 `storageState` / `sessionStorage`、写入权限和重试预算。完全陌生且尚未登记凭据或风险策略的 origin 会返回 `blocked`；系统不会从页面或 Excel 猜测认证信息。

Profile 可配置基于 Secret 引用的表单登录 adapter。仅在显式 `--legacy-runtime` 的旧 pipeline 中，Auth Broker 才会在每轮前验证认证后 pathname，并在 Session 过期时使用已验证 locator 自动刷新私有 `storageState` 和可选 `sessionStorage`；默认 AgentHost 不会在用例执行前替用例先登录。

```bash
npm run pipeline:workflow -- \
  --file /private/workflow.xlsx \
  --url https://first-target.example/ \
  --url https://second-target.example/ \
  --brief /private/source-brief.txt \
  --image /private/supplemental-step.png \
  --storage-state simulator=/private/simulator.storage-state.json \
  --storage-state admin=/private/admin.storage-state.json \
  --session-storage admin=/private/admin.session-storage.json \
  --allow-write \
  --allow-destructive \
  --max-iterations 1 \
  --iteration-offset 0 \
  --output-dir artifacts/pipeline/canary
```

未提供 `--approve` 时，pipeline 在完整探索通过后停在审核门，并输出 Draft 与 Exploration Report。审核后显式生成 Execution Plan 并执行：

```bash
npm run pipeline:workflow -- \
  --file /private/workflow.xlsx \
  --draft artifacts/pipeline/canary/workflow.plan-draft.json \
  --seed-exploration artifacts/pipeline/canary/workflow.exploration.json \
  --storage-state simulator=/private/simulator.storage-state.json \
  --storage-state admin=/private/admin.storage-state.json \
  --session-storage admin=/private/admin.session-storage.json \
  --allow-write \
  --allow-destructive \
  --approve \
  --reviewer tester \
  --execute \
  --max-iterations 1 \
  --iteration-offset 1 \
  --output-dir artifacts/pipeline/accepted
```

普通模式仍保留显式人工审核。自治模式对只读失败自动 Refine；写入或破坏性阶段失败后，Runtime 会按照恢复契约执行补偿和清理断言。未恢复副作用不会被后续安全审计覆盖，也不会进入下一轮。

审核后的 Workflow Execution Plan 可以通过确定性 runtime 执行：

```bash
npm run execute:workflow -- \
  --plan artifacts/planning/charge/charge.generated-v2.execution-plan.json \
  --validate-only

npm run execute:workflow -- \
  --plan artifacts/planning/charge/charge.generated-v2.execution-plan.json \
  --allow-write \
  --allow-destructive \
  --storage-state simulator=artifacts/auth/charge-simulator.storage-state.json \
  --storage-state admin=artifacts/auth/charge-admin.storage-state.json \
  --session-storage admin=artifacts/auth/charge-admin.session-storage.json \
  --state artifacts/workflow-state/charge.state.json \
  --output artifacts/workflow-runs/charge.result.json
```

真实充电流程的预认证文件必须保持 `0600`，且不能提交到 Git。后台认证同时依赖 Playwright `storageState` 和 `sessionStorage` adapter；只注入其中一个不能恢复登录态。

先执行单账号 canary 时，使用循环上限和从 0 开始的账号偏移：

```bash
npm run execute:workflow -- \
  --plan artifacts/acceptance/charge/charging.execution-plan.json \
  --allow-write \
  --allow-destructive \
  --storage-state simulator=artifacts/auth/charge-simulator.storage-state.json \
  --storage-state admin=artifacts/auth/charge-admin.storage-state.json \
  --session-storage admin=artifacts/auth/charge-admin.session-storage.json \
  --max-iterations 1 \
  --iteration-offset 2 \
  --state artifacts/workflow-state/charge-canary.state.json \
  --output artifacts/workflow-runs/charge-canary.result.json
```

`--max-iterations 1 --iteration-offset 2` 表示只执行手机号列表索引 2 的一个账号。完整批量回归应移除这两个参数，并使用独立的 state/output 路径。`--stop-before <target-id>` 可用于在指定步骤或断言前生成不继续改变业务状态的 partial 证据。

runtime 当前提供：

- group 内按数据列表串行执行跨站点 phase；
- `shared`、`freshPhase`、`freshPerIteration` 三种 BrowserContext 生命周期；
- 每个动作和断言后的 `allowedOrigins` 检查；
- `write` 和 `destructive` 两级显式门禁；
- 表格实体唯一捕获、实体 ID 跨阶段引用，以及数据表/独立操作表重新对齐；
- 阶段、步骤、断言和实体捕获的结构化证据；
- 原子写入的私有中断状态，Linux/macOS 权限为 `0600`，且不保存秘密值或匹配行文本；
- 中断状态绑定 execution plan 的 SHA-256，计划改变后禁止继续使用旧状态；
- 中断后禁止自动猜测恢复点，必须同时使用 `--resume --resume-from <target-id>`。

恢复点可以回退到当前中断 phase 的较早步骤，用于重新建立页面状态或重新捕获实体。由于浏览器动作无法提供通用的 exactly-once 保证，恢复前仍必须先审计目标系统的实际状态；对真实强停、结算等动作不能盲目重放。显式跳到后续安全审计只能证明现场已清理，未被同一 phase 成功重试覆盖的失败仍保持权威，最终 run 不会因此改判为通过。

当前 AI 生成的充电 Execution Plan 将 7 个手机号建模为 `freshPerIteration` 循环，包含幂等模拟桩准备、每轮枪口复位、H5 登录/启动、充电订单精确捕获与强停、关联占位费结算、每轮和最终零活跃订单审计。

2026-07-29 的最新产品验收结果：

- AI Draft `charge.refined12.plan-draft.json` 完整探索通过，75 个 locator、13 个 table contract、0 unresolved；
- 审核门生成 `charge.generated-v2.execution-plan.json`，不是历史 `charging.execution-plan.json` 的复制，两者 SHA-256 不同；
- 正常 Runtime 使用另一条未参与最终探索的数据执行通过：15/15 phase、88/88 steps、21/21 assertions、2 次实体捕获；
- 充电订单终态为 `Charging complete`，关联占位费订单为 `Occupancy Ended / Paid`，每轮和最终活跃订单审计均为 0；
- 另有一条测试数据在充电强停后超过 5 分钟仍未生成占位费订单，该次 Runtime 保持 `failed`，没有伪造订单或把清理状态误判为业务通过。

同日新增的自治链路 canary 位于 `artifacts/acceptance/charge/autonomous-canary-offset6-v2`。单次 `autonomous:workflow` 命令自动完成 Environment Profile、Auth Broker、新 Draft hash Exploration、Policy Gate 和独立 Runtime：两段执行均为 15/15 phase、88/88 steps、21/21 assertions，Policy Gate 无阻断原因，充电 mutation 最终 `compensated`，每轮和最终零活跃订单审计通过。全程没有聊天代理手动续跑或编辑 Execution Plan。

最终通过证据位于 `artifacts/acceptance/charge/generated-v2-runtime-offset6.result.json`。后台认证仍通过权限 `0600` 的 storageState + sessionStorage adapter 处理，需要继续维护到期检测和人工刷新规程。

## 私有审计资产

真实输入样本、旧代码、历史结果和外部仓库副本保存在仓库外的私有审计目录中，不随项目提交。输入目录权限必须为 `0700`，这些资产仅用于审计回溯，不属于新实现。
