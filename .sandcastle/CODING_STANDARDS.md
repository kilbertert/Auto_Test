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

- Keep functions small and focused (< ~50 lines); keep files cohesive
  (< ~800 lines). Split when they grow.
- Prefer many small, high-cohesion files over a few large ones.
- Favor immutability: return new values instead of mutating inputs.
- Avoid deep nesting (>4 levels) — use early returns.
- Name things for what they are: `camelCase` variables/functions,
  `PascalCase` types/components, `UPPER_SNAKE_CASE` constants.

## Simplicity

- Prefer the simplest solution that works (KISS); don't add speculative
  abstractions (YAGNI); don't repeat yourself (DRY) where it's real.
- Use the standard library / platform primitives before adding dependencies.
- No dead code, no commented-out blocks, no `console.log` debug leftovers.

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
