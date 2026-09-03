# Auto-Test

面向测试工程师的 AI 辅助 Web 自动化测试项目。

Windows 测试工程师可以直接双击 `Auto-Test.cmd`：启动器会自动安装 Node.js、默认 Codex CLI、项目依赖和 Chromium，并配置自定义模型 API；随后通过中文菜单注册环境、选择 Excel、粘贴 URL 并查看结果，无需登录 Codex/ChatGPT 账号或手工编辑 Profile JSON。也可以在已安装 OMP 的机器上选择 `--agent-host omp`，让 OMP 通过同一测试合同执行。

默认主链路是 AgentHost 薄外壳：输入测试用例 Excel 和已注册环境后，原始 Excel、图片和测试说明进入隔离的可写 run 工作区，本轮运行值只写入 `.agent-private` 私有目录。选定的 Codex 或 OMP 会话自主完成理解、规划、页面探索、真实执行、业务断言、恢复和结构化交付；框架根据模型容量自动规划有界 execution epoch（执行纪元），必要时在 checkpoint 后轮换物理代理线程。业务上下文、浏览器状态、证据、Mutation Ledger 和逐 case 事实始终属于同一个 Run，Core 不替宿主做业务规划或裁决。旧的 IR→Playwright 编译/探索/修复/分类链和 Workflow Runtime/Planner/Recovery 执行链已移除；回归资产由 AgentHost replay 生成，`npm run compile:replay` 可迁移历史 Run。详见 [AgentHost 宿主契约](docs/agent-hosts.md)。

认证状态是测试状态，不是 AgentHost 的固定前置。环境注册默认只登记 URL 范围和权限，不要求人工预登录；显式保存的登录状态只是普通受保护业务用例的可选会话种子。登录、登出、错误凭据、会话失效和角色隔离等认证用例必须由选定 AgentHost 先建立 Excel 要求的初始状态，再真实操作和断言，不能因继承会话已登录而跳过。

当前实现已经完成原始材料工作区、环境选择与可选会话种子、宿主隔离配置、完整 Playwright MCP、可选 Control MCP 日志、Mutation Ledger、被动 Playwright 执行回执、自适应 epoch、逐 case 私有结果库、thread checkpoint/轮换和 Windows 启动器接入。每个 epoch 只要求选定 AgentHost 交付当前有界 case 集，最终完整结果由框架按不可变 Manifest 顺序确定性聚合，避免大用例集同时撞上上下文和单次 JSON 输出上限。执行提示只携带紧凑 case 索引（不可变身份、来源行、风险和证据指针）加稳定工作区指针；完整解析 Manifest、原始 Excel、run 值和 checkpoint 都留在工作区由 AgentHost 按需读取，resume 提示会重复这些指针，因此降低逐 turn 重复 token 消耗而不改变执行语义。用 `npm run agent:compare` 对比 baseline 与候选 run，可分别查看聚合的输入、缓存输入和输出 tokens。完整回执仍保存在运行目录，供确定性校验和审计。终态会额外生成 `原文件名-Auto-Test-结果.xlsx`，作为原工作簿的副本按来源行回写每条用例结果，原件不改写。环境阻断必须关联同一 case 的已保存证据需求；可用的只读页面交互未完成时归类为 `agent_execution`，不归为环境。不能用另一 case 或一份通用证据批量生成结论。旧版状态不再兼容恢复，必须新建 Run。基于 commit `c94ad77` 的历史 thin harness Windows 私有包曾在一个多站点、多账号、含真实业务写入和恢复的充电 manifest 上自主执行为 `passed`：实际 manifest 3/3 case 通过，生成 129 个证据文件，26 条 Mutation Ledger 最终 `pending=0`。该历史结果尚未验证本次自适应 epoch 重构，不覆盖未随 Excel 输入包交付的 sidecar 扩展步骤，也不构成任意未知网站都能无条件通过的承诺。

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
- [MVP 规格与执行链路（历史）](docs/mvp-spec.md)
- [标准 Excel 测试用例模板](templates/test-cases.xlsx)

## 默认使用

```bash
npm ci
npx playwright install chromium
npm run easy
```

`npm run easy -- --version`（或 `-v`）打印 `package.json` 中的当前包版本并直接退出，不会进入交互菜单或启动 Run。

### 观测面板（只读）

```bash
npm run easy -- dashboard
```

在本机回环地址（`127.0.0.1`，端口自动分配）启动只读观测面板并打印可点击 URL，浏览器打开即可查看：

