# TASK

You are running the daily architecture-review pass. Find one fresh deepening
opportunity in this codebase and report it as a PRD.

This is an unattended CI run. There is no user to grill, no HTML report to
write. Your job is:

1. List prior proposals labelled `source:architecture-review` (open and
   closed) so you don't re-propose them.
2. Explore the codebase.
3. Pick **one** top candidate.
4. Write it up **in your `<output>` block** — title, full body, one-line
   summary, and the candidates you considered.

**Do NOT create the issue yourself.** The workflow's own *Publish PRD issue*
step creates the issue from the `title` and `body` you emit. If you also run
`gh issue create`, the run publishes **twice**.

The full process — including the methodology (deletion test, deepening,
glossary), the loose-duplicate rule, the PRD shape, and the exact `<output>`
schema — is documented in the project skill
`improve-codebase-architecture-project`. Follow it.

# CONTEXT

Read `GLOSSARY.md` and `docs/` and any relevant ADRs under `docs/adr/` before proposing
anything. Treat ADRs as binding — do not propose changes that contradict a
recorded decision.

# RULES

- **Read-only.** No commits, no edits to `docs/`, ADRs, or source files, and
  **no tracker writes** — no `gh issue create`, no `gh issue edit`, no label
  changes. You *propose*; the workflow *publishes*. This is not a style
  preference: your token has `issues=read` and label writes return 403, so a
  self-published issue also ends up **unlabelled** — the same failure that
  duplicated #178/#177 and #202/#201.
- One PRD per run. If every reasonable candidate is already covered by a
  prior `source:architecture-review` proposal, emit a `skipped` output and
  stop.
- No questions to a user — there is none. Make the call.
