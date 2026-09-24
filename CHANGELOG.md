# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- 实现 Web UI 自动化测试平台 P0-P6
- 真实后台自适应登录脚本 + SSL 忽略 + 探测脚本
- 浏览器 CDP 模式 — 连接已登录浏览器绕过验证码
- Real-regression 脚本 — 历史用例在真实后台(CDP)跑回归
- Record 脚本加 --force 重新录制已录制用例
- 定位器用 MiMo 强模型 + 自定义下拉框处理(1+2 组合)
- Record/real-regression 加 --cases=ID 精确选案
- START_ON_CURRENT 预导航模式 — 绕过多级菜单导航卡点
- 多级菜单导航 — navigator agent 录制时导航,重放用直达 URL
- Add Codex-native autonomous test agent (#4)
- Allow one-shot Windows API key override
- Validate composite field representations (#12)
- Make Codex-native long suites resumable (#19)
- Clarify tester-facing failure summaries (#17)
- Multi-model provider registry and quick switching (#24)
- Make model profiles portable across AgentHosts (#32)
- Expose safe AgentHost action heartbeats (#48)
- Add regression matrix, outcome rubric, and failure-mode scorecard (#51)
- Add a committed oracle and a thin eval-suite runner (#54)
- Compile MCP traces into verified Playwright replays (#58)
- Compile deterministic MCP replay specs (#59)
- Show deterministic case execution progress (#74)
- Add upstream prd issue workflow primitives (#77)
- Add profile-backed prd implementation workflows (#78)
- Make AFK model profiles switchable
- Add Alibaba DeepSeek AFK profile
- Planner orchestration loop (pnpm ralph)
- Add --version flag to the easy CLI
- Add --version flag to the easy CLI
- Port label-driven GitHub Actions from course-video-manager
- Bake coding standards + code-review skill into the AFK loop
- Add CONTEXT.md domain language + entry convention doc
- Plan A — no auto-claim on agent:implement label
- Plan A full decouple — implement-prd dispatch-only
- Close reference gaps — dependency analysis + model guardrails
- Strip queue labels on issue close
- Add AgentRouter profile (#142)
- Enforce governance contract
- Read-only run dashboard server (run list slice) (#176)
- Add run detail view with progress, case table, and blockers (#177)
- SSE live updates for in-progress runs (#178)
- Serve evidence files behind an explicit allowlist (#179)
- Token-gated non-loopback dashboard access (#181)
- Fixed-port dashboard with FRP tunnel remote access (#184)

### Changed
- Record→compile→replay 架构(AI 仅录制,执行零 AI)
- Make Codex the primary test executor (#13)
- Keep Codex in one native test thread
- Add adaptive Codex epoch runtime
- Make agent execution host agnostic
- Extract model-provider contract to core + add architecture contract (#69)
- Extract agent event contract to core, break compiler->agent dependency (#70)
- Reduce repeated manifest tokens (#76)
- Extract native standard-table parsing module
- Narrow easy entry and summary to AgentHost-only
- Remove legacy planner/runtime/recovery chain
- Remove IR-to-Playwright compiler and repair chain
- Retire legacy report directory and migrate acceptance redaction
- Shrink public entry to AgentHost surface

### Documentation
- Define thin harness acceptance boundaries (#16)
- Centralize Windows package instructions (#18)
- Add CLAUDE.md guidance for Claude Code (#21)
- Mark OMP AgentHost MCP loading as a known issue (#57)
- Scope single-thread ordering claim to one execution epoch (#64)
- Record the model-API-credential consensus and ignore key CSVs (#67)
- Scaffold matt-pocock agent-skills config (#90)
- Document the easy --version flag
- Record AFK provider canary (#147)
- Record live canary provider block (#153)
- Retain review workflow boundaries (#160)
- Dashboard documentation, domain terms, and final QA record (#180)
- Restructure as an architecture handoff document (#188)
- 收入架构快照图与源规格，并入链 README (#190)
- 连线补齐正交拐点，消除斜向线段 (#191)

### Fixed
- Xlsx 路径跨平台化 + 修复 probe-login 类型
- Real-regression CDP 新页面先导航到已登录后台首页
- Real-regression 提效+强制 verdict 输出
- Real-regression 加超时防卡死 + 软化 prompt + 清旧截图
- 断言补全 count/value/enabled/checked + 录制时验证断言
- 录制器直连 MiMo(绕过别名缓存)+ select 改为点击选项文本
- Text 断言改为检查期望文本是否在页面 + select value 空回退 AI
- Navigator 触发条件改为 action=navigate(不依赖 value)
- CDP 连接超时 30s→60s + 重试一次
- Pool.ts null check(CDP connect 后 this.browser 类型)
- Show live Codex test progress (#5)
- Fail over quota-limited Windows API keys (#6)
- Resume agent runs after registering discovered origins
- Make private Windows package input robust
- Bound Codex provider probe (#14)
- Close timed-out probe streams (#15)
- Resume guard and pending-mutation recovery on native path (#22)
- Scope easy registration to user-supplied targets, not discovered origins (#23)
- Warn instead of blocking when a model profile env key is unset (#25)
- Redact agent artifacts before delivery
- Recover AgentHost delivery consistently
- Bound Windows provider probe output
- Include generated result headers in workbook range
- Preserve native Codex provider config (#33)
- Enable Windows Codex agent capabilities (#35)
- Rotate incompatible agent sessions on resume (#36)
- Ignore Codex skill budget advisory (#37)
- Show a clean Chromium-download prompt instead of a red stderr error (#39)
- Gate agent runs on control mcp capability (#38)
- Stop reading completed agent turns (#40)
- Disable plugins in test agent (#41)
- Bound OMP event artifacts (#42)
- Preserve input URL provenance
- Bridge Codex MCP tools for flat Responses providers (#44)
- Accept probe marker as substring for reasoning models (#45)
- Keep authentication cases under test (#46)
- Probe with minimal reasoning effort to avoid timeout (#47)
- Make result workbook delivery atomic and keep runs off the package drive (#49)
- Preserve business failure causality (#50)
- Aggregate OMP per-turn token usage from turn_end frames (#52)
- Propagate --require-oracle-match into the process exit code (#53)
- Load the run-scoped MCP servers via --config overlay (#55)
- Use the OMP MCP tool name in the capability preflight (#56)
- Constrain Ark structured result fields (#60)
- Align replay episodes with auth state (#61)
- Keep test execution on primary thread (#62)
- Self-check npm integrity before reusing the portable Node (#66)
- Harden host capacity and epoch recovery (#68)
- Recover bounded provider interruptions (#71)
- Make long-suite execution recoverable
- Clarify provider authorization and progress
- Preserve git hook environment in self-hosted checkout (#87)
- Use gh credential setup for runner checkout (#88)
- Route AFK implementation through Psydo profile
- Run Psydo AFK through Codex provider
- Match sandbox image to repo env (node 24 + Playwright chromium)
- Align sandbox image name with sandcastle build default
- Base task worktree on origin/main instead of HEAD (#113)
- Remove dead exports and stale docs left by legacy removal (#118)
- Put AFK_PROFILE in the sandbox env for createSandbox
- Unescape GH_REPO in manual checkout steps
- Clean stale agent branches in runner checkout
- Remove orphan step stubs from label workflows
- Use npm cache in setup-node
- Inject GH_TOKEN into the sandbox env
- Grant issues permission to PR-label workflows
- Make architecture-review checkout idempotent
- Align label lifecycle with reference — merge agent owns it
- Align label-Action review with the reference design
- Deepen review checkout history (#149)
- Harden AFK review delivery
- Fail closed on workflow boundaries
- Handle pull requests without linked issues (#158)
- Apply provider-neutral economy contract (#161)
- 验收报告复用共享凭据规则，补齐动态凭据缺口 (#192)

### Removed
- Remove Windows API key failover patches

