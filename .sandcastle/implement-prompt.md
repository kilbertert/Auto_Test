# TASK

Fix issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}} on branch {{BRANCH}}.

Pull in the issue using `gh issue view`, with comments. If it has a parent
PRD, pull that in too. Only work on the issue specified.

# CONTEXT

Read `.sandcastle/REPO-MAP.md` first (where things live), then `GLOSSARY.md` (domain language) and the relevant files under `docs/` and any ADRs under `docs/adr/` before
starting. Apply the project's `.sandcastle/CODING_STANDARDS.md`. Explore the
repo and fill your context window with the parts relevant to this issue —
especially test files that touch the area you'll change.
Run the Economy ladder before choosing an implementation; stop at the first
option that fully satisfies the issue and its acceptance contract.

# EXPLORATION

Explore the repo and fill your context with relevant information that will
allow you to complete the task.

# EXECUTION

Use red-green-refactor where applicable:

1. RED: write one failing test
2. GREEN: implement to pass it
3. REPEAT until the issue is done
4. REFACTOR the code

# FEEDBACK LOOPS

Before committing, run `npm run check` (typecheck + tests + build) and
`git diff --check` to ensure everything passes. Then run
`node .sandcastle/policy-check.mjs commit`. Do not weaken or skip checks.

Before you settle on an approach, search what this repository has already
decided: `rg -i "<机制名或关键词>" docs/adr/`, and read the two or three records
whose titles touch the area. Facts the code or those records can answer, answer
yourself — do not spend a human's time on them.

# COMMIT

Make git commits on `{{BRANCH}}` with **Conventional Commit** messages
(`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Reference the issue in the
body. Keep the diff focused.

Do **not** push, merge, or close the issue, and do not modify GitHub state —
the planner loop handles delivery.

If this work came from an outside ticket — a requirements platform, a chat
thread, a support queue — that ticket is where someone is waiting. When the work
is done, write back to it: the branch, the pull request, and which acceptance
criteria this change satisfies. You cannot post to a system this sandbox does not
reach; record the text in the commit body under `Source ticket:` and the host
runner or the human who owns that ticket posts it. A result that stays in this
repository is one the next person to open that ticket has to rediscover.

# FINAL RULES

- ONLY WORK ON A SINGLE TASK.
- Once complete, output `<promise>COMPLETE</promise>`.
- If a required human decision, credential, or external environment is
  missing, do not guess; explain the blocker and output
  `<promise>BLOCKED</promise>`.
