# Auto-Test Coding Standards

Project-local engineering standards applied by the AFK implement and review
prompts. Deviations need an explicit reason.

## Correctness & safety

- **Fail-closed contracts are sacred.** AgentHost, evidence, Mutation Ledger,
  and result contracts must never be weakened, skipped, or silently bypassed.
  Do not invent a parallel runtime contract.
- Handle errors explicitly; never swallow them. Throw/surface with a clear
  message; log useful context.
- Validate all external input (files, URLs, env, API payloads) at boundaries.
- Never put secrets (API keys, tokens, credentials) in code, prompts, logs, or
  GitHub. Read them from env / server-local config.
- Preserve functionality on refactor: change *how*, not *what*. Keep tests
  passing.

## TypeScript & structure

- Strict TypeScript. Use the repo's `tsconfig` (exact optional property types
  etc.) — write types that satisfy it, not `any` escapes.
- Functions small and focused; files cohesive; prefer small modules over big
  ones (the repo splits by feature/domain, e.g. `src/agent`, `src/workflow`).
- Favor immutable patterns: return new objects instead of mutating inputs.
- Early returns over deep nesting. Clear names: camelCase fns/vars,
  PascalCase types, UPPER_SNAKE_CASE constants.
- Reuse existing utilities (run-directory, model-profile, host-registry, etc.)
  instead of re-deriving the same logic.

## Tests

- Add/update focused tests for behavior you change (vitest, in `tests/`).
- Preserve the deterministic check gate: `npm run check`
  (typecheck + tests + build) must stay green.
- No skipping or weakening tests to make CI pass.

## CLI & contracts

- The `easy` CLI surface and its help text are user-visible contracts: don't
  remove or rename documented commands/flags without updating help + tests.
- Public schemas and state files (`codex-agent.state.json`, build-info, etc.)
  are contracts: changing shape requires updating readers + tests.

## Deliverables

- Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`,
  `chore:`). No `RALPH:` prefix.
- `git diff --check` clean; no dead code, commented-out blocks, or debug
  leftovers.
