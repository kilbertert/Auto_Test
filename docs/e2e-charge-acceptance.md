# 历史充电闭环端到端验收

> 当前结论（2026-07-29）：AI 自动生成 Execution Plan 的产品验收已通过。下文保留首次受控勘察、历史手工 reviewed plan 和失败批次，最新生成链路见文末“AI 生成 Execution Plan 验收”。

## AgentHost 当前版本边界

PR #28 将 Codex 和 OMP 接入同一宿主无关 Core。2026-08-06 的当前验收在 Linux x64、业务执行基线 commit `836c849`、包版本 `0.1.0` 上，使用 SHA-256 为 `6a4b035377e8dc809e117bdf53a52be1a35e0d97433a9b9e9207159b3843af02` 的同一实际 Manifest 串行执行两个宿主。Codex 和 OMP 均为 `3/3 passed`；每个 run 的 7 条业务写入均为 `accepted`、`pending=0`，最终审计没有遗留活跃订单。Codex 保存 355 个证据文件和 772 条被动执行回执，OMP 保存 138 个证据文件和 220 条回执；确定性比较器报告 `contractStatus=valid`、`verdict=equivalent`、逐 case 无差异。OMP 的结构化交付曾因重复投影的 Ledger 字段和脱敏文件名引用失配被 Core 阻断，本文所在提交修复后从完整逐 epoch 事实恢复为通过，没有重复任何业务写入。

本轮逐轮完成模拟桩启动、目标枪复位、H5 充电、后台捕获并强停本轮订单、占位费订单唯一关联与结算、最终零活跃订单审计。宿主之间没有并行操作同一业务实体，也没有用通用证据或历史订单替代本轮证据。该结论只覆盖这一复杂 canary 和 Linux 平台，不证明任意未知网站、任意 Excel 或所有物理前置条件都能无人补充地成功；Windows 仍需使用合并后的私有包重新验收。

## 验收输入

本次使用测试工程师原始自然语言、工作流型 Excel、Excel 内 6 张 WPS `DISPIMG` 图片，以及提示词补充的 2 张占位费截图作为输入。

标准测试用例导入器首先按现有契约执行，并正确报告：工作簿没有“用例ID、用例标题、测试步骤、预期结果”表头，不能伪装成标准 Test Case IR。随后新增的 workflow intake 识别出 3 个 Excel 阶段，纳入全部 8 张图片，并将运行账号、手机号列表和验证码转换为秘密引用。

## 真实页面复核

2026-07-28 重新勘察了三套在线 UI：

- IoT 平台当前可通过可访问名称定位登录字段、协议勾选框、设备菜单、目标设备和启动按钮；
- H5 当前默认英文，国家码默认 `+86`，需要切换 Singapore `+65` 和验证码登录；
- 商城后台当前默认英文并带图形验证码，订单数据与右侧操作列由两个按行对齐的表格渲染。

旧截图和旧脚本只作为对照证据，没有直接作为当前 locator。

## 业务 Canary 结果

本轮只执行第一个账号引用作为 canary：

1. 启动目标模拟设备，验证设备已连接且存在两个枪口；
2. 仅插入目标 1 号枪，商城后台同步为 `Online / Placed / On`；
3. 新建 H5 BrowserContext，完成登录并使用枪口 PIN 进入启动页面；
4. 启动真实充电，H5 显示 Charging、时长、能量、功率和费用；
5. 后台按账号引用、父设备和枪口捕获本轮唯一新订单；
6. 对该订单执行 `Force Stop / Confirm stop`，验证状态变为 `Charging complete`；
7. 等待并捕获与该充电订单关联的新占位费订单；
8. 执行 `Manual Settlement / save`，验证状态为 `Occupancy Ended / Paid`；
9. 复查没有活跃目标充电订单或占位费订单；
10. 关闭原 H5 Context，新 Context 返回空白手机号登录页。

业务 canary 结果：通过。

## 首次产品验收结论（历史）

产品验收门：阻断。

原因不是目标网站不能自动化，而是当前新工程还不能从 workflow intake 自动生成并执行上述跨站点闭环。本轮真实执行仍由受控浏览器勘察驱动。

必须补齐：

- Workflow IR：多站点、上下文生命周期、循环账号、明确断言和风险批准；
- runtime value：捕获新订单 ID，并在后续阶段作为精确关联条件；
- table action：同时校验业务数据行和独立操作行，禁止只点“最新第一行”；
- context isolation：每个账号使用全新 BrowserContext；
- captcha adapter：测试环境绕过、人工输入或可替换 OCR；
- recovery：中断后根据持久化运行状态只恢复唯一未完成订单；
- evidence：Workflow IR 步骤到浏览器动作、业务实体和最终状态的 source map。

完整的私有 JSON/HTML 证据写入被 Git 忽略的 `artifacts/acceptance/charge/`。

## 后续 Runtime 实现进展

真实 canary 之后，新工程已经补入 Workflow Execution Plan 与确定性 runtime：

