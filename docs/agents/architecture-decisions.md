# Architecture decisions

`docs/adr/` holds the decisions this repository has already settled: what was
chosen, what was rejected, and why. It is the only place a reader can learn
*why* the system is built the way it is — code answers "what runs", and tests
answer "what holds", and neither answers "what did we try first and abandon".

Written for a reader who arrives cold, months later, with the code in front of
them and none of this change's context.

## When a record is owed

A change owes a record when it moves something a later reader could reasonably
re-litigate. Any of these counts:

- **Behavior** — a user- or client-visible outcome changes.
- **Architecture** — module boundaries, package topology, who owns what.
- **A cross-file contract** — a wire format, an API shape, an on-disk schema, an
  event vocabulary, an auth boundary.
- **Process and tooling** — checks, release, delivery, how work is coordinated.
- **Test strategy** — what is verified how, and what is deliberately not.
- **A persisted, network, or configuration format.**

Most changes owe nothing. These do not:

- formatting, typos, unambiguous renames
- styling that changes no behavior
- a dependency patch that changes no behavior, a version tag
- ordinary CRUD, a fix whose diff explains itself within one module

The test that decides a close call: **could a careful reader reconstruct this
decision from the code and its tests alone?** If yes, they do not need the
record. If no — and especially if the change *narrows* something, or gives up an
approach other people would reach for — they do.

## What a record must carry

A record that can be read cold has three things. `node .sandcastle/adr.check.mjs`
enforces the shape; the first two are the ones it checks, the third is the one
that makes the other two worth anything.

1. **A status a reader can branch on.** `Status: Accepted` and
   `Status: Superseded by 0003` are different instructions to a reader. Without
   it, a record describing an intended shape reads exactly like one describing
   the shipped shape — and this repository has both.

2. **An alternatives section** (`## Alternatives considered`,
   `## Alternatives Considered`, `## 被否掉的替代形态` — any spelling already in
   use). Name the options that lost. A record with no alternatives answers a
   question nobody asked, and the next agent re-proposes the path that was
   already ruled out.

   Write the rejected option's **strongest** case first, then why it lost. An
   alternative described only by its weakness is a strawman, and a strawman is
   how a reader concludes the decision was never really weighed.

3. **Consequences, both kinds.** What became easier, and what became harder or
   is now capped. A record with only benefits is a record with the cost edited
   out, and the cost is the part the next reader needs.

Do not invent alternatives that were never considered. "We did not consider
anything else" is a legitimate thing to write; a fabricated option is not.

## Writing one

Records live at `docs/adr/NNNN-slug.md`, numbered in order. Take the next free
number — do not reuse one, and do not renumber. Write it in the **same change**
as the code it describes, so the two cannot drift.

A record still being written starts with `Draft` or `提案` in its title. Drafts
are exempt from the structure check, which is what lets a proposal be committed
before its alternatives are settled.

Revising an existing record:

- **A fact changed and the decision did not** — paths, symbol names, defaults,
  a status flip to `Superseded by NNNN`. Edit it in place.
- **The decision itself is now the opposite** — that is a new record, linking to
  the one it replaces, which takes a `Status: Superseded by NNNN`. A record must
  never be rewritten into its own negation; the reader needs to see both.

## If no record is owed

Say so in the commit body, on its own line:

```
No-ADR: pure rename, no behavior change
```

That line is checked, because a decision not to write something and a decision
forgotten are indistinguishable in a diff — and only one of them is fine.

## Checking

```sh
node .sandcastle/adr.check.mjs                   # report; never blocks
node .sandcastle/adr.check.mjs --base origin/main  # gate: this diff
node .sandcastle/adr.check.mjs --all             # gate: every record in the repo
```

CI runs the `--base` form, so a change that owes a record and does not carry one
fails there. The bare form reports and exits 0 — it lists what the back catalogue
would need, which is work to schedule, not a reason to block today's pull
request.

`--all` is the sweep: run it when you want the whole list. On this repository
type it usually finds records that predate this convention and are a title and a
status line with nothing under them. Those are worth a pass when someone next
touches the decision they describe; they are not worth a mechanical rewrite, and
nobody should invent alternatives a record never weighed just to turn a check
green.