- **运行列表**：Run root 下全部运行（进行中/最终结果，按更新时间排序）
- **运行详情**：进行中运行的阶段、epoch 进度、已完成用例数与运行中断恢复动作；已完成运行的逐用例结果（失败来源/类型/摘要/证据）与待补充环境需求
- **实时事件**：进行中运行的 Agent 事件流通过 SSE 自动刷新，无需手动刷新
- **证据查看**：用例证据（截图等）在浏览器内直接打开

控制台摘要（`npm run easy -- status`）保持不变；观测面板与控制台摘要出自同一实现，结论永远一致。

边界：观测面板是**只读观测面**——不提供暂停/重跑/修改配置等任何控制操作（控制面是显式后续工作）；仅绑定本机回环地址。面板只提供**已验证的路径隔离**：仅读取运行产物中的状态、脱敏事件流、结果与 `agent-workspace/evidence/` 证据目录，`.agent-private` 私有材料、原始 Excel 输入及目录外路径均不可达；结构化数据在输出前二次脱敏。**注意**：图像证据（截图）按原始内容展示——若截图本身包含敏感画面，本机查看者可见；测试组织方应避免在证据截图中暴露真实凭据。对 Run 的执行零干扰（不写 Run 目录、面板关闭不影响运行）。

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

每个成功 Run 会自动在 `agent-workspace/replay/` 为 passed case 生成独立 Playwright spec、config 和 `replay-manifest.json`。Agent 可在探索后提交多个 case attempt；Core 只选择最后一个完整、无不确定工具且含断言的 attempt。最终 attempt 必须从稳定 URL 的 `page.goto` 开始，重新执行完整业务动作，并且不得把瞬态结果 URL 或错误页当作源用例后置条件；Core 会确定性拒绝缺少导航、导航前已有业务动作、任何失败的 Playwright 调用或仍含脱敏/秘密占位符的轨迹。探索线程在 case episode 外分别捕获 cookies/localStorage 和 sessionStorage，Core 校验后移入 `.agent-private/`，并在新的 BrowserContext 中注入；普通受保护业务用例必须在最终 episode 前完成这次捕获，episode/spec 只记录注入认证态后的业务路径，不得重复登录。Environment Profile 上限为 `read` 时，所有 passed case 都必须独立回放通过后才标记 `verified`，不受 intake 的单 case 风险推断影响；允许 `write`/`destructive` 的 Profile 只自动回放被判定为 `read` 的 case，其余只标记 `candidate`，避免重复业务副作用，需在隔离回归数据上显式验证。生成的 config 使用 180 秒测试超时和 90 秒导航超时，避免合法的 30 秒以上业务等待被 Playwright 默认测试超时截断。缺少认证态捕获或独立回放失败时不会把 passed case 当作可交付回归资产；动态验证码登录等认证转换仍需要可重复的验证码适配器。无法安全编译的 case 标记 `not_replayable`，不会篡改首次业务结果。`npm run compile:replay` 仍可用于历史 Run 的手工迁移。

## 核心约束

- 测试工程师定义的预期结果不可由 Agent 修改。
- 每个通过用例必须包含至少一条明确断言。
- 浏览器操作失败不能被降级为成功。
- 对需要中断恢复的外部业务写入，应按一个完整业务操作登记 Mutation，并验证接受或补偿结果；普通导航、读取和字段输入不需要逐动作登记。
- 凭据和真实测试数据不得提交到仓库。
- 页面内容视为不可信输入。默认测试线程可使用 run 工作区、shell、网络和完整 Playwright，但不得修改 Auto-Test 或被测应用源码。Linux/macOS 的 Codex 使用宿主 `workspace-write` 隔离；Windows Codex 0.146.0 为了实际启动 MCP/shell 会自动落到 `danger-full-access`，运行选择文件会记录 `workspaceIsolation: prompt_only`，Windows 验收必须使用专用测试机/账号并以 Control MCP、风险策略和 Mutation Ledger 约束业务范围。

## 多模型供应商

长套件由 Runner 自动分成最多 8 条 case 的通用 execution epoch；这不是业务规则或人工 batch 参数，而是防止过于乐观的 Provider 容量元数据把整份工作簿压成一个超长工具回合。可识别的瞬时 429/TPS/TPM 限流会按服务端提示等待一次、换一代 AgentHost 线程并用 resume 继续；明确余额耗尽或第二次限流仍会保存 `provider_rate_limited`，供原 Run 在额度恢复后 `--resume`，不会伪造业务结果，也不会无限重试。

