# Auto-Test MVP 规格

> **Legacy 已移除、不可执行、仅供历史参考。**

> 历史文档：本节描述已移除的旧 IR→Playwright 编译/探索/修复/分类规格，仅供审计。
> 当前默认执行链路是 AgentHost；请以 [README](../../README.md)、[快速指南](quick-start.md) 和 [AgentHost 宿主契约](agent-hosts.md) 为准。

## 1. MVP 目标

用户提供一个 Web 站点 URL 和一个测试用例 Excel。系统完成：

1. 校验并导入 Excel；
2. 把自然语言用例转换为可审核的 Test Case IR；
3. 使用 Playwright CLI 探索页面并生成稳定定位器；
4. 编译为 Playwright Test TypeScript 脚本；
5. 以零 AI 的方式执行；
6. 输出可追溯的结果、截图和 Trace；
7. 对可修复的定位/等待问题进行最多两次受限修复；
8. 生成关联 Excel、IR、代码、执行、分类和修复证据的集成报告。

MVP 验证的是“小批量用例能够可信地编译和重复执行”，不追求一次跑完数千条历史用例。

## 2. MVP 范围

### 包含

- Chromium；
- 单个 `baseUrl`；
- 标准 `.xlsx` 输入；
- 登录、导航、表单、搜索、列表和弹窗等常见 PC Web 场景；
- `navigate`、`click`、`fill`、`select`、`check`、`uncheck`、`press`、`upload`、`wait_for`；
- 无法可靠识别的草稿步骤使用 `manual`，必须人工或后续 AI 解释完成后才能编译；
- 可见性、文本、URL、标题、值、数量、启用状态、选中状态断言；
- 每次选择 1 至 20 条用例进行编译；
- 每个用例独立 BrowserContext，或通过审核后的角色 `storageState` 初始化；
- HTML 报告、失败截图和首次重试 Trace。

### 暂不包含

- XMind、Markdown 和自然语言聊天直接执行；
- 移动端/Appium；
- 多网站跨系统事务；
- 无人工批准的支付、删除、发布、结算、强制停止等破坏性操作；
- 自动生成大规模探索用例；
- 运行时完全依赖 Alumnium 或其他 LLM 浏览器 Agent；
- 对 3000+ 历史用例的一键全量执行。

## 3. Excel 输入契约

MVP 只接受 `.xlsx`，按表头名称映射，禁止按固定列号读取。标准工作簿见 `templates/test-cases.xlsx`。

### 必填列

| 列名 | 约束 |
|---|---|
| `用例ID` | 文件内唯一，不能为空 |
| `用例标题` | 清晰描述被验证的业务行为 |
| `测试步骤` | 一行一个动作，使用编号或换行分隔 |
| `预期结果` | 一行一个可观察断言，不能为空 |

### 可选列

| 列名 | 用途 |
|---|---|
| `模块` | 可使用 `系统/设备管理/列表` 路径 |
| `前置条件` | 业务状态或数据要求 |
| `测试数据` | `key=value` 多行格式，支持变量引用 |
| `优先级` | `P0`、`P1`、`P2`、`P3` |
| `依赖用例` | 逗号分隔的用例 ID |
| `账号角色` | 映射外部认证配置，不保存密码 |
| `标签` | 逗号分隔，如 `smoke,login` |
| `清理步骤` | 一行一个清理动作 |
| `风险等级` | `read`、`write`、`destructive` |

允许的表头别名应显式维护，例如 `标题 -> 用例标题`、`步骤 -> 测试步骤`、`期望结果 -> 预期结果`。未知表头保留在导入诊断中，不静默丢弃。

### 测试数据引用

真实凭据不得写入 Excel：

```text
username=${secret:admin.username}
password=${secret:admin.password}
device_name=regression-${random:uuid}
```

`secret` 在运行时从外部私有配置解析；`random` 由数据生成器产生并记录实际值。

### 导入时必须处理

- HTML 数字实体和 `&#10;` 换行；
- 中文/英文标点和不同编号格式；
- 合并单元格仅对模块类字段向下继承；
- 必填列缺失、重复 ID、空预期、非法风险等级直接报错；
- 图片或公式不能作为唯一的步骤/预期来源；
- 导入只生成预览和 IR 草稿，不直接启动浏览器。
- 文件扩展名必须为 `.xlsx`，压缩容器签名必须有效，MVP 文件大小上限为 25 MB。

