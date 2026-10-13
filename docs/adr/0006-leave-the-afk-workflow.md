# 6. 退出 AFK 自动化：保留脚手架，停掉整条流水线

日期：2026-10-14
状态：已采纳

## 背景

本仓库的定位是**一个失败的仓库**。它原本要解决的是「自动化测试」——开发到后面发现
那是一个**伪命题**，于是逐步不再往这个方向投入，仓库随之冷却、接近冻结。

它的 AFK 自动化是**另一件事**：8 个 workflow（`agent-implement` 及其 PR / PRD 变体、
`agent-review`、`agent-update-branch`、`agent-promote-queued`、`architecture-review`、
`afk-policy`）、一条本机 self-hosted runner、以及一条 `Workflow policy` 必需检查。
它们消耗宿主资源、要求持续维护（runner 在线、凭据有效、镜像可构建），而**换来的
是一个已经不再推进的方向上的自动化**。

判据不是"这个仓库不好"，是**投入与产出不再相称**：一条流水线要人维护，而它服务
的工作本身已经停了。留着的代价是真实的——self-hosted runner 常驻、每个 PR 都要等
一道与被改内容无关的检查、以及一份会随模板演进而持续要人跟的迁移负担。

## 决定

**停掉整条自动化链路，保留脚手架。**

停掉的：

- 8 个 AFK workflow（`git rm`）；
- `package.json` 的三个入口：`afk`、`ralph`、`afk:policy`；
- `CLAUDE.md` / `AGENTS.md` 里的 `afk-bootstrap:managed` 指令块（它指示 agent 进
  `/grill-with-docs` → `/to-spec` → `/to-tickets` 那条链，而那条链的终点正是被停掉的
  流水线）；
- 本机 runner：`auto-test-github-runner.service` 停用并向 GitHub 注销；
- 必需检查从 `Workflow policy` 换成 **`Verify`**。

保留的：

- `.sandcastle/`（54 个受跟踪文件）与 `docs/agents/`、`docs/afk-workflow.md`；
- `qa-plan.md` 里 AFK-B10/11/12 的**历史执行记录**；
- 本决策记录本身。

**为什么保留脚手架而不是一并删掉。** 删掉 `.sandcastle/` 是不可逆的：`upgrade-afk.sh`
的每一条锚点都指向那里的文件，文件没了就再也接不回来。而这个仓库的判断是「这个方向
不做了」，不是「永远不可能再碰」——保留脚手架让「将来想接回来」保持为一个**成本已知
的选项**（跑一次 upgrade），而删掉它把那个选项变成一次重写。

顺带：脚手架本身**不执行任何东西**，CI 里也没有任何一步碰它（`ci.yml` 从头到尾不
引用 `.sandcastle/`）。留着它是零运行成本，删掉它才是要付代价的那一边。

## 被否掉的方案

- **彻底删掉 `.sandcastle/` 与全部 AFK 文档。** 更"干净"，但不可逆。见上。

- **只停 runner，workflow 留着。** 会让每次触发**卡在 queued 直到超时**——PR 页面
  上看起来永远在等一个不会来的结果。比删掉更难看，也比删掉更难解释。

- **什么都不做。** runner 常驻、检查照跑、迁移照跟。在"不再往这个方向投入"的
  前提下，这些维护没有一个能换来对应的价值。

- **把必需检查整个摘掉，不留 merge gate。** 为了停一条自动化而把仓库的合并门槛
  永久降为零，代价与收益不成比例。改成 `Verify`（仓库自己那条真实测试）保留了
  一道门，而且它与被停掉的 AFK 无关。

## 后果

- **`Verify` 成为唯一必需检查**，它跑在 `ubuntu-latest` 上。这是实测过的：2026-10-13
  一次 `ubuntu-latest` 上的 `Verify` 跑完 success 且无计费注解。此前它"不稳定"的记录
  **全部**是计费锁造成的（4 次失败 run 逐个查过，每一次都带 billing 注解），不是同
  一批次里的用例随机失败。

- **本仓库不再是 AFK 消费方。** `afk-bootstrap` 将来的版本演进不再需要铺到这里；
  也**不要**对它跑 `upgrade-afk.sh` —— 那会把这次删掉的 workflow 又装回来。

- **将来若要恢复**：从 `afk-bootstrap` 重新 bootstrap（它会把 scaffold 与 workflow
  一起铺回来），或者只挑需要的步骤跑 `upgrade-afk.sh`。前者更简单，因为脚手架还在，
  路径是通的。

- **`agent:*` 标签不再有任何东西消费它们。** 仓库里可能还留着这类标签，它们现在是
  惰性的；没有 workflow 会读或写它们。

## 本记录顺带发现的一件事

按 AFK 的约定，决策记录由 `.sandcastle/adr.check.mjs` 判。本次是**第一次**对它跑
`--all`（它从来没被接进任何 workflow），跑出 **5 个既有问题**，全部在本次未改动的
记录里：

- `0001-agenthost-result-contract.md` — 缺「被否掉的方案」一节
- `0002-agenthost-execution-and-provider-boundary.md` — 同上
- `0002-trusted-pr-control-plane.md` — 缺 `Status:` 行、缺「被否掉的方案」一节
- **编号 `0002` 被两条记录占用**

这些都是**本次之前就存在的**，本记录没有改动那三条。记在这里而不是留白，是因为
随着 `afk-policy.yml` 被删除，这个门禁在本仓库**再也不会自动跑**——不写下来，
下一次看见它们的人只会看见一个没有出处的红。

修不修是另一个决定：那三条是历史记录，编造它们的"被否掉的方案"就是伪造论证，
唯一诚实的修法是把当时的取舍**真的**回忆出来。本仓库既然冻结，这件事按"知道且有
出处"处理，不顺手改。
