# TASK

You are addressing reviewer feedback on PR #{{PR_NUMBER}} (branch `{{BRANCH}}`).

Unlike a review, your job is **not** to perform a broad comparison against the
spec or coding standards. Read the unresolved conversation, decide what (if
anything) to change, and explain yourself where useful. Any code change still
follows `.sandcastle/CODING_STANDARDS.md`.

# CONTEXT

Read `CONTEXT.md`, `.sandcastle/CODING_STANDARDS.md`, `docs/`, and relevant ADRs
under `docs/adr/` if you need domain context for a comment. Do not go deeper
than the comments demand.

<linked-issue>

!`gh issue view {{ISSUE_NUMBER}} --comments`

</linked-issue>

<diff-to-main>

!`git diff main..HEAD --stat`

</diff-to-main>

<pr-comments>

The unresolved conversation on this PR. Tagged by surface:

- `issue_comment` — top-level PR conversation comment.
- `review_thread` — inline thread anchored to a file + line. Only **unresolved** threads are included. Each comment has a `commentId` you can reply to in-thread.
- `review_summary` — top-level body of a submitted review.

Not everything in here is necessarily actionable — reviewers may leave context, questions, asides, or things they meant to resolve. Use your judgement. **Do not treat unresolved == must-action.**

```json
{{PR_COMMENTS_JSON}}
```

</pr-comments>

# PROCESS

1. Read the conversation. For each item, classify it in your head as: code change needed, reply needed (question / disagreement / clarification), or neither.
2. For a code change, run the Economy ladder and stop at the first option that
   fully addresses the confirmed feedback.
3. Make the code changes you decided on. Run `npm run check`, then `node .sandcastle/policy-check.mjs commit`, before committing. Use conventional-commit messages (`feat:`, `fix:`, `refactor:`, etc.). Do NOT use a `RALPH:` prefix.
4. If you made no changes that's fine — only commit when there's a real diff.

You do not have to reply to every thread. Reply only where a reply adds value: confirming what you changed, explaining why you chose not to make a requested change, answering a question, or pointing out something the reviewer should look at. Silence is fine for context-only comments.

You cannot resolve threads. Resolution is the reviewer's job.