### Phase 1 实现状态

已实现：

- 标准 13 列、当前 14 列和旧 16 列表头映射；
- 自动寻找工作表和表头行；
- HTML 数字实体、`&#10;` 和中文编号步骤归一化；
- 重复 ID、缺失字段、未知表头、非法风险和缺少清理步骤诊断；
- 明文凭据/常见个人标识从 IR 中移除并替换为未解析 `secretRef`；
- 规则式步骤、断言、风险和数据绑定草稿解析；
- Draft 2020-12 JSON Schema 校验；
- `npm run import` CLI 和机器可读诊断报告。

Playwright CLI 页面探索与定位器确认由 Phase 3 实现。

### Phase 2 实现状态

已实现：

- 审核门禁、歧义、手工步骤、定位器、数据引用和秘密引用的编译前检查；
- 断言类型、操作符、正则表达式与期望值的语义检查；
- `allowedOrigins` 编译期校验和每个步骤/断言的运行时 origin 检查；
- `role`、`testId`、`label`、`placeholder`、`text`、`css` 和 `xpath` 定位器编译；
- 常用动作、Web-first 断言、套件重试、单例超时和 `try/finally` 清理步骤编译；
- `secretRef -> AUTO_TEST_SECRET_*` 环境变量映射，生成代码不包含秘密值；
- 本地登录站点与 Chromium 真实执行演示；
- 同一条已编译登录用例连续三次执行结果一致；
- 编译时同时生成 source map，记录 Excel 来源、IR hash、生成源码 hash、用例行号和每个 IR target 的代码行。

### Phase 3 实现状态

已实现：

- 基于本地 `playwright cli` 的具名探索会话，支持 `open`、`snapshot`、受限 `action`、`candidate`、`apply` 和 `close`；
- CLI 临时快照 ref 到结构化 Locator IR 的转换，使用 TypeScript AST 解析生成表达式；
- 拒绝 `.nth()` 等位置型/链式定位器和包含秘密值的候选；
- 当前页面与刷新后的定位器计数、可见、启用和可编辑状态检查；
- 候选只显式应用到新 IR，禁止覆盖源文件，且不修改动作、断言预期和审核状态；
- 完整用例在独立 BrowserContext 中进行一至三次重放，默认两次；
- 每个步骤、断言和清理步骤的定位器检查报告，以及跨重放一致性判定；
- 探索快照按规则与 `secretRef` 实际值脱敏，报告 URL 移除查询参数和片段；
- 探索原始工作目录在会话关闭时删除，快照 ref 不进入回归 IR；
- `read` 用例默认允许，`write` 和 `destructive` 用例需要显式风险参数。

尚未实现：根据自然语言目标自动选择快照 ref 和瞬态状态的前序步骤重建。失败分类与受限自动修复由 Phase 4 实现。

### Phase 4 实现状态

已实现：

- 运行失败的结构化 `kind/phase/targetId` 证据，不依赖解析易变的终端文本；
- `product_defect`、`test_code`、`environment`、`data`、`policy` 和 `unknown` 规则式分类；
- 定位器零匹配、多匹配、不可见、不可启用、不可编辑、动作/等待超时、断言不符、数据缺失和环境故障识别；
- locator 修复只接受 Phase 3 已验证且 sourceText/用例/目标完全匹配的候选；
- wait 修复只增加现有 `timeoutMs`，不改变 wait kind 或 expected，且只允许修复间歇性等待；
- 每次修复前后的结构化 diff、IR SHA-256、分类和重跑证据；
- 保护投影检查，除 locator 和 wait timeout 外任何 IR 字段变化都会阻断；
- 修复尝试数同时受 CLI、`policy.repair.maxAttempts` 和硬上限 2 限制；
- 只有完整重跑通过才输出 repaired IR；断言失败、环境、数据和策略问题不自动修改。

真实验证：错误用户名 locator 在两次基线重放中稳定失败，被分类为高置信度 `test_code`，采用已验证候选后一次修复成功，随后两次重放共 8 次定位检查通过。错误 URL 断言被分类为高置信度 `product_defect`，修复尝试为 0，且未生成 repaired IR。