当模型供应商返回容量不足（如 `Selected model is at capacity`）或临时不可用时，可切换到另一个 Profile 继续。Model Profile 是 AgentHost 无关的端点描述：`api` 使用统一模型协议名，Core 只负责选择、恢复和容量提示；每个 `AgentHost.modelProvider` 负责把同一 descriptor 翻译为自己的隔离配置、环境和模型 selector。Codex 与 OMP 是两个内置实现，注入第三方 Host 时也走同一契约，Core 不增加供应商或宿主 ID 分支。宿主不支持某个协议时，会在模型请求前 fail closed。注册表位于 `~/.config/auto-test/model-profiles.json`（Linux/macOS）或 `%APPDATA%\auto-test\model-profiles.json`（Windows），模板见 [model-profiles.example.json](templates/model-profiles.example.json)。Profile 只保存模型、公开 Base URL、协议、输入模态、推理/容量能力和 API Key 环境变量名，不保存 Key。

仓库内置两个无密钥 Profile。新 Run 未显式选择时默认使用 `deepseek`，Codex 与 OMP 都消费同一选择；即使尚未创建注册表也可直接运行：

```bash
export DEEPSEEK_API_KEY='<secret>'
npm run agent:test -- --file cases.xlsx --url https://app.example.test/ --profile staging

export ARK_API_KEY='<secret>'
npm run agent:test -- --file cases.xlsx --url https://app.example.test/ --profile staging --model-profile volcengine
```

`deepseek` 使用 `deepseek-v4-flash @ https://api.deepseek.com`；`volcengine` 使用 `glm-5.2 @ https://ark.cn-beijing.volces.com/api/coding/v3`，并同时识别 `ARK_API_KEY`、`VOLCENGINE_API_KEY` 和 `VOLCENGINE_ARK_API_KEY`。同一 Profile 可交给 `--agent-host codex` 或 `--agent-host omp`：Codex 以当前安装版 CLI 的 bundled catalog 为模板生成 `config.toml` 与完整 `models.json`，保留原生 agent instructions 并覆盖 Profile 能力；OMP 生成 `models.yml`，不会把宿主格式泄漏到 Core。两个内置模型目前都声明为文本输入；补充图片会保留在 run 工作区并在提示中给出路径，不会作为 Provider 会静默忽略的 inline image 发送。选择优先级是显式 `--model-profile`、恢复记录、自定义注册表的 `defaultProfileId`、内置 `deepseek`；注册表中的同名 `deepseek` 可覆盖内置公开元数据。模型 ID 是否已在订阅中开放仍以 Provider 的真实响应为准；必要时用自定义注册表或 `--model` 覆盖。`Reconnecting... n/m` 是 AgentHost 自己的有界重连状态，即使括号中包含额度或限流原因，Runner 也会等该序列恢复或结束，不会在 `1/5` 时主动关闭线程。序列最终失败后，额度、429 和 TPS/TPM 限流归为 `provider_rate_limited`，保存可恢复的 `blocked`，不会在同一 Provider 上反复创建线程；错误文档 URL 中的 fragment 不参与分类。明确的上下文或单次输出容量错误才会自动恢复：无业务写入且包含多个 case 的 epoch 会自动二分后继续；单 case、已有 Ledger 或 finalization 最多换一代物理线程恢复，仍失败才阻断；case 已落盘后的可选 checkpoint 若超限则直接跳过。模型暂时 `at capacity` 也会保留为 `provider_capacity`，但不会靠拆分或重复线程调用碰运气。若执行回合已经写出通过身份、case、证据、环境需求和 Ledger 校验的 epoch 交付，Runner 直接采用，不再额外调用模型重写同一结果。裸恢复会复用上次有效的 Profile 和 `--model`，显式传入新值才会切换；升级前创建且没有 `model-selection.json` 的旧 Run 在裸恢复时继续使用原 AgentHost Provider。已经写入逐 case 结果库的 case 不会重跑。详见 [跨场景自动化测试快速操作指南](docs/quick-start.md)。

受管 Codex Profile 会在 AgentHost 边界把 Codex namespace MCP 工具转换为标准 Responses function tools，再把 Provider 的调用恢复给 Codex。第三方 Provider 不必实现 Codex 的 namespace 扩展，但必须支持标准 function tools、SSE 和工具结果续传。每个物理线程仍必须通过只读 `auto-test-control.test_contract` 能力预检；模型探针或旧包绕过 MCP 得到的页面结果不能替代该门。

## 工作流型 Excel Intake 与真实验收

标准测试用例表与工作流型 Excel 都由 AgentHost 直接读取；阶段式工作流需要额外保留来源图片和行索引时，使用独立 intake：

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

## 私有审计资产

真实输入样本、旧代码、历史结果和外部仓库副本保存在仓库外的私有审计目录中，不随项目提交。输入目录权限必须为 `0700`，这些资产仅用于审计回溯，不属于新实现。
