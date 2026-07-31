# 跨场景 AI 自动化测试快速操作指南

本框架用于把“目标网站 URL + 测试用例 Excel”自动转换为可执行测试：

`Intake -> AI Planner -> 页面探索 -> Refiner -> Policy Gate -> Runtime -> 测试结果`

测试工程师不需要编写或修改 Execution Plan。登录、权限和业务前置条件需要在首次接入环境时注册一次。

## 推荐方式：交互入口

Windows 用户双击仓库根目录的 `Auto-Test.cmd`。启动器会自动安装 Node.js、固定版本 Codex CLI、项目依赖和 Chromium，并通过隐藏输入配置自定义 Responses API，不需要 `codex login`。

其他系统执行：

```bash
npm ci
npx playwright install chromium
npm run easy
```

中文菜单会完成环境检查、浏览器登录会话注册、Excel 选择、URL 输入、自动输出目录和结果摘要。详细操作见 [Windows 双击使用指南](windows-quick-start.md)。

下文是适合 CI、脚本接入或高级故障排查的完整命令行方式，日常测试不需要手工操作这些文件。

## 1. 高级准备

高级命令行方式要求 Node.js 24 或更高版本，并确保 Codex CLI 已配置可用的自定义 API Provider。首次使用先安装依赖和浏览器：

```bash
npm ci
npx playwright install chromium
npm run check
```

每次执行准备以下输入：

- 必填：测试用例 `.xlsx` 文件；
- 必填：所有待访问网站的 URL；
- 可选：测试工程师的补充说明文件，通过 `--brief` 提供；
- 可选：Excel 外的步骤截图，通过多个 `--image` 提供。

Excel 可以是标准测试用例表，也可以是“阶段标题 + 操作说明 + 图片”的流程表。Excel 内嵌图片会自动提取。

不要把账号、密码、验证码、手机号列表或 Token 写入 Git、命令行参数和补充说明文件。

## 2. 高级环境配置

公开且无需登录的只读网站可以跳过本节。登录网站或包含写操作的网站，应先创建环境 Profile。

默认配置位置：

```text
Linux/macOS: ~/.config/auto-test/environment-profiles.json
Windows:     %APPDATA%\auto-test\environment-profiles.json
```

可以从模板开始：

```bash
mkdir -p ~/.config/auto-test
cp templates/environment-profiles.example.json ~/.config/auto-test/environment-profiles.json
chmod 600 ~/.config/auto-test/environment-profiles.json
```

修改 Profile 时只登记以下内容：

- `origins`：允许访问的网站 origin；
- `auth`：登录页、登录成功判据和已验证的登录控件；
- `secretVaultPath`：私有账号和测试数据文件；
- `plannerContextPath`：不含秘密的业务规则和环境说明；
- `policy`：是否允许写入、删除及自动修订次数。

完整字段见 [Environment Profile 模板](../templates/environment-profiles.example.json)。

Secret Vault 示例：

```json
{
  "staging.admin.username": "your-test-user",
  "staging.admin.password": "your-test-password"
}
```

所有 Secret Vault、`storageState`、`sessionStorage` 和 Planner Context 文件都必须位于仓库外，并设置为当前用户私有。Linux/macOS 使用：

```bash
chmod 600 /private/path/to/file
```

Windows 使用用户目录的 NTFS ACL，具体操作见 [Windows 快速操作指南](windows-quick-start.md)。

默认保持 `allowWrite: false`、`allowDestructive: false`。只有获得明确授权且用例包含恢复或清理步骤时才开启对应权限。

## 3. 高级命令行执行

推荐先跑单条数据 canary：

```bash
npm run autonomous:workflow -- \
  --file /private/cases.xlsx \
  --url https://app.example.test/ \
  --url https://admin.example.test/ \
  --profile staging-example \
  --brief /private/test-brief.txt \
  --image /private/extra-step.png \
  --max-iterations 1 \
  --iteration-offset 0 \
  --output-dir artifacts/runs/example-canary
```

只有一个 Profile 能匹配全部 URL 时，可以省略 `--profile`。没有补充说明或图片时，删除对应参数即可。

canary 通过后执行完整数据集：

```bash
npm run autonomous:workflow -- \
  --file /private/cases.xlsx \
  --url https://app.example.test/ \
  --url https://admin.example.test/ \
  --profile staging-example \
  --output-dir artifacts/runs/example-full
```

运行过程中框架会自动生成并迭代 Draft，使用真实页面证据修复定位器和流程，再通过 Policy Gate 生成 Execution Plan。不要手工修改生成的 Plan。

## 4. 查看结果

首先查看 Job 终态：

```bash
jq '{status, outcome, stage, round, executionAttempts, humanInputRequestPath, runtimeResultPath}' \
  artifacts/runs/example-full/autonomous-job.state.json
```

终态含义：

| outcome | 含义 | 后续处理 |
|---|---|---|
| `passed` | 执行计划、步骤和业务断言全部通过 | 保存报告并进入回归使用 |
| `product_failed` | 页面操作完成，但业务断言仍失败 | 按产品缺陷或测试数据问题处理，不要修改预期结果规避失败 |
| `blocked` | 缺少认证、权限、业务规则、数据、恢复能力或环境条件 | 查看 `human-input-request.json` 和诊断信息，补充后重新执行 |

主要产物位于本次 `--output-dir`：

- `intake.workflow.json`：从 Excel 解析出的工作流清单；
- `round-N.plan-draft.json`：第 N 轮 AI Draft；
- `round-N.exploration.json`：真实页面探索证据；
- `workflow.execution-plan.json`：Policy Gate 批准的执行计划；
- `runtime-attempt-N.result.json`：Runtime 步骤、断言、实体和 Mutation 结果；
- `autonomous-job.state.json`：整个任务的最终状态；
- `human-input-request.json`：需要人员补充的结构化问题，仅在阻断时生成。

## 阻断后怎么继续

1. 阅读 `human-input-request.json`，确认缺少的是账号、权限、业务规则、测试数据还是环境能力。
2. 将账号和测试数据补入 Secret Vault；将非秘密业务规则补入 Planner Context；按授权调整 Profile policy。
3. 如果此前发生写入，先确认目标系统已恢复或本轮创建的数据已清理。
4. 只更新凭据、租户状态或权限策略时，使用相同 `--output-dir` 重新运行，Controller 会读取持久化状态继续处理。
5. 如果修改了 URL、`--brief`、图片、Profile ID 或 Planner Context，请改用新的 `--output-dir` 启动新任务，因为请求内容已经改变。

不要删除状态文件来掩盖未恢复的 Mutation，也不要手工放宽断言或伪造页面证据。

## 使用边界

- 框架已经支持只读巡检、后台 CRUD、多网站业务闭环、批量数据隔离和补偿清理。
- 新登录环境仍需一次性注册凭据、认证控件和成功判据。
- OTP 来源、租户权限、真实设备状态和第三方系统授权无法只从 URL 推断，缺失时会主动阻断并要求补充。
- 写入和删除测试只允许操作本轮授权范围内的测试数据，并必须有可验证的恢复或清理结果。
