# AFK development tracer bullet

The first development loop is intentionally local and single-issue:

Select the model supply explicitly. The profile is resolved on the server and
credentials never belong in the repository:

```bash
# StepFun — the AFK default
AFK_PROFILE=claude-stepfun pnpm afk -- <issue-number>

# Direct Claude profile from .sandcastle/.env
AFK_PROFILE=claude pnpm afk -- <issue-number>
```

Both profiles are one host settings file, mounted read-only into the sandbox
rather than baked into the image:

| profile | endpoint | host file |
|---|---|---|
| `claude` | the Anthropic API | whatever credential the host shell exports |
| `claude-stepfun` | StepFun's native Anthropic Messages API | `~/cliproxyapi/settings.stepfun.json` |

The model comes from the `ANTHROPIC_DEFAULT_*_MODEL` entries in that file, so
`AFK_MODEL` is only needed to override it:

```bash
AFK_PROFILE=claude-stepfun AFK_MODEL=step-5-preview pnpm afk -- <issue-number>
```

Set `AFK_STEPFUN_SETTINGS` when the settings file lives elsewhere.

Rotating the token is an edit to that host file — there is no image rebuild and
no `--no-cache` to remember. Nothing about the endpoint enters an image layer.

GitHub Actions reads the repository variable `AFK_PROFILE`; the workflow files
fall back to `claude-stepfun` when it is unset, so they do not need editing to
switch.

### Retired profiles

`claude-ark`, `agentrouter`, `psydo`, and `aliyun-deepseek` were removed by the
1.2.0 template. The first three resolved to host settings files under
`cliproxyapi/` whose upstream quota is exhausted, so any run selecting them
failed before the agent started; `aliyun-deepseek` was the only Codex-provider
profile, so retiring it also dropped the Codex agent path from this repository's
AFK setup. Their server-local credential files (`aliyun-deepseek.csv`,
`codex.*.toml`, `psydo-primary.key`) are no longer read here.

The runner creates an isolated Docker worktree on `agent/issue-<number>` (or
the `AFK_BRANCH` override), runs at most three iterations, and leaves delivery
to the host. The container may edit, test, and commit, but must not push,
merge, close issues, or mutate GitHub state. Review the resulting branch and
run the repository checks before opening a pull request.

## Planner orchestration (`pnpm ralph`)

Beyond the single-issue runner, a planner loop ports the upstream
`course-video-manager` orchestration: Plan → parallel Implement + Review →
Merge.

```bash
# Planner loop over `ready-for-agent` open issues (max 4 in parallel)
AFK_PROFILE=claude-stepfun pnpm ralph
```

Each iteration:

1. **Plan** — a planner agent lists open issues labelled `ready-for-agent`,
   builds a dependency graph, and emits `<plan>{issues[]}</plan>` for the
   unblocked ones.
2. **Execute + Review** — each issue is implemented and reviewed in its own
   Docker worktree (`agent/issue-<n>-<slug>`), up to `AFK_RALPH_PARALLEL`
   (default 4) at once. `AFK_INSTALL_CMD` (default `npm ci`) runs on the host
   worktree before each agent starts.
3. **Merge** — a merger agent merges the completed branches into `main`, runs
   `npm run check`, then **pushes `main` and closes the issues from inside the
   container**. This deliberately overrides the "host owns delivery" rule for
   the planner loop (container needs a GH token, injected from the server's
   `~/.config/gh/hosts.yml`).

Tuning: `AFK_RALPH_ITERATIONS` (default 10), `AFK_RALPH_PARALLEL` (default 4).

The single-issue runner and the PRD Actions keep the original "host owns
delivery" boundary — only the planner loop's merge phase pushes from the
container.
