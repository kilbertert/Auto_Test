# ISSUES

Here are the open issues in the repo that are **ready for an agent** (labelled `ready-for-agent`):

<issues-json>

!`gh issue list --state open --label ready-for-agent --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`

</issues-json>

# TASK

Analyze the issues and build a dependency graph. For each issue, determine
whether it **blocks** or **is blocked by** any other open issue.

An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** if it has zero blocking dependencies on the other
candidate issues.

For each unblocked issue, assign a branch name using the format
`agent/issue-{number}-{slug}` (slug = short kebab-case of the title).

If an issue appears to be a PRD that has implementation sub-issues linked to
it, the PRD itself cannot be worked on — only its leaf sub-issues can.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"number": 42, "title": "Fix auth bug", "branch": "agent/issue-42-fix-auth-bug"}]}
</plan>

Include only unblocked issues. If every issue is blocked, include the single
highest-priority candidate (the one with the fewest or weakest dependencies).
If there are no issues, output `{"issues": []}`.
