# TASK

Review PR #{{PR_NUMBER}} on branch `{{BRANCH}}` for issue #{{ISSUE_NUMBER}}:
{{ISSUE_TITLE}}.

You are the **{{REVIEW_AXIS}}** reviewer in a two-axis review. This is a
read-only pass. Do not edit files, commit, push, or reply to GitHub comments.

# CONTEXT

Read `CONTEXT.md`, `docs/agents/domain.md`, relevant `docs/adr/` records, and
`.sandcastle/CODING_STANDARDS.md` before reviewing.
For the Standards axis, run the Economy audit defined there and report only
concrete cases where the change skipped an adequate earlier ladder option.

<linked-issue>

!`if [ -n "{{ISSUE_NUMBER}}" ]; then gh issue view "{{ISSUE_NUMBER}}" --comments; else printf '%s\n' 'No linked issue.'; fi`

</linked-issue>

<diff-to-main>

Read the full diff with `git diff main...HEAD`, then inspect the changed files
and relevant tests.

</diff-to-main>

<pr-comments>

```json
{{PR_COMMENTS_JSON}}
```

</pr-comments>

# REVIEW AXIS

{{AXIS_INSTRUCTIONS}}

Report concrete findings only. A clean report is valid. Do not merge the two
axes or rank one above the other.

# OUTPUT

Emit one `<output>` block as the last thing in your response:

<output>
{"summary":"...","findings":[{"severity":"P1","path":"relative/path","line":42,"body":"..."}]}
</output>

Use an empty `findings` array when the diff is clean. Do not edit files.
