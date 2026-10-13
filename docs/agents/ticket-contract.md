# A ticket an agent can finish

The bar a ticket has to clear before an AFK engine may run it, and what to do
about a requirement that arrives from outside this repository.

`node .sandcastle/ticket-check.mjs` is the machine judgement; this document is
what it is judging, written for whoever has to satisfy it.

A label is an authorization, not a specification. `agent:implement` says *who*
may work the ticket; nothing above says whether the ticket is workable at all,
and the two questions have different answers often enough to matter. Measured on
this host before the rule existed: of twelve tickets carrying `ready-for-agent`
across three repositories, **one** carried acceptance criteria.

The bar is deliberately low, because a high one gets switched off. A leaf ticket
needs three things and is warned about two:

| | rule | what it catches |
|---|---|---|
| **fails** | a title and a body | a title is not a specification |
| **fails** | acceptance criteria | nothing says what "done" looks like, so the agent invents it |
| **fails** | something concrete — a file, symbol, command, or code span | the agent cannot tell where the change belongs, and guesses |
| **fails** | no unresolved choice | "preferred: A, fallback: B" means the pick *is* a decision |
| warns | an out-of-scope section | nothing bounds the change |
| warns | a problem statement | the reason is not written down |

Acceptance criteria count whether they arrive as a heading (`## Acceptance
criteria`, `验收`, `完成标准`, `期望行为`, `Done when`), as an inline
`Acceptance criteria:` label, or as a run of checkable steps — a verification
ticket with no heading and no file to change is still a ticket an agent can
finish, and failing it would only teach its author that the gate is noise.
Warnings never change the verdict.

When the contract genuinely lives elsewhere, or the ticket changes no artifact at
all, say so on its own line:

```
No-acceptance: figures come from docs/perf-baseline.md, asserted in test
```

That line is read, because a decision not to write something and a decision
forgotten look identical in a ticket — and only one of them is fine. It is not
authenticated: a line that merely *contains* `No-acceptance:` counts. What it
buys is that a reader sees a reason.

A waiver does **not** cover an unresolved choice. It says where the contract
lives; it cannot say which of two designs to build.

**A PRD is passed, not failed.** It is a container — the workflows refuse to
implement one and route it to its sub-issues — so this gate recognises it by the
same three headings `planner.ts` uses (`Problem Statement`, `Solution`, `User
Stories`, or a `PRD`/`[spec]` title) and exempts it. Its sub-issues each face
this check on their own.

Check one before authorizing it, or check a whole list:

```sh
node .sandcastle/ticket-check.mjs --title "…" --body-file /tmp/body.md
gh issue view 42 --json title,body | node .sandcastle/ticket-check.mjs --json
node .sandcastle/ticket-check.mjs --manifest list.json --min-pass 0.6
```

The workflows run this as a pre-flight: an authorized ticket that fails it is
refused, `agent:implement` is removed, `agent:blocked` is added, and the missing
items are written into the issue. `--manifest` takes a list from any tracker
(`{ data: [...] }` included) and reports how many are implementable, which is
the concrete answer to "is this backlog ready for agents" — it does not require
a connector to the tracker that holds it.

## The outer loop, and why it does not connect directly

Requirements do not originate in this repository. They arrive from a chat
channel, a requirements platform, a support queue — systems that are not
attached to the loop that implements them. Measured on one such platform on this
host: 14 of 14 active requirements in one project carry a title and an empty
specification.

So the discipline is:

**An external requirement becomes a ticket here before it is authorized here.**
The ticket is where acceptance criteria and a concrete location get written.
Connecting an agent directly to a requirements platform moves the problem rather
than solving it: the agent reads the same unspecified text, and now there is no
step in which anyone is forced to say what "done" means. Translate first, then
authorize — the translation is the work worth keeping, and it is the step a
connector would quietly remove.

When you finish work that came from an outside ticket, write the outcome back to
it: the branch, the pull request, and which acceptance criteria are now met.
A result that stays inside this repository is a result the next person to open
the source ticket has to rediscover.

