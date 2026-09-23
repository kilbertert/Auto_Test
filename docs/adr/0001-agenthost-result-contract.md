# AgentHost result contract and fail-closed settlement

Status: Accepted

## Context

The AgentHost evidence, mutation ledger, and result summary are consumed by
the CLI and recovery tooling. A malformed ledger or unverifiable evidence
must not be presented as a successful run.

## Decision

Keep one deterministic result contract for every run. Unverifiable outcomes,
malformed ledgers, and broken evidence chains fail closed. The `codex-agent.state.json`
shape (currently v2.0), the `easy` CLI surface, and platform-specific run roots
are compatibility contracts; readers and tests change together when they evolve.

## Consequences

The AgentHost remains the authority for execution evidence and settlement.
Parallel runtime contracts are not introduced, and contract changes require
updates to every reader and focused regression tests.

Every invariant of that contract — input identity against the immutable test
contract, Case membership, evidence completeness, failure classification,
execution-receipt and environment-requirement references, the top-level
outcome derivation, and the effect of a pending Mutation Ledger row or a
pending environment requirement — is implemented in exactly one module,
`src/agent/result-settlement.ts`. The Runner's final settlement, the per-epoch
delivery recovery Adapter, the cross-host comparison tool, and acceptance
reporting all submit to it, and the Runner's fail-closed fallback Result asks
the same module to apply the authority rows. There is deliberately no second
implementation of these rules anywhere else: deleting the module forces every
one of them to reappear in each caller, which is the test of its depth. The
Result version (1.0), the `codex-agent.state.json` shape (v2.0), and reader
compatibility contracts are unchanged by this refactor.
