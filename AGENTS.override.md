# Codex entry — AFK workflow quick-start

> **This file is auto-copied to every project root by `afk-bootstrap` — same
> role as `AGENTS.md` / `CLAUDE.md` but written for **Codex** (OpenAI Codex
> CLI). Codex does not auto-load `.claude/skills/` or `AGENTS.md`; this
> file is the explicit entry point for Codex on AFK-scaffolded projects.

You are working in a project scaffolded with **afk-bootstrap**. The
infrastructure (planner loop, label Actions, prompt templates, sandcastle
sandbox, scripts) is already in `.sandcastle/` — your job is to act within
that infrastructure, not reinvent it.

## Read these first (truth sources)

1. `CONTEXT.md` — domain language + invariants; treat as the spec.
2. `.sandcastle/CODING_STANDARDS.md` — engineering standards for commits/PRs.
3. `docs/afk-workflow.md` — entry convention (idea → grill → spec → tickets
   → implement → review → merge) and the label & engine table.
4. `AGENTS.md` (if present) — agent-facing notes local to this repo.
5. `CLAUDE.md` (if present) — same intent, Claude-oriented.

## Commands at a glance

| Goal | Command |
|---|---|
| Implement a single open issue (host-controlled) | `pnpm afk -- <issue-number>` |
| Run the planner (depend. graph → parallel → delivery PR) | `pnpm ralph` (set `AFK_RALPH_ITERATIONS` / `AFK_RALPH_PARALLEL` as needed) |
| Split a PRD into native sub-issues | `pnpm prd:to-issues -- <prd-number>` |
| Add a self-hosted runner / image build | see `docs/afk-workflow.md` |

The runner builds `sandcastle:<repo>` once via the bootstrap; rebuild only
when Dockerfile/plan-prompt/profile change.

## Label & engine table (read this carefully — it prevents the recurring
"agent grabbed my issue" confusion)

| Label | Means | Who acts |
|---|---|---|
| `ready-for-agent` | queued for the planner | `pnpm ralph` |
| `agent:implement` | legacy single-issue trigger — **does NOT auto-run** | `gh workflow run agent-implement.yml -f issue_number=N` |
| `agent:review` / `agent:update-branch` | PR review / conflict resolve | dispatch or PR-driven |
| `agent:to-issues` | split a PRD into sub-issues | `pnpm prd:to-issues` or label-driven |

**Rule:** one issue, one engine. Do not re-add `agent:implement` to "make
things run" — dispatch the workflow explicitly.

## Execution paths (architecture sanity check)

- **Planner (`pnpm ralph`)** uses the upstream-identical docker-worktree
  sandbox (`createSandbox` + `docker()` + `close()`); per-issue worktree
  auto-cleaned. `.sandcastle/worktrees/` is gitignored.
- **Label-Action implement/review** runs on the self-hosted runner's
  **persistent workspace** (`git checkout -b` + a `docker()` container for
  isolation/profile). Not a per-issue worktree; `agent/*` branches persist
  between runs and can accumulate. The runner checkout now `reset --hard`
  + `clean` first to avoid stale-state failures.

## Model provider

The model is server-global, not per-repo. Set `AFK_PROFILE=claude-ark |
psydo | aliyun-deepseek` (or `claude`) when running locally. In the
self-hosted runner workflow, set the `AFK_PROFILE` repo variable.

For stability, the planner and codex provider config set:
- `AFK_REQUEST_TIMEOUT` (default 120s) — per-request timeout
- `AFK_REQUEST_RETRIES` (default 2)
- `AFK_RUN_TIMEOUT` (default 3600s) — implement/review wall-clock
- `AFK_MERGE_TIMEOUT` (default 3600s) — merge wall-clock

## Codebase exploration

If the `codebase-memory` MCP is available in your Codex config
(`mcp_servers.codebase-memory` entry, see `docs/afk-tooling.md` for the
snippet), prefer it for structure queries:

```
mcp__codebase-memory-mcp__search_graph(project="<repo-slug>", query="...")
mcp__codebase-memory-mcp__get_architecture(project="<repo-slug>", aspects=["all"])
mcp__codebase-memory-mcp__trace_path(project="<repo-slug>", function_name="...")
```

For full-file reads, grep, or when no index exists, fall back to standard
tools.

## What NOT to do

- Do not "helpfully" close issues on your own. Delivery PR references close
  them only after the hosting service merges the PR.
- Do not strip labels on your own.
- Do not push to `main` directly. Every planner batch ends at a delivery PR.
- Do not re-derive the architecture; it is in `CONTEXT.md` + `docs/adr/`.
