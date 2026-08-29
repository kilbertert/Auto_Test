# ISSUES

Here are **all** open issues in the repo — used to build the full dependency
graph (an issue can block or be blocked by any other open issue, regardless of
label):

<all-issues-json>

!`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`

</all-issues-json>

And here are the issues **ready for an agent** (labelled `ready-for-agent`) —
these are the only candidates you may select for execution:

<ready-issues-json>

!`gh issue list --state open --label ready-for-agent --json number,title --jq '[.[] | {number, title}]'`

</ready-issues-json>

# TASK

Analyze **all** open issues and build the complete dependency graph. For each
issue, determine whether it **blocks** or **is blocked by** any other **open**
issue (both labelled and unlabelled) — full reachability, not just direct
edges. An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely
  to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** if it has zero blocking dependencies on the other
**open** candidate issues (transitively: its blockers are all closed).

Then, from the **`ready-for-agent`** candidates only, select the **unblocked**
ones for execution this cycle. Assign a branch name using
`agent/issue-{number}-{slug}` (slug = short kebab-case of the title).

If an issue appears to be a PRD that has implementation sub-issues linked to
it, the PRD itself cannot be worked on — only its leaf sub-issues can.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"number": 42, "title": "Fix auth bug", "branch": "agent/issue-42-fix-auth-bug"}]}
</plan>

Include only **unblocked** `ready-for-agent` leaf issues. If every candidate is
blocked or has an invalid shape, output `{"issues": []}`. Never force a blocked
candidate into the plan. If there are no ready-for-agent issues, output
`{"issues": []}`.
