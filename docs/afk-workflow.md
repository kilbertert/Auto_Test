# AFK development workflow — entry convention

How a rough idea becomes merged code in this repo, driven by the AFK agents.
This is the repo-level convention (adapted from
`mattpocock/course-video-manager/.sandcastle`); the tools it references are the
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

### 1. Grill — `grill-with-docs` (or `grill-me` without repo context)

Before writing anything, pressure-test the idea: boundary, risk, acceptance.
`grill-with-docs` writes the confirmed terms and decisions into `CONTEXT.md`
and `docs/adr/` so the later spec/implementation read the same language.
This is the DDD "unified language" step — do not skip it for anything
non-trivial.

### 2. Spec — `/to-spec`

Turn the grilled idea into a PRD (a GitHub **parent issue**). The PRD is a
*spec*, not a sketch: concrete enough that a sub-issue agent can implement
against it without re-deriving decisions. Reference the terms in `CONTEXT.md`.

### 3. Tickets — `/to-tickets`

Break the PRD into flat, execution-ordered **native sub-issues**. Each
sub-issue is a tracer-bullet vertical slice that the implement workflow picks
up one at a time. Then label the parent `agent:to-issues` (or run
`pnpm prd:to-issues -- <PRD>`).

### 4. Implement

- **Single sub-issue / issue** — add `ready-for-agent` and label
  `agent:implement`: the self-hosted runner implements, pushes a branch, opens
  a draft PR, and requests `agent:review`.
- **Planner loop (batch)** — `AFK_PROFILE=<profile> pnpm ralph` plans over all
  `ready-for-agent` issues, implements in parallel (max 4), reviews, and merges
  (pushes `main` + closes issues; falls back to a PR on protected repos).
- **Controlled single issue** — `AFK_PROFILE=<profile> pnpm afk -- <issue>`:
  implement + commit locally only; you deliver the branch yourself.

### 5. Review

Label the PR `agent:review`: `review.ts` runs the two-axis `code-review` skill
(Standards vs Spec) in parallel sub-agents, fixes/improves the branch, and
replies to threads. Address feedback via `agent:implement` on the PR; resolve
conflicts via `agent:update-branch`.

## Rules

- **Profiles are server-global** (`claude`, `claude-ark`, `psydo`,
  `aliyun-deepseek`). Pick one per repo: `AFK_PROFILE` variable. No repo-side
  credentials.
- **The agent owns delivery on the planner loop** (push main + close issues);
  on GitHub branch-protected repos it degrades to a PR. Single-issue `pnpm afk`
  never touches GitHub.
- **Deterministic checks are the gate**: `npm run check` before any commit;
  PRs go through Verify + Windows Verify.
- **Never hardcode secrets**; read from server-local config.
- **CONTEXT.md and CODING_STANDARDS.md are the agent's contract**: keep them
  current when the domain or conventions change.

## Skills available

The Matt Pocock skills used above (`grill-with-docs`, `to-spec`,
`to-tickets`, plus this repo's `to-prd-project` / `to-issues-project`
variants) are installed at the user level. The AFK agents themselves live in
`.sandcastle/` (runner + planner + label Actions + prompts).
