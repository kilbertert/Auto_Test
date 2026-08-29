# AFK development workflow

The project uses the official Matt Pocock planning skills and this repository's
Sandcastle execution adapters:

```
idea -> /grill-with-docs -> /to-spec -> /to-tickets -> implement -> review -> merge
```

## Phase boundaries

1. `/grill-with-docs` resolves terminology and decisions. When its frontier is
   empty, it reports `GRILLING_COMPLETE`, asks for confirmation, and ends the
   turn. Confirmation does not authorize a later phase.
2. `/to-spec` publishes the confirmed requirements as a GitHub spec/PRD issue.
3. `/to-tickets` creates native sub-issues and native blocking edges in the
   order approved by the user.
4. Implementation starts only after an explicit invocation or authorization:
   `agent:implement` for the matching GitHub workflow, `pnpm ralph` for the
   host planner, or `pnpm afk -- <issue>` for one controlled issue.
5. Review runs the harness-neutral Sandcastle two-axis orchestration, then a
   fixer handles confirmed findings and PR conversation.

## Labels

| Label | Meaning | Engine |
| --- | --- | --- |
| `ready-for-agent` | Complete spec, eligible leaf issue | `pnpm ralph` |
| `agent:implement` | Explicit execution authorization | issue or PR workflow |
| `agent:queued` | Ready but blocked by an open native dependency | promotion workflow |
| `agent:in-progress` | AFK run is active | workflow state |
| `agent:blocked` | Failed run or invalid shape | human triage |
| `agent:review` | Explicit PR review authorization | PR review workflow |

`agent:implement` is not a planning label. The planner never selects PRDs,
parents with sub-issues, nested sub-issues, open native blockers, or issues
already targeted by an open PR. It has no forced fallback when every candidate
is blocked.

## Truth sources

- `CONTEXT.md` is the glossary only.
- `docs/adr/` records durable implementation decisions and trade-offs.
- The spec/PRD issue records requirements.
- Native sub-issues and dependency edges record execution slices.
- `docs/agents/` tells the official skills how to read the tracker, labels,
  and domain docs.

## Delivery

Agents commit on task branches and run deterministic checks. The host runner
pushes branches, opens draft PRs, and merges only after CI and human review.
No agent pushes the default branch directly.

Pull request mutation jobs accept only repository-owner-authored branches from
the same repository. The current `main` checkout supplies the trusted
controller, candidate commands run in Docker with the read token, and verified
Git bundles enter a clean delivery checkout before the host write token is used.
Missing delivery credentials produce `agent:blocked`; there is no non-triggering
`GITHUB_TOKEN` fallback.

## Providers

The configured Sandcastle profile is server-global: `claude`, `claude-ark`,
`agentrouter`, `psydo`, or `aliyun-deepseek`. Set `AFK_PROFILE` for local runs
or the repository variable for Actions; no project-side credential is needed.