- 多 origin phase 和按手机号串行循环；
- 每个手机号独立的 `freshPerIteration` H5 BrowserContext；
- `write` / `destructive` 显式批准；
- 订单行唯一捕获、实体 ID 传递、数据表与操作表二次对齐；
- 活跃订单数量断言；
- 阶段、步骤、断言与实体捕获证据；
- 不保存匹配行文本的私有原子中断状态；
- 必须人工指定 target 的显式恢复。

Reviewed plan 位于 `artifacts/acceptance/charge/charging.execution-plan.json`。在后续在线验收中已经完成 Element UI 分离表格、后台 sessionStorage、H5 二次确认、枪口拔插复位和 Hash 路由刷新等 live 修正。

2026-07-28 新 Runtime 使用原始手机号列表索引 2 完成独立 canary：

- 11/11 phase 通过；
- 61/61 步骤通过；
- 14/14 断言通过；
- 自动捕获并强停本轮新增充电订单；
- 自动关联并结算本轮新增占位费订单；
- 独立复查为 `Charging complete`、`Occupancy Ended / Paid`；
- 活跃目标充电订单和占位费订单均为 0；
- 新 H5 Context 返回空手机号登录页；
- 运行状态文件自动清除，证据不包含手机号、验证码或整行订单文本。

因此单账号业务 canary 与产品 canary 均为 `passed`。完整 7 账号批量回归仍未执行；后台预认证 adapter 的到期检测和刷新规程仍需继续工程化。完整报告位于 `artifacts/acceptance/charge/runtime-canary.report.html`。

## 批量验收补充

2026-07-28 在进入连续账号验收前，发现枪口复位 phase 位于一次性 bootstrap group。Execution Plan 已修正为在 `account-cycle` 每轮开头自主导航模拟器详情页并执行拔枪/插枪复位。

修正后运行连续两账号 batch：

- 两轮枪口复位、后台认证和无活跃订单前置检查均通过；
- 两个账号都完成 H5 登录、PIN、`Get start` 和二次确认，但没有进入充电路由；
- 后台完整轮询均未捕获到对应的新充电订单；
- 两轮最终审计均确认活跃充电订单和占位费订单为 0；
- 因没有真实启动、订单强停和占位费结算，本次两账号 batch 的验收结论为 `failed`，不能计入通过账号。

本轮还发现旧 Runtime 在显式跳到后续安全审计后会清除状态并返回 `passed`，即使早期失败 phase 没有成功重试。现已修正为按 group、iteration 和 phase 计算最新有效结果：只有同一 phase 的成功重试可以覆盖旧失败；后续安全审计只能证明现场已清理。原始证据保持不变，纠正后的审计结论位于 `artifacts/acceptance/charge/runtime-batch-offset2-count2.acceptance-audit.json`。

当前可确认单账号产品 canary 曾完整通过，且批量每轮枪口复位机制已在线执行两次。完整 7 账号验收仍被账号侧启动条件阻断，需要先核对并补足测试账号余额或其他 H5 启动前置条件，再重新运行。

## 完整 7 账号验收

后续复核确认 7 个测试账号后台余额均为 `S$0`，H5 `failedStart` 的明确原因均为 `Insufficient balance, please recharge`。在获得用户授权后，通过后台 `Member List / Recharge` 为测试账号提交真实余额调整，验证码从私有 `secretRef` 注入，随后在 `Balance Import Review` 逐条选择 `Approved`。每笔申请均通过会员主信息、金额、操作人和待审核状态唯一匹配，审核后独立复核余额为 `S$10`。

余额准备完成后执行两段正式验收：

- 单账号 canary：11/11 phase、63/63 步骤、14/14 断言通过；
- 其余账号连续 batch：56/56 phase、348/348 步骤、69/69 断言通过；
- 合计 67/67 phase、411/411 步骤、83/83 断言和 28 次实体捕获通过；
- 7 个账号均完成枪口复位、H5 启动、120 秒计量、充电订单强停、占位费结算和最终审计。

独立在线审计确认：

- 7/7 充电订单为 `Charging complete`；
- 7/7 占位费订单为 `Occupancy Ended / Paid`；
- 目标枪口活跃充电订单为 0，活跃占位费订单为 0；
- 模拟桩保持已连接且目标枪已插；
- 全新 H5 Context 返回 `/shopPackage/pages/login/index`，手机号输入为空。

因此完整 7 账号业务验收门与产品验收门均为 `passed`。正式证据位于：

- `artifacts/acceptance/charge/runtime-full7.evidence.json`
- `artifacts/acceptance/charge/runtime-full7.report.json`
- `artifacts/acceptance/charge/runtime-full7.report.html`

## AI 生成 Execution Plan 验收

本轮不再把历史 `artifacts/acceptance/charge/charging.execution-plan.json` 作为 Planner 输入。原始输入仍是工作流 Excel、8 张图片、目标 URL 和测试工程师补充说明，链路为：

