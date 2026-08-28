# TASK

Review PR #{{PR_NUMBER}} on branch `{{BRANCH}}` for issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

You are an expert code reviewer. Your job is **not just to comment** — actively improve the code on this branch, and explain what you changed.

# CONTEXT

Read `CONTEXT.md` and `docs/`, `.sandcastle/CODING_STANDARDS.md`, and any relevant ADRs under `docs/adr/` before starting.

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

## 1. Read the diff and look for anything dodgy

Read the diff carefully. For anything that looks suspicious — fragile logic,
unchecked assumptions, tricky conditions, implicit type coercions, missing
guards — write a test that exercises it. Try to actually break it. If you can
break it, fix it.

## 2. Stress-test edge cases

Go beyond the happy path. For every changed code path, think about what inputs
or states could cause problems: empty arrays, empty strings, zero, negative
numbers, missing optional fields, null/undefined, rapid repeated calls, races,
off-by-one, regressions in adjacent functionality. Write tests for anything not
already covered.

## 3. Analyze for code quality improvements

Look for opportunities to reduce unnecessary complexity and nesting, eliminate
redundant code and abstractions, improve readability through clear names,
consolidate related logic, avoid nested ternaries (prefer if/else or switch),
and choose clarity over brevity.

## 4. Maintain balance

Avoid over-simplification that reduces clarity, creates overly clever
solutions, combines too many concerns, or removes helpful abstractions.

## 5. Apply project standards

Follow the project's `.sandcastle/CODING_STANDARDS.md`.

## 6. Preserve functionality

Never change what the code does — only how it does it. All original features,
outputs, and behaviours must remain intact.

# EXECUTION

1. Run `npm run check` — confirm the current state passes.
2. Run `node .sandcastle/policy-check.mjs commit` — confirm the branch and metadata are valid.
3. Attempt to reproduce the original bug with new test cases — if you can, fix it.
4. Write edge-case tests that stress the implementation.
5. Make any code quality improvements directly on this branch.
6. Run `npm run check` again to ensure nothing is broken.
7. **If you changed anything**, run `node .sandcastle/policy-check.mjs commit`, then commit with a Conventional Commit message
   (`refactor:`, `test:`, `fix:`). **If the code is already clean,
   well-tested, and handles edge cases properly, do nothing — make no commit.**

Once complete, output `<promise>COMPLETE</promise>`. If a blocker needs a human
decision, output `<promise>BLOCKED</promise>`.

If the code is already clean and there are no human comments to address, make no commits.
