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
