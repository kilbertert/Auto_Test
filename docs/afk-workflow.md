# AFK development workflow — entry convention

How a rough idea becomes merged code in this repo, driven by the AFK agents.
Adapted from `mattpocock/course-video-manager/.sandcastle`. The tools are the
user's installed Matt Pocock skills plus this repo's `.sandcastle` machinery.

## The path

```
idea
  → /grill-with-docs      sharpen the idea into confirmed terms + decisions
  → /to-spec              write the PRD (as a GitHub parent issue)
  → /to-tickets           break the PRD into native sub-issues
  → implement             a sub-issue or single issue gets implemented
      • label agent:implement (self-hosted Actions) — or
      • pnpm ralph (planner loop) / pnpm afk (single issue)
  → review                agent:review on the PR → review.ts (two-axis)
  → merge
```

## Step by step

1. **Grill** — `/grill-with-docs` (or `/grill-me` without repo context):
   pressure-test boundary/risk/acceptance; write confirmed terms into
   `CONTEXT.md` and `docs/adr/`.
2. **Spec** — `/to-spec`: turn the idea into a PRD (a GitHub **parent issue**),
   concrete enough for a sub-issue agent to implement without re-deriving.
3. **Tickets** — `/to-tickets`: break the PRD into flat, execution-ordered
   **native sub-issues**. Label the parent `agent:to-issues` (or run
   `pnpm prd:to-issues -- <PRD>`).
4. **Implement** — label a `ready-for-agent` issue `agent:implement` (self-hosted
   runner → branch → draft PR → `agent:review`); or `pnpm ralph` (planner loop);
   or `pnpm afk -- <issue>` (controlled single issue, host delivers).
5. **Review** — label the PR `agent:review`: two-axis `code-review` skill,
   fix/improve, reply to threads; `agent:update-branch` resolves conflicts.

## Labels & engines (one queue, two explicit runners)

**No auto-claim.** An issue label is a queue marker, never a self-running
trigger — nothing implements your issues until you run an engine.

| Label | Means | Who acts |
|---|---|---|
| `ready-for-agent` | queued for the planner | `pnpm ralph` (dependency graph -> parallel -> delivery PR) |
| `agent:implement` | legacy single-issue trigger — no longer auto-runs (dispatch-only) | `gh workflow run agent-implement.yml -f issue_number=N` |
| `agent:review` / `agent:update-branch` | PR review / conflict-resolve | review / update-branch workflows |

Rules:
- One issue, one engine: label `ready-for-agent` for the planner; or run
  `pnpm afk -- <issue>` for a single controlled issue (no label).
- Split a PRD by labeling the parent `agent:to-issues`, then `ready-for-agent`
  the sub-issues you want the planner to implement.
- `agent:implement` never auto-runs; dispatch it explicitly if you want the PR
  flow.


## Rules

- Profiles are server-global (`claude`, `claude-ark`, `agentrouter`, `psydo`,
  `aliyun-deepseek`); pick via the `AFK_PROFILE` repo variable. `agentrouter`
  uses server-managed Claude settings and supports `AFK_AGENTROUTER_SETTINGS`
  as an operator override. No repo-side credentials.
- The planner merge phase integrates into a delivery branch; the host pushes
  that branch and opens a PR. Neither planner nor single-issue `pnpm afk`
  pushes the default branch.
- Deterministic checks are the gate: the repo's full check before any commit;
  PRs go through CI.
- Never hardcode secrets. Keep `CONTEXT.md` and `.sandcastle/CODING_STANDARDS.md`
  current — they are the agents' contract.