## 中文

标签是**授权**，不是**规格**。`agent:implement` 说的是*谁*可以开工，上面没有任何一条
说这张单**能不能**开工——而这两个问题的答案经常不一样。规矩建立之前的实测：三个仓库里
带 `ready-for-agent` 的十二张单，**只有一张**写了验收标准。

门槛刻意压低，因为高门槛会被关掉。一张叶子单需要三样东西，另有两项只警告：

| | 规则 | 拦的是什么 |
|---|---|---|
| **失败** | 有标题也有正文 | 标题不是规格 |
| **失败** | 验收标准 | 没写"做完的样子"，agent 就会自己编一个 |
| **失败** | 一个有形的东西——文件、符号、命令或代码跨度 | agent 看不出改动落在哪，只能猜 |
| **失败** | 没有未决的二选一 | "首选 A / 次选 B"意味着**选，本身就是决策** |
| 警告 | 非目标一节 | 改动没有边界 |
| 警告 | 问题陈述 | 缘由没有写下来 |

验收标准用哪种写法都算：标题（`## Acceptance criteria`、`验收`、`完成标准`、`期望行为`、
`Done when`）、行内标签 `Acceptance criteria:`、或者一串可核对的步骤——一张"跑这四条、
报告结果"的取证单没有标题、也不改文件，它照样是 agent 能做完的单，判它不合格只会教会
作者这个门是噪声。警告永不改变结论。

契约确实在别处、或这张单不改任何产物时，自己写一行说明：

```
No-acceptance: 数字来自 docs/perf-baseline.md，测试里已断言
```

这一行是会被读的，因为"有意不写"和"忘了写"在一张单里长得一模一样——只有其中一种是
可以的。它不做鉴权：一行里**含有** `No-acceptance:` 就算。它买到的是：读的人看到一个理由。

豁免**不覆盖未决的二选一**。它说的是契约在哪，说不了两个方案里做哪个。

**PRD 是放行，不是拦。** 它是容器——工作流本来就拒绝直接实现它、把它路由到子单——
所以本判据用 `planner.ts` 同一套判据认出它（`Problem Statement` + `Solution` +
`User Stories` 三个标题，或标题里有 `PRD`/`[spec]`）并豁免。它的子单各自过这道门。

授权前查一张，或查一整批：

```sh
node .sandcastle/ticket-check.mjs --title "…" --body-file /tmp/body.md
gh issue view 42 --json title,body | node .sandcastle/ticket-check.mjs --json
node .sandcastle/ticket-check.mjs --manifest list.json --min-pass 0.6
```

工作流把它当 pre-flight 跑：已授权的单过不了就拒绝、摘掉 `agent:implement`、
打上 `agent:blocked`，并把缺的项写进 issue。`--manifest` 接受任何需求平台的列表
（含 `{ data: [...] }`），报出其中多少条可实现——这是"这批单能不能交给 agent"的可执行
答案，而它**不需要**连到那个平台。

### 外环，以及为什么不直连

需求不是从本仓库长出来的。它从聊天频道、需求平台、客服队列进来——这些系统**不连**着
实现它的那个环。本机某需求平台的实测：一个项目里 14/14 条活动需求**只有一个标题**，
规格为空。

所以纪律是：

**外部需求先变成这里的一张单，再在这里被授权。** 单才是写验收标准和改动落点的地方。
把 agent 直连到需求平台是把问题搬了个位置，不是解决：agent 读到的是同一段没规格的文字，
而且现在**少了一步**——原本那一步会逼着某个人说清"做完的样子"。先翻译，再授权——翻译
才是值得留下的工作，而那正是连接器会悄悄省掉的一步。

做完了来自外部单的工作，把结果写回那张单：分支、PR、以及哪几条验收标准已满足。
结果留在本仓库里，等于下一个打开源单的人要重新发现一遍。
