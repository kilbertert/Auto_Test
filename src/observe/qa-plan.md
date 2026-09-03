# 观测面板 QA 计划(切片 #171:服务器骨架 + 运行列表)

范围:只读观测服务器的启动/关闭、运行列表正确性、隐私边界。后续切片(详情/SSE/证据查看)另行扩展本计划。

**执行记录(2026-09-03,Linux x64 / Node 24.15,commit 见 PR,实施者 Claude Code)**:OBS-1 至 OBS-5 全部通过。OBS-1/3 以 curl 等价(HTML 200 + `Auto-Test 观测面板` 标题、`/api/runs` 排序 running 在前、corrupt run 显示 invalid);OBS-4 秘密标记 `OBS-SECRET-MARKER` 在 `/` 与 `/api/runs` 响应中出现 0 次,`.agent-private/run-values.json` 直读 404;OBS-5 仅绑定 `127.0.0.1:35453`,未知路径 404、POST 405,关闭后端口释放。fixture 已清理。

| ID | 环境 | 前置条件 | 测试数据 | 步骤 | 预期可观察结果 | 清理 |
|----|------|---------|---------|------|--------------|------|
| OBS-1 | Linux x64,Node ≥24 | 仓库构建通过 | 两个合成运行目录(一个 completed/passed,一个 running/finalizing),写入平台运行根目录 | 运行 `npm run easy -- dashboard`,浏览器打开打印的 URL | 页面标题"Auto-Test 观测面板";列表含两个运行,running 在前;状态徽标与结果列正确;时间为本地化格式 | Ctrl+C 退出服务;删除合成运行目录 |
| OBS-2 | Linux x64 | 无 | 空的平台运行根目录(或不存在) | 同 OBS-1 | 页面显示"还没有任何运行记录",无错误,无 500 | 同上 |
| OBS-3 | Linux x64 | 无 | 一个运行目录,状态文件内容为 `not json` | 同 OBS-1 | 该运行显示"无法读取"徽标;列表不报错 | 同上 |
| OBS-4 | Linux x64 | 无 | 合成运行 + `.agent-private/run-values.json` 内放置标记字符串 `OBS-SECRET-MARKER` | 打开面板,同时用 curl 请求 `/`、`/api/runs` | 任何响应正文不含 `OBS-SECRET-MARKER`;对 `.agent-private/` 下路径的直接请求 404 | 同上 |
| OBS-5 | 任意 | 服务已启动 | 无 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/` 后检查 `ss -tlnp` 绑定地址 | 端口仅绑定 127.0.0.1;Ctrl+C 后端口释放(`ss` 无监听) | 无 |

自动化对应:tests/observe-server.test.ts 已覆盖 OBS-1/2/3 的投影逻辑与 OBS-4 的 404 边界(合成 fixture);OBS-4 的秘密标记不变量与 OBS-5 的 loopback 绑定在测试 `rejects non-GET methods and unknown paths`、`binds to loopback only` 中固化。手动步骤 OBS-1/2/3/5 属浏览器交互,在 PR 合并前由实施者执行一次并回填结果。

**SSE 切片(#173)追加(2026-09-03 执行)**:tests/observe-run-events.test.ts 6 个测试自动化覆盖——连接即推 state 快照 + 事件行;文件变化 2s 内推增量(state 推进 + events 追加);15s 心跳注释行;未知/穿越 runId 404;客户端断开后 close 幂等且端口可复用;**脱敏纵深不变量**(上游 redact 缺口留下 credential-shaped 值时,SSE 输出仍被 `redactAgentArtifactValue` 二次脱敏,JWT 原文零出现)。手动浏览器验证(进行中 Run 详情页 EventSource 自动刷新)合并前用 QA fixture 复验一次。

**证据查看切片(#174)追加(2026-09-03 执行)**:tests/observe-evidence.test.ts 5 个测试自动化覆盖——evidence 目录内 png/txt 按 content-type 返回(浏览器可直接渲染);未知扩展(.bin)与原始工作簿副本拒绝;穿越/绝对路径/编码逃逸(`..`、`%2e%2e%2f`、`../../etc/passwd`、`.agent-private` 直读)全部 404;result 契约路径形态(`evidence/<file>` 与剥前缀)可打开;全部 API 响应零 `OBS-SECRET-MARKER` 泄漏。allowlist 为显式扩展名清单(png/jpg/jpeg/gif/webp/txt/log/md/json),路径必须 resolve 在 `agent-workspace/evidence` 内,单文件上限 20MB。

**端到端终验(#175,2026-09-03 执行,Linux x64 / Node 24.15)**:以合成运行目录(进行中 Run + evidence PNG + `.agent-private` 秘密标记)对真实服务器执行全路由手动 QA——① 首页渲染;② 列表(running/executing);③ 详情投影(epoch 1/2、完成 1、摘要标题"测试仍在运行");④ SSE 连接即推 state 快照;⑤ 证据 PNG 200 image/png;⑥ `.agent-private` 直读 404;⑦ 全路由秘密标记零出现;⑧ events 文件推进后 SSE 增量 2s 内到达(实测秒级)。Windows 打包面验证:dashboard 页面为 TS 模块内嵌字符串,经 `npm run easy`/tsx 天然可用,启动器(launch-windows.ps1)纯转发零改动,便携包无需额外资源文件。文档同步:README 观测面板节、POSIX/Windows quick-start、easy 帮助文本、CONTEXT.md 观测面/控制面词条。
