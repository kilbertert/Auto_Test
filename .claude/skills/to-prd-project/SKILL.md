---
name: to-prd-project
description: Turn the current conversation context into a PRD and publish it as a GitHub issue that is ready to receive sub-issues from /to-issues-project. Project-local variant of /to-prd, adapted for this repo's PRD-as-parent-issue + sub-issues + agent:implement workflow.
---

This skill writes a PRD and publishes it as a GitHub issue in `kilbertert/Auto_Test`. It does **not** apply `agent:implement` — labeling happens _after_ sub-issues have been created.

Do NOT interview the user — just synthesize what you already know from the conversation. If context is thin, ask the user to talk through the problem first; don't run the skill on an empty plate.

## Process

1. **Explore the repo** to understand the current state of the codebase, if you haven't already. Use established terms in `docs/` and respect any ADRs under `docs/adr/` for areas you're touching.

2. **Sketch the major modules** you'd build or modify. Actively look for opportunities to extract deep modules that can be tested in isolation. A deep module encapsulates a lot of functionality behind a simple, testable interface that rarely changes.

   Check with the user that these modules match their expectations and which they want tests written for.

3. **Write the PRD** using the template below and publish it via `gh issue create`. Use a heredoc for the body. Do **not** apply `agent:implement` — that's reserved for after sub-issues exist. Add no labels unless the user asks.

4. **Output the issue URL** so the user can pass it to `/to-issues-project` next.

## PRD template

The PRD will be read by:

- **Humans** deciding whether the plan is sound.
- **`/to-issues-project`** when breaking it into sub-issues.
- The **PRD-mode implement workflow** at the start of each sub-issue run (the prompt pulls in the PRD body for context).
- The **review workflow** when checking "does the PR match the spec?"

So the PRD must be a _spec_, not a sketch — concrete enough that a sub-issue agent can implement against it without re-deriving decisions.

<prd-template>

## Problem Statement

The problem the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each in the format:

1. As a &lt;actor&gt;, I want &lt;feature&gt;, so that &lt;benefit&gt;

This list should cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions, including:

- The modules to build/modify
- The interfaces of those modules
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do **not** include specific file paths or code snippets. They go stale fast.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note that it came from a prototype. Trim to the decision-rich parts.

## Testing Decisions

- What makes a good test in this codebase (only external behavior, not implementation details)
- Which modules will be tested
- Prior art (similar tests in the codebase)

## Out of Scope

Things explicitly excluded from this PRD. Be specific — "we are not building X" rather than "X is out of scope."

## Further Notes

Anything else worth recording: open questions, known risks, deferred decisions.

</prd-template>

## After publishing

- Tell the user: "PRD published at &lt;URL&gt;. Run `/to-issues-project &lt;issue-number&gt;` to break it into sub-issues, then add `agent:implement` to start work."
- Do **not** add `agent:implement` yourself. The PRD has no sub-issues yet, so labeling it now would either silently bounce (regular single-issue workflow would try to run it as a leaf and might do unexpected work) or land in the wrong place. The user labels once sub-issues are in place.
