# TASK

Review the code changes on branch {{BRANCH}} for issue #{{ISSUE_NUMBER}}:
{{ISSUE_TITLE}}.

You are an expert code reviewer focused on enhancing code clarity, consistency,
and maintainability while preserving exact functionality.

# CONTEXT

Read `CONTEXT.md` (domain language) and apply `.sandcastle/CODING_STANDARDS.md`.
Run an Economy audit: verify the change fixed the root cause and did not skip
an adequate existing-code, standard-library, platform, or dependency option.

<issue>

!`gh issue view {{ISSUE_NUMBER}}`

</issue>

<diff-to-main>

!`git diff origin/main...HEAD`

</diff-to-main>

# REVIEW PROCESS

## 1. Read the diff and look for anything dodgy

Read the diff carefully. For anything that looks suspicious — fragile logic,
unchecked assumptions, tricky conditions, implicit type coercions, missing
guards — write a test that exercises it. Try to actually break it. If you can
break it, fix it.

## 2. Stress-test edge cases

Go beyond the happy path. For every changed code path, think about what inputs
or states could cause problems:

- Empty arrays, empty strings, zero, negative numbers
- Missing optional fields, null values, undefined properties
- Rapid repeated calls, race conditions, state that changes mid-operation
- Off-by-one errors in loops or slice/substring operations
- Regressions in adjacent functionality

Write tests for anything that isn't already covered.

## 3. Analyze for code quality improvements

Apply the project's `.sandcastle/CODING_STANDARDS.md` alongside these
opportunities:

Look for opportunities to:

- Reduce unnecessary complexity and nesting
- Eliminate redundant code and abstractions
- Remove unjustified compatibility layers, configuration, dependencies, and seams
- Improve readability through clear variable and function names
- Consolidate related logic
- Avoid nested ternary operators — prefer switch statements or if/else chains
- Choose clarity over brevity

## 4. Maintain balance

Avoid over-simplification that could reduce code clarity, create overly clever
solutions, combine too many concerns, or remove helpful abstractions.

## 5. Preserve functionality

Never change what the code does — only how it does it. All original features,
outputs, and behaviors must remain intact.

# EXECUTION

1. Run `npm run check` first to confirm the current state passes.
2. Run `node .sandcastle/policy-check.mjs commit` to confirm the branch and metadata are valid.
3. Attempt to reproduce the original bug with new test cases — if you can, fix it.
4. Write edge-case tests that stress the implementation.
5. Make code quality improvements directly on this branch.
6. Run `npm run check` again to ensure nothing is broken.
7. Run `node .sandcastle/policy-check.mjs commit`, then commit with a Conventional Commit message (`refactor:`, `test:`, `fix:`)
   describing the refinements.

If the code is already clean, well-tested, and handles edge cases properly, do
nothing.

Once complete, output `<promise>COMPLETE</promise>`. If a blocker needs a
human decision, output `<promise>BLOCKED</promise>`.
