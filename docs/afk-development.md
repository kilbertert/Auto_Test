# AFK development tracer bullet

The first development loop is intentionally local and single-issue:

Select the model supply explicitly. The profile is resolved on the server and
credentials never belong in the repository:

```bash
# StepFun — the AFK default (see below)
AFK_PROFILE=claude-stepfun pnpm afk -- <issue-number>

# Direct Claude profile from .sandcastle/.env
AFK_PROFILE=claude pnpm afk -- <issue-number>
```

`claude-stepfun` bakes its endpoint into the sandbox image rather than reading a
host settings file, so it has no `AFK_*_SETTINGS` override and nothing to mount.
Rebuilding the image therefore needs the key, passed as a BuildKit secret —
never a build arg, which `docker history` would expose:

```bash
DOCKER_BUILDKIT=1 docker build \
  --secret id=stepfun_api_key,src=/run/secrets/stepfun_api_key \
  -t sandcastle:auto-test-governance .sandcastle
```

Add `--no-cache` whenever the key changes. A secret mount does not invalidate the
layer cache, so a rotation would silently rebuild an image still carrying the old
key, and the failure surfaces later as an authentication error at run time rather
than at build time. A build with the secret missing does fail, because the mount
is declared `required=true`.

The base URL is the provider root preceding `/v1` (Claude Code appends
`/v1/messages` itself), and the profile uses the default bridge network rather
than `network: host`.

GitHub Actions reads the repository variable `AFK_PROFILE`; workflow files fall
back to `claude-stepfun` when it is unset, so they do not need editing to switch.

### Retired profiles

`claude-ark`, `agentrouter`, `psydo`, and `aliyun-deepseek` were removed. The
first three resolved to host settings files under `cliproxyapi/` whose upstream
quota is exhausted — every AFK model call failed, which is why the `claude-ark`
default was replaced. `aliyun-deepseek` was the only Codex-provider profile here,
so removing it also dropped the Codex agent path from this repository's AFK
setup; `claude-stepfun` and `claude` both run Claude Code. Their server-local
credential files (`aliyun-deepseek.csv`, `codex.*.toml`, `psydo-primary.key`)
are no longer read by this repository.

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
