# AFK development tracer bullet

The first development loop is intentionally local and single-issue:

```bash
cp .sandcastle/.env.example .sandcastle/.env
# set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in .sandcastle/.env
npm run afk -- <issue-number>
```

The runner creates an isolated Docker worktree on `agent/issue-<number>` (or
the `AFK_BRANCH` override), runs at most three iterations, and leaves delivery
to the host. The container may edit, test, and commit, but must not push,
merge, close issues, or mutate GitHub state. Review the resulting branch and
run the repository checks before opening a pull request.

The current tracer bullet does not yet include grill-me, PRD decomposition,
GitHub Actions, QA issue automation, or parallel agents.
