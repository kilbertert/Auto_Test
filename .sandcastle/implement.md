# AFK implementation

Implement exactly GitHub issue {{ISSUE_NUMBER}}: {{ISSUE_TITLE}}.

Read `.sandcastle/REPO-MAP.md` first (where things live), then `GLOSSARY.md`, `AGENTS.md`, the issue, `docs/`, `.sandcastle/CODING_STANDARDS.md`, and the smallest set of relevant source
and tests before editing. Work on one issue only.
Run the Economy ladder defined in the coding standards before choosing an
implementation; stop at the first option that fully satisfies the issue.

Requirements:

1. Preserve the project's existing contracts and fail-closed guarantees. Do
   not invent a parallel runtime contract.
2. Make the smallest coherent change and add or update focused tests for
   behavior you change.
3. Run `npm run check` before committing. Do not weaken or skip checks.
4. Run `node .sandcastle/policy-check.mjs commit` before committing.

Before you settle on an approach, search what this repository has already
decided: `rg -i "<机制名或关键词>" docs/adr/`, and read the two or three records
whose titles touch the area. Facts the code or those records can answer, answer
yourself — do not spend a human's time on them.

If this change settles something a later reader would otherwise have to
re-derive — a user-visible behavior, a cross-file contract, an auth boundary, a
format, a delivery or test-strategy decision — write or update the record in
`docs/adr/` **in this same commit**. `docs/agents/architecture-decisions.md`
says what counts and what does not; the short version is that most changes owe
nothing. If nothing is owed, one line in the commit body settles it:

    No-ADR: <why not>

5. Inspect `git diff --check` and the changed-file list before committing.
6. Commit the completed work with a Conventional Commit message.

If the issue is complete, print `<promise>COMPLETE</promise>` after the commit.
If a required human decision, credential, or external environment is missing,
do not guess; explain the blocker and print `<promise>BLOCKED</promise>`.

Do not merge, push, close issues, or modify GitHub state from inside the
container. The host runner owns delivery.

If this work came from an outside ticket — a requirements platform, a chat
thread, a support queue — that ticket is where someone is waiting. When the work
is done, write back to it: the branch, the pull request, and which acceptance
criteria this change satisfies. You cannot post to a system this sandbox does not
reach; record the text in the commit body under `Source ticket:` and the host
runner or the human who owns that ticket posts it. A result that stays in this
repository is one the next person to open that ticket has to rediscover.