尚未实现：基于更多运行证据的产品缺陷细分类、候选 locator 自动发现、瞬态状态重建和需要 LLM 判断的低置信度分类。

### Phase 5 实现状态

已实现：

- 解析 Playwright JSON reporter，保留项目、状态、重试、耗时、步骤、错误和附件证据；
- 通过 source map 串联 Excel 文件/sheet/hash/行号、IR 用例与 target、生成文件和代码行；
- 聚合 locator 多重放验证、Phase 4 失败分类、修复尝试和 before/after diff；
- 输出机器可读 JSON 与无需服务端、无需 CDN 的静态 HTML，支持状态筛选和用例搜索；
- HTML 对所有动态内容进行转义，附件仅保存仓库相对路径或 basename；
- 秘密数据只显示 `secretRef`，报告生成前递归脱敏当前 `AUTO_TEST_SECRET_*` 值；
- source map 与 IR、生成源码 hash 不匹配时拒绝报告；`repaired` 修复报告最终 IR hash 不匹配时拒绝聚合。

真实验证：本地登录用例通过 Playwright Test 后成功生成 JSON/HTML 报告；完整 repaired 报告同时呈现两次基线 `locator_not_found`、`test_code` 分类、locator diff、修复后两次重放的 8 次定位检查和最终通过结果。

尚未实现：多套件历史趋势、集中式报告服务、跨运行对比与产物生命周期管理。

### Phase 6 工作流 Intake 与真实验收状态

已实现：

- 对无标准用例表头的“阶段标题 + 操作说明 + 资源”工作流型 `.xlsx` 提供独立 intake；
- 解析 WPS `DISPIMG` 公式和 `cellimages.xml` 关系，提取图片并关联 sheet、单元格、行和 SHA-256；
- 允许提示词通过 `--image` 补充 Excel 外的截图，清单只保存 basename/hash；
- 工作流资源中的登录信息、手机号列表和验证码转换为 `secretRef`，合法 `${secret:...}` 占位符不会被二次脱敏破坏；
- 输出阶段风险、步骤草稿、资源 URL、图片审核门和所需运行能力；
- 输出工作流验收 JSON/HTML，分别记录业务 canary 与产品自动执行验收门。

历史充电闭环真实 canary：目标模拟桩从离线启动并连接，目标枪口插枪；第一个配置账号在全新 H5 BrowserContext 中通过枪口 PIN 启动真实充电；商城后台捕获本轮唯一新订单并精确强停；随后捕获关联占位费订单并手动结算；最终活跃充电订单和占位费订单均为 0，新 H5 Context 回到空白登录页。

本次产品验收门仍为 blocked，原因是：

- workflow intake 尚未编译为正式 Workflow IR 和确定性执行计划；
- 图片语义审核尚未形成可重复的 AI 结果与人工批准门；
- 后台图形验证码缺少稳定的测试环境 adapter；
- 运行时订单 ID 捕获/传递、数据表与操作表对齐、中断恢复尚未进入新 runtime；
- 新工程尚未串行执行 Excel 中的全部账号。

上述 Workflow IR/runtime 路线（Phase 7）已作为旧执行链移除；工作流 Intake 与验收报告仍保留，首次执行改由 AgentHost 承担。不能把浏览器勘察成功当成产品自动化已验收通过。

### Phase 7 Workflow Runtime（历史）

Phase 7 曾实现审核后的 `workflow-execution-plan`、确定性 runtime、表格实体捕获和显式中断恢复，并在真实充电场景完成过单账号 canary。该 Planner/Explorer/Refiner/Runtime 执行链已移除，不再提供 `plan:workflow`、`execute:workflow`、`pipeline:workflow` 等入口；历史结论见 [从 IR/Runtime 到 Codex-native](architecture-journey-ir-runtime-to-codex-native.md)，不作为当前验收声明。

## 4. Test Case IR

旧 `test-case-ir.schema.json` 与 IR 编译器已移除，以下结构仅作历史记录：

