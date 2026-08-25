# TASK

Review PR #{{PR_NUMBER}} on branch `{{BRANCH}}` for issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

You are an expert code reviewer. Your job is **not just to comment** — actively improve the code on this branch, and explain what you changed.

# CONTEXT

Read the relevant files under `docs/` and any ADRs under `docs/adr/` before
starting.

<linked-issue>

!`gh issue view {{ISSUE_NUMBER}} --comments`

</linked-issue>

<diff-to-main>

This is a **summary** of the diff — changed files with added/removed line counts, not the full patch:

!`git diff main..HEAD --stat`

The full patch is deliberately omitted here because it can be very long. Go deeper on the files that matter: run `git diff main..HEAD -- <path>` on the changed files above to read the actual changes before reviewing.

</diff-to-main>

<pr-comments>

The following PR comments have been fetched by the workflow. They are tagged by surface:

- `issue_comment` — top-level PR conversation comment, not anchored to code.
- `review_thread` — inline thread anchored to a file + line. Only **unresolved** threads are included. Each has a `commentId` you can reply to in-thread.
- `review_summary` — top-level body of a submitted review (with approve/request-changes/comment state).

```json
{{PR_COMMENTS_JSON}}
```

</pr-comments>

# REVIEW PROCESS

## 1. Analyse the diff yourself

Read the diff on two axes and treat your findings as the worklist for the
steps below:

- **Standards** — code quality: fragile logic, unchecked assumptions, tricky
  conditions, implicit coercions, missing guards, deep nesting, redundant
  abstractions, unclear names. Apply the repo's own conventions from
  `docs/` / `AGENTS.md`.
- **Spec** — does the branch match issue #{{ISSUE_NUMBER}}? Missing coverage,
  scope creep, or misinterpretation should be called out (in the summary /
  inline comments) for the human reviewer, not silently "fixed" by adding
  code yourself.

For every changed code path, stress-test the edge cases: empty/zero/negative
inputs, missing optional fields, null/undefined, off-by-one, races, and
regressions in adjacent functionality.

## 2. Act on your findings

Work through the findings from step 1 and resolve each one on this branch:

- For any **correctness/robustness** finding, write a test that exercises it and try to actually break it. If you can break it, fix it. Cover the edge cases the skill flagged (empty/zero/negative inputs, missing optional fields, null/undefined, off-by-one, races, regressions in adjacent code).
- For any **quality/standards** finding, improve the code: reduce nesting, eliminate redundancy, improve names, consolidate related logic, drop comments that restate obvious code, avoid nested ternaries (prefer if/else or switch), choose clarity over brevity. 
- For any **spec** finding (missing coverage, scope creep, misinterpretation), do **not** silently "fix" missing spec coverage by adding code yourself — call it out in the `summary` and (where line-anchored) the inline comments for the human reviewer to decide.

**Preserve functionality.** When improving code, never change what it does — only how it does it. All original features, outputs, and behaviours must remain intact.

# RESPONDING TO HUMAN COMMENTS

For each unresolved `review_thread` and each `issue_comment` directed at the code, choose one:

- **Address** — make a code change in your commit, then reply in-thread (or with an issue comment) explaining what you did. Use the comment's `commentId` for in-thread replies.
- **Decline** — don't change the code, but reply explaining your reasoning. Use Decline when you have a substantive disagreement (the suggestion would break something, conflicts with project standards, is out of scope).
- **Defer** — do nothing, no reply. Only valid when the comment isn't a code-review request (jokes, off-topic banter, stale comments about already-fixed code, side conversations between humans).

Default to Address. Decline when you have a real reason. Defer only when a reply would be noise.

# EXECUTION

1. Run `npm run check` — confirm the current state passes.
2. Make improvements + write any new edge-case tests. Stage and commit them as a **single squashed commit** on this branch with a Conventional Commit message (e.g. `refactor: review improvements for #{{ISSUE_NUMBER}}`).
3. Run `npm run check` again. If either fails, fix it before continuing — do not leave the branch broken.
4. Decide which inline review comments to leave (line-anchored notes about your changes or remaining findings) and which thread replies to make.

If the code is already clean and there are no human comments to address, make no commits.
