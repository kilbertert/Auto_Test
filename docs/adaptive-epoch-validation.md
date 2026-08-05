# 自适应 Epoch Runtime 验证记录

更新时间：2026-08-05

本记录只说明运行时架构和恢复契约的验证结果。当前没有新的真实故障案例，因此不得把以下 fixture、历史输入回放或模型容量估算写成业务准确率验收。

## 确定性检查

执行：

```bash
npm run check
```

结果：

- TypeScript typecheck 通过；
- 45 个测试文件、299 个测试通过；
- `tsc -p tsconfig.json` 构建通过；
- 覆盖容量规划、稳定 epoch ID、单 case Manifest 限制、逐 case 幂等存储、thread 轮换、active epoch 恢复、finalization-only 恢复、pending Mutation 停止调度和旧版状态 fail closed。

## 285-case 历史输入只读回放

使用仓库中已有的 285-case 历史 Manifest，只运行新的容量规划器，不启动浏览器、不调用模型、不修改历史 artifact。

默认容量策略结果：

| 项目 | 结果 |
| --- | ---: |
| case 总数 | 285 |
| execution epoch 数 | 32 |
| 单 epoch case 数 | 6-9 |
| 平均单 epoch case 数 | 8.91 |
| 原完整 Manifest | 294,030 bytes |
| 最大 scoped Manifest | 14,173 bytes |
| 估算最大 epoch 输出 | 8,100 tokens |

历史全量结构化交付约为 130-203 KB。旧单线程路径要求同一模型上下文读取完整 Manifest，并在一个 finalization turn 中返回全部 case；新路径只要求 Codex 返回当前有界 epoch，逐 case 事实落盘后由 Runner 按 Manifest 顺序聚合，因此不再依赖模型一次输出完整 285-case JSON。

## 已验证恢复边界

- epoch 完成后先写逐 case store，再进入 checkpoint；
- thread 轮换不改变逻辑 Run、输入身份、工作区、证据、环境需求或 Mutation Ledger；
- active epoch 在 `executing` 中断时可重新规划容量并恢复现场；
- active epoch 在 `finalizing` 中断时只恢复结构化交付，不重放业务执行；
- 已完成 case 的记录在恢复后不被重写；
- pending Mutation 会阻止后续 epoch，并为未调度 case 生成明确的 `blocked` 结果；
- `version: 1.0` 及旧 `single_thread/case_windows` 状态不会被猜测迁移。

## 真实 LTA 只读 canary

使用真实 `LTA后台测试用例.xlsx`、已注册 Profile `lta-readonly-canary` 和真实 LTA 页面执行第一条登录 case。该运行使用本地 Provider 的 `gpt-5.6-sol` Responses 协议，输出目录为：

```text
artifacts/acceptance/adaptive-epoch-lta-one-sol-redacted-20260805
```

结构化验收结果：

- `passed`，1/1 case passed；
- state `version: 2.0`，1 个 epoch，`threadGeneration: 1`；
- 7 条 case 证据、2 条 case 回执、31 条完整执行回执；
- 逐 case store、epoch 交付 artifact 和结果工作簿均存在；
- Mutation Ledger `pending=0`，Environment Requirement 数量为 0；
- 运行期间发生一次模型流式连接中断，Codex 自动重连后继续完成，未误报业务失败；
- `agent-workspace` 及其排除原始输入后的外部文本制品精确 secret 命中为 0。

这证明当前修复工作树可以在真实 LTA 登录场景中完成只读业务 canary，并在 Provider 中断后继续交付。但它不是 285 条正式 LTA 的业务准确率验收，也没有真实故障案例；用户名在截图中仍可见，运行目录只能留在受控测试环境，截图/PDF 外发前必须人工脱敏。

本轮还记录了两个未纳入本修复分支的基础设施边界：提供的直连 Key 对 `https://api.psydo.top/v1/{models,responses}` 返回 401；当前 Codex CLI 拒绝 `wire_api = "chat"`，因此仓库现有 Chat Profile 不能直接启动。正式 Windows 运行必须使用已确认可用的 Responses Provider/Key，不能把这两次阻断当作业务失败。

## 尚未完成

- 本次重构尚未在 Windows runner 上重新构建和解压验证便携 ZIP；
- 尚未用真实 285-case 网站执行验证模型调用、浏览器稳定性和长时间心跳；
- 尚无真实故障案例，不能确认业务判断准确率；
- 尚未在 Windows runner 上用包含本修复的私有 ZIP 重新构建、解压和执行上述 LTA canary；
- 尚未以可公开访问的有效 Responses Provider/Key 完成 Windows 外部网络验收；
- 历史充电 canary 是旧运行时证据，只能作为历史参考，不能证明本次 epoch 重构覆盖新的 LTA 正式套件。