```text
TestSuiteIR
├── source: 文件、sheet、hash
├── target: baseUrl、allowedOrigins、authProfile
├── policy: 超时、重试、修复和副作用策略
└── cases[]
    ├── id/title/modulePath/priority/risk
    ├── dependencies/preconditions/dataBindings
    ├── steps[]
    ├── assertions[]
    ├── cleanupSteps[]
    └── review: confidence、ambiguities、approval status
```

重要不变量：

- `assertions` 至少一条；
- 断言的 `expected` 来源于测试工程师，不由 AI 改写业务含义；
- 每个步骤保留原始文本和解析置信度；
- 定位器必须保留来源与候选，不保存 CLI 临时 `ref`；
- `write` 和 `destructive` 用例必须有清理步骤或人工豁免；
- 步骤中的秘密只能以 `secretRef` 表示。

## 5. 定位器策略

稳定定位器优先级：

1. `getByRole(role, { name })`；
2. `getByTestId()`；
3. `getByLabel()`；
4. `getByPlaceholder()`；
5. 稳定可见文本；
6. 经过验证的 CSS；
7. XPath 仅作为最后手段。

Playwright CLI 的快照 `ref` 只用于探索会话。编译前必须转换为可重复定位器，并验证：

- 只匹配一个目标元素；
- 元素在预期状态下可操作；
- 页面刷新后仍可定位；
- 不依赖随机 class、位置坐标或列表序号，除非用例明确要求。

Page Object 只用于跨用例复用的业务流程或复杂组件，不为每个页面机械生成一个大类。

## 6. 执行链路

```text
URL + Excel
    ↓
1. Intake：URL/来源/文件安全检查
    ↓
2. Import：按表头映射，输出导入诊断
    ↓
3. Interpret：规则优先，LLM 只处理剩余歧义，生成 Draft IR
    ↓
4. Review Gate：确认歧义、断言、风险和秘密引用
    ↓
5. Explore：Playwright CLI 有头探索，采集稳定定位器
    ↓
6. Compile：生成 Playwright Test + fixtures + source hash
    ↓
7. Validate：Schema、TypeScript、定位唯一性、断言和策略检查
    ↓
8. Execute：Playwright Test 零 AI 重放
    ↓
9. Classify：产品缺陷 / 测试代码 / 环境 / 数据
    ↓
10. Bounded Repair：仅定位器/等待，最多两次，保存 diff
    ↓
11. Report：原始用例、IR、步骤、断言、实际值和证据
```

源 Excel hash 和 IR hash 未变化时，后续回归直接执行已编译测试，不重新调用 AI。

## 7. 修复边界

自动修复允许：

- 替换等价定位器；
- 增加针对具体状态的等待；
- 处理同义按钮文本或稳定组件结构变化；
- 在不改变业务语义的前提下调整点击/填充方式。

自动修复禁止：

- 修改、删除或弱化断言；
- 把精确断言改成“页面存在任意文本”；
- 修改测试数据使产品更容易通过；
- 跳过失败步骤；
- 对多个候选业务对象随机选择；
- 自动批准 `destructive` 操作。

每次修复必须记录失败类型、修改 diff、修复理由和重跑证据。

## 8. MVP 验收标准

1. 标准模板和当前 14 列历史格式都能通过表头适配导入，字段零错位；
2. 非法输入生成明确诊断，不产生部分静默导入；
3. 选定的 5 至 10 条登录/表单/查询用例可编译成 Playwright Test；
4. 同一套已编译用例连续运行 3 次，结果一致；
5. 重放阶段不调用 LLM；
6. 操作工具返回失败时，用例必须失败；
7. 所有通过用例至少有一条实际执行的明确断言；
8. 报告能关联原始 Excel 行、IR 步骤、生成代码和运行证据；
9. `destructive` 用例未经批准不能执行；
10. 仓库、报告和日志中不出现明文凭据。

## 9. 建议技术栈

- Node.js 24；
- TypeScript；
- `@playwright/test`；
- `@playwright/cli` 用于 Agent 探索；
- Zod + JSON Schema；
- 成熟的 XLSX 解析库，必要时保留 XML 降级读取；
- SQLite 只在需要持久化运行记录时引入，MVP 首先使用文件化 IR 和 Playwright 原生报告。

不在 MVP 核心引入通用多 Agent 编排框架。编排复杂度应在真实需求出现后再增加。
