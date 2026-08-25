# AFK development tracer bullet

The first development loop is intentionally local and single-issue:

Select the model supply explicitly. The profile is resolved on the server and
credentials never belong in the repository:

```bash
# GPT via Psydo Responses API
AFK_PROFILE=psydo pnpm afk -- <issue-number>

# DeepSeek V4 Pro via Alibaba Cloud Model Studio Responses API
AFK_PROFILE=aliyun-deepseek pnpm afk -- <issue-number>

# GLM via the configured Ark Claude-compatible endpoint
AFK_PROFILE=claude-ark pnpm afk -- <issue-number>

# Direct Claude profile from .sandcastle/.env
AFK_PROFILE=claude pnpm afk -- <issue-number>
```

The `psydo` profile uses Sandcastle's Codex provider and `gpt-5.6-sol` by
default. Override the model only when the selected provider supports it:

```bash
AFK_PROFILE=psydo AFK_MODEL=gpt-5.6-sol pnpm afk -- <issue-number>
AFK_PROFILE=claude-ark AFK_MODEL=glm-latest pnpm afk -- <issue-number>
AFK_PROFILE=aliyun-deepseek AFK_MODEL=deepseek-v4-pro-0813 pnpm afk -- <issue-number>
```

GitHub Actions reads the repository variable `AFK_PROFILE` and defaults to
`psydo`. Set it to `claude-ark`, `psydo`, or `aliyun-deepseek` to select the
provider; workflow files do not need editing. The Alibaba credential and
endpoint are read from the server-local `AFK_ALIYUN_CSV` path and are never
committed.

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
AFK_PROFILE=claude-ark pnpm ralph
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
