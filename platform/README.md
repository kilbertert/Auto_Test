# Web UI 自动化测试平台

基于 `@open-multi-agent/core`(编排)+ Playwright(浏览器)+ Drizzle/better-sqlite3(持久化)+ Vue 3(UI)的智能化 Web UI 自动化测试平台。3566 条历史中文自然语言用例可结构化、确定性回归执行,AI 探索测试二期支持。

> 架构设计见 `/home/ranlei/Auto-Test/docs/技术设计文档.md`。

## 已交付(P0–P6)

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0 | 骨架:open-multi-agent runTasks + Playwright + 8 个浏览器工具 + WS 进度 + 最小看板 | ✅ 真实闭环(StepFun) |
| P1 | DB(13 表 Drizzle schema)+ xlsx XML 直读导入器 + DbMemoryStore | ✅ 3576 条全量落库 |
| P2 | NL 用例解释器(38 动词词典 + LLM 兜底 + outputSchema) | ✅ 87.8% 规则分类率 |
| P3 | 元素定位层(别名词典 + AI 语义定位 + 自学习回写) | ✅ 端到端验证 |
| P4 | 回归执行编排(DeterministicCaseRunner + runTasks DAG + retry/checkpoint) | ✅ 确定性回归通过 |
| P5 | Vue 3 + Element Plus UI(用例树/执行看板/报告/导入) | ✅ 构建通过 |
| P6 | AI 探索(runTeam + 测试分解 coordinator + page-explorer/case-generator/debugger) | ✅ 机制验证(质量依赖模型) |

## 架构

```
Vue 3 UI(ui/) ── HTTP/WS ── Node API(server.ts + api/cases-api.ts)
                                  │
                  open-multi-agent 编排(runTasks 回归 / runTeam 探索)
                                  │ defineTool()
                  浏览器工具层(browser/tools.ts:8 工具 + Locator)
                                  │
       NL 解释器(interpreter/)  元素定位层(locator/)  确定性执行(runner/deterministic.ts)
                                  │
                  持久化(db/:Drizzle + better-sqlite3 + DbMemoryStore)
```

## 快速开始

```bash
cd platform
cp .env.example .env          # 填 LLM 凭据(agent/interpret/explore 需要;smoke/regression 不需要)

# 1) 导入历史用例(3576 条)
npm run import                # → test_case / module_tree / project 落库

# 2) 结构化解释(词典优先 + LLM 兜底)
npm run interpret-sample 20   # 抽样 20 条验证
#   批量:POST /api/v1/interpret {limit:100}(经 UI 或 curl)

# 3) 回归执行(确定性,无 LLM)
npm run regression            # 对 fixture 登录页跑一条结构化用例

# 4) AI agent 执行(LLM 在环)
npm run dev                   # 启服务 → http://localhost:3199 → 看板触发 agent run

# 5) AI 探索(runTeam)
npm run explore               # 或经 UI execute 页选 explore 模式

# 6) 前端 UI
cd ui && npm install && npm run dev   # → http://localhost:8090(代理到 3199)
```

## 命令

| 命令 | 说明 |
|------|------|
| `npm run build` | tsc 编译 → dist/ |
| `npm run typecheck` | 仅类型检查 |
| `npm run dev` | tsx 启后端(3199) |
| `npm run smoke` | 无 LLM 验证 Playwright+工具链 |
| `npm run import` | xlsx 导入落库 |
| `npm run interpret-sample [N]` | 抽样结构化解释 |
| `npm run regression` | 确定性回归(对 fixture) |
| `npm run explore [url] [goal]` | AI 探索(runTeam) |
| `cd ui && npm run dev/build` | 前端开发/构建 |

## API 端点

- `GET /api/v1/tree` · `GET /api/v1/cases` · `GET /api/v1/cases/:id`
- `POST /api/v1/import` · `POST /api/v1/interpret`
- `POST /api/v1/runs {mode: agent|smoke|regression|explore, ...}` · `GET /api/v1/runs` · `GET /api/v1/runs/:id`
- `WS /ws?runId=<id>` · `GET /screenshots/<runId>/x.png`

## 配置(.env)

| 变量 | 默认 | 说明 |
|------|------|------|
| `OMA_PROVIDER` | `anthropic` | LLM provider(13 个;跃阶星辰用 `openai`) |
| `OMA_API_KEY` | — | agent/interpret/explore 必需 |
| `OMA_BASE_URL` | — | OpenAI 兼容网关(如 `https://api.stepfun.com/step_plan/v1`) |
| `OMA_MODEL` | `claude-sonnet-4-6` | 模型名(如 `step-3.7-flash`) |
| `PORT` | `3000` | 后端端口 |
| `DB_PATH` | `uitest.db` | SQLite 路径 |
| `BROWSER_HEADLESS` | `true` | `false` 有头调试 |
| `BROWSER_POOL_SIZE` | `2` | 浏览器并发 |
| `TARGET_LOGIN_URL` | 本地 fixture | 被测登录页 |

## 验证结果

- **导入**:3576 条用例(零丢失,hash 后缀防 ID 冲突)、3 项目、462 菜单节点,脱敏入库。
- **NL 解释**:100 条样本步骤分类率 87.8%,57% 纯规则无需 LLM,LLM 兜底经 outputSchema 产出结构化断言。
- **元素定位**:别名未命中→StepFun AI 定位"登录按钮"→`{role,button,登录}`→自学习回写→二次命中别名(免 LLM)。
- **回归**:fixture 登录用例确定性执行 PASSED(navigate→type×2→click→assert visible),run/run_case/run_step/assertion_result 全落库,截图生成。全程无 LLM。
- **agent 闭环**:StepFun step-3.7-flash 驱动 executor 按序调 6 工具→reporter 汇总→run_complete OK。
- **UI**:Vue 3 19 文件,vite 构建通过(1676 模块)。
- **探索**:runTeam 机制端到端跑通(coordinator 分解→agent 执行→WS→complete);分解质量依赖 coordinator 模型能力(flash 偏弱)。

## 已知限制

- **探索(P6)质量依赖 LLM**:`step-3.7-flash` 作为 coordinator 产出的任务 DAG 偏平凡;用更强模型(如 step-3 或 frontier)作 coordinator 可获更丰富探索 DAG。回归主路径(P4)确定性、不依赖 LLM。
- **真实后台**:当前回归验证用本地 fixture 登录页;接入真实充电桩后台需配置 `TARGET_LOGIN_URL` 与登录态共享。
- **元素定位长尾**:高频路径靠别名词典+AI 自学习;复杂动态组件可能需人工补 page object。
- **git/worktree**:`.git` 属 root,claude 无写权限,未做 worktree 隔离与提交。修权限后可提交。
