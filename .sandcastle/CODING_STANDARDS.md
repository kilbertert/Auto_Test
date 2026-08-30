# Coding Standards

> Project-local engineering standards for the AFK agent. The implement and
> review prompts apply these. **Edit this file to match the project** — the
> defaults below are a safe baseline, not a substitute for real conventions.

## Correctness & safety

- Handle errors explicitly at every boundary; never silently swallow them.
  Log useful context server-side; surface clear messages user-facing.
- Validate all external input (user input, file content, API responses) before
  trusting it. Fail fast with a clear error.
- Never hardcode secrets (keys, tokens, credentials). Read them from
  environment/config; keep them out of source control, logs, and prompts.
- Preserve functionality when refactoring: change *how*, not *what*.

## Structure & clarity

- Keep modules cohesive and separate concerns at established seams. Prefer a
  deep module with a small interface over pass-through layers or many shallow
  files. Introduce a new seam only when the current system has real variation.
- Favor immutability: return new values instead of mutating inputs.
- Avoid deep nesting (>4 levels) — use early returns.
- Name things for what they are: `camelCase` variables/functions,
  `PascalCase` types/components, `UPPER_SNAKE_CASE` constants.

## Engineering economy

- Trace the affected flow and every caller before editing shared behavior.
  Fix the root cause once at the narrowest shared location.
- Apply the Economy ladder and stop at the first option that fully satisfies
  the current requirement: skip speculative work; reuse project code; use the
  standard library or platform; use an already-installed dependency after
  checking its capabilities; add a mature maintained dependency only when it
  lowers total complexity; otherwise write the minimum custom code.
- Prefer deletion and the fewest cohesive files. Add no configuration layer,
  interface, factory, or extension point for a variation that does not exist.
- Leave the smallest runnable regression check for non-trivial behavior such
  as branching logic, parsers, persistence, money, or security paths.
- No dead code, no commented-out blocks, no `console.log` debug leftovers.

## Compatibility & delivery

- Treat public interfaces, schemas, persisted data, and production behavior as
  compatibility contracts unless the requirement or an ADR explicitly changes
  them. For internal or experimental paths with no consumer, remove obsolete
  behavior cleanly instead of adding a shim, migration, or fallback. A fallback
  must never hide a real failure.
- Deliver the smallest end-to-end slice that satisfies acceptance, verify it,
  then extend it without dismantling working behavior for unfinished layers.
- Make high-switching-cost architecture choices durable. Use applicable
  standards, official dependency documentation, repository conventions, and
  established product patterns when the decision is material; routine local
  work does not require external research.
- Do not label a throwaway architecture as permanent. Mark a deliberate bounded
  simplification with a `ponytail:` comment naming its ceiling and upgrade
  trigger.

## Consistency

- Follow the surrounding code's style and idioms.
- Keep public contracts, schemas, and diagnostics stable; document changes
  that affect observability or interoperability.
- Update tests alongside behavior changes; keep the suite green.

## This project's specifics

<!-- Add project-specific rules here, e.g.:
- Framework/type conventions, effect/schema libraries in use.
- Domain invariants that must never be violated.
- Modules/layers that must stay isolated.
-->