`Workflow Intake → AI Planner → 页面探索 → Draft Execution Plan → Refiner → 审核门 → Runtime`

Planner 初稿经过真实页面证据驱动的多轮 Refiner，主要补齐：

- Element UI/Element Plus 表格大小写、固定右列、空结果 body 和 SPA 加载竞态；
- H5 两段式 `Phone → Next → Verification Login → Code → Login`；
- 纯图标扫码入口、异步 Loading、`Get start` 和 10 秒充电路由稳定等待；
- 实体状态按 ID 实时重查，不持久化订单行文本；
- `Charging` 自动排除 `Charging complete`，避免终态订单被误判为活跃；
- 占位费后置筛选移除，直接对捕获实体验证 `Occupancy Ended / Paid`；
- 模拟桩 `ensureChecked(expected:true)` 幂等前置，已分别从“未插”和“已插”两种初始状态验证。

最终 Draft `artifacts/planning/charge/charge.refined12.plan-draft.json` 的完整探索结果：

- 15/15 phase、88/88 steps、21/21 assertions；
- 75 个 locator resolution；
- 13 个 table contract；
- 0 unresolved locator/table；
- 充电订单与占位费订单各捕获 1 次；
- Exploration status 为 `passed`。

审核门据此生成 `artifacts/planning/charge/charge.generated-v2.execution-plan.json`。该文件与历史手工 plan 的 SHA-256 不同，并带有本轮 exploration hash，未复制历史执行计划。

随后正常 `execute:workflow` 使用另一条未参与最终探索的数据执行，结果位于 `artifacts/acceptance/charge/generated-v2-runtime-offset6.result.json`：

- Runtime status `passed`；
- 15/15 phase、88/88 steps、21/21 assertions；
- 充电订单为 `Charging complete`；
- 占位费订单为 `Occupancy Ended / Paid`；
- 每轮和最终活跃充电/占位费订单均为 0；
- 状态文件在成功后自动清除，证据不含手机号、验证码或订单行文本。

另一个账号在充电强停后累计等待超过 5 分钟仍未生成关联占位费订单，该次运行正确返回 `failed` 并保留恢复状态。该结果属于数据或业务配置差异，不应通过放宽断言掩盖。

因此，本轮 AI 自动生成链路的业务门和产品门均为 `passed`；跨账号数据差异仍需由测试数据准备和业务配置审计继续治理。

## Autonomous Controller 增量状态

2026-07-29 新增持久化 Autonomous Controller、Mutation Ledger、恢复契约、Recovery Planner、Policy Gate 和按 origin 选择的 Environment Profile Registry。

Recovery Planner 基于 `charge.refined12.plan-draft.json` 生成 `artifacts/planning/charge/charge.autonomous-recovery.plan-draft.json`：

- 六个 write/destructive phase 均获得 `retry` 或 `compensate` 恢复契约；
- `h5-start-charge` 的补偿链使用本轮实体捕获、强停、占位费结算和每轮零活跃订单审计；
- 去除 `planner` 和 `recovery` 后，新旧 Draft 的保护投影完全一致；
- 原步骤、断言、风险、阶段顺序、数据绑定和 source refs 未改变；
- Draft 校验通过，缺失恢复契约为 0。

首次自治 canary 的模拟器 Session 已过期并落到登录页。旧分类器把“登录页没有设备入口”误判为 locator 问题；该次 Job 在进入 Refiner 后被终止，未执行写操作。现已增加登录页/Session 过期分类和 Auth Broker：Profile 使用 Secret 引用与已验证 locator 刷新权限 `0600` 的 `storageState`，严格按 pathname 判定登录成功，并支持登录前置协议复选框。

修复后使用同一 Recovery Draft 和独立 canary 账号运行 `autonomous:workflow`。完整证据保存在不入 Git 的受限验收目录中，仓库文档仅保留聚合结论：

- 顶层 Job `completed / passed`，round 0，Runtime attempt 1；
- 新 Draft hash 的 Exploration 为 `passed`：15 phase、88 steps、21 assertions、75 locator、13 table contract、0 unresolved；
- Policy Gate 自动批准，reasons 为空；
- 独立正常 Runtime 为 `passed`：15 phase、88 steps、21 assertions、2 个实体捕获、0 failed phase/step/assertion；
- `h5-start-charge` mutation 最终为 `compensated`，其余五个非只读 phase 为 `retry_ready`；
- 充电和占位费每轮及最终零活跃订单审计全部通过；
- 成功后 Exploration/Runtime 中断状态自动清除；私有 Job state 为 `0600`，其余受限证据为 `0640`；
- Secret Vault 值、手机号和 OTP 未出现在 Draft、Exploration、Plan、Runtime 或 Job evidence 中。

因此，虚拟充电桩场景已完成一次不依赖聊天代理手动续跑的自治链路验收：Environment Profile → Auth Broker → Recovery Planner Draft → live Exploration → Policy Gate → normal Runtime → final safety audit。
