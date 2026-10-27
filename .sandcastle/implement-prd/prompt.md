# TASK

You are implementing one sub-issue of a multi-session PRD.

- **PRD:** #{{PRD_NUMBER}} — {{PRD_TITLE}}
- **This sub-issue:** #{{SUB_ISSUE_NUMBER}} — {{SUB_ISSUE_TITLE}}
- **Branch:** `{{BRANCH}}`

The branch may already have commits from earlier sub-issues. Do **not** rebase
or rewrite that history. Add your work on top.

Pull both issues in for context:

- `gh issue view {{PRD_NUMBER}} --comments` — the full PRD. Read this carefully; your implementation of this sub-issue must fit the larger plan.
- `gh issue view {{SUB_ISSUE_NUMBER}} --comments` — the specific step you are implementing now.

You also have access to the full list of sibling sub-issues:

`gh api repos/$GH_REPO/issues/{{PRD_NUMBER}}/sub_issues`

Use this to understand what work has already shipped on this branch and what
is still ahead — but **only implement #{{SUB_ISSUE_NUMBER}}** in this session.
Do not touch work that belongs to a different sub-issue.

If this sub-issue came from an outside ticket — a requirements
platform, a chat thread, a support queue — that ticket is where someone is
waiting. Record its identifier and the acceptance criteria this change satisfies
in the commit body under `Source ticket:`. Do not name a pull request: none
exists until the host opens one after this commit, and the host posts that link
to the issue itself. If you are replying without changing code, put the same
`Source ticket:` line in a top-level PR comment instead — there is no commit
to carry it. A result that stays in this repository is one the next person to
open that ticket has to rediscover.

# CONTEXT

Read `.sandcastle/REPO-MAP.md` first (where things live), then `GLOSSARY.md` and the relevant files under `docs/`, apply `.sandcastle/CODING_STANDARDS.md`, and any ADRs under `docs/adr/` before starting.
Explore the repo and fill your context with the parts relevant to this
sub-issue — especially test files that touch the area you'll change.
Run the Economy ladder before choosing an implementation; stop at the first
option that fully satisfies this sub-issue and the parent PRD contract.

# EXECUTION

Let a test lead where a test is the cheapest way to pin the behavior: write it
first, watch it fail, then implement to pass it. That is one technique, not a
ritual. Reach for it where the behavior is non-trivial or a regression would
otherwise be silent — branching logic, parsers, persistence, money, auth,
data transforms.

Do not manufacture a test to satisfy a quota. Prose, formatting, a rename, or
a one-line wiring change owes none. Name the input that would break your
change and pin that input; if you cannot name one, say so in the commit body
rather than writing a test that asserts the implementation back to itself.

While you iterate, run only the narrowest check that can falsify what you just
did — the test files touching your change, the typecheck, the linter. The full
gate below runs everything; run it once, when the change is complete, not after
every edit.

Before committing, run `npm run typecheck` and `npm test`, then
`node .sandcastle/policy-check.mjs commit`.

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


# COMMIT

Make one or more git commits on `{{BRANCH}}`. Use conventional-commit
messages (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Do NOT use a
`RALPH:` prefix.

Include `Part of #{{PRD_NUMBER}}` in each commit body so the history is
linkable from the PRD. Do **not** include `Closes` in commits — closing the
sub-issue is the workflow's job, and closing the PRD is the merged PR's job.

Do not close the sub-issue yourself. Do not push the branch. The workflow
handles both.
