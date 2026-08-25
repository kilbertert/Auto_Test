# AFK development tracer bullet

The first development loop is intentionally local and single-issue:

Select the model supply explicitly. The profile is resolved on the server and
credentials never belong in the repository:

```bash
# GPT via Psydo Responses API
AFK_PROFILE=psydo pnpm afk -- <issue-number>

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
```

GitHub Actions reads the repository variable `AFK_PROFILE` and defaults to
`psydo`. Set it to `claude-ark` to move PRD runs to GLM, or back to `psydo` for
GPT; workflow files do not need editing.

The runner creates an isolated Docker worktree on `agent/issue-<number>` (or
the `AFK_BRANCH` override), runs at most three iterations, and leaves delivery
to the host. The container may edit, test, and commit, but must not push,
merge, close issues, or mutate GitHub state. Review the resulting branch and
run the repository checks before opening a pull request.

The current tracer bullet does not yet include grill-me, PRD decomposition,
GitHub Actions, QA issue automation, or parallel agents.
