# Auto-Test Project Instructions

These instructions add project-specific requirements to the inherited server
development consensus.

## Documentation Synchronization

- Treat `README.md`, `docs/`, command help, templates, and runnable examples as
  maintained product interfaces.
- Changes to CLI flags, Windows launch behavior, environment registration,
  authentication, execution semantics, result contracts, Mutation Ledger,
  interruption recovery, packaging, or deployment must update the relevant
  documentation in the same branch and pull request.
- Windows user-facing changes must review both
  `docs/windows-quick-start.md` and `docs/windows-acceptance-runbook.md`.
- Remove or clearly label stale acceptance claims. A historical failure may
  remain in an architecture history document, but active entry-point guides
  must describe the currently verified behavior.
- Verify documented commands and links from the intended user's starting
  point. Record any platform-specific step that could not be exercised.
- Do not place credentials, private provider details, tenant data, internal
  endpoints, device identifiers, or private filesystem paths in public
  documentation. Use placeholders and describe how private inputs are supplied.
- A pull request that changes observable behavior without corresponding docs,
  or without an explicit reason why docs are unaffected, is incomplete.

## Acceptance Claims

- Base acceptance claims on structured result, plan, evidence, and Mutation
  Ledger artifacts. A successful browser click or partial workflow is not an
  end-to-end pass.
- State the proven scenario and platform precisely. Do not generalize one
  complex canary into an unconditional claim that every unknown website works.
