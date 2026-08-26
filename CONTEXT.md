# Auto-Test

AI-driven cross-scenario test automation. An agent host drives a test workflow
against target environments, records evidence, and settles a deterministic
result contract. The AFK agent (Sandcastle/planner loop) develops THIS repo;
the AgentHost is the product this repo builds and tests.

## Language

**AgentHost**:
The runtime that executes test cases through an AI model (Codex or OMP),
rotating model sessions across epochs, recording evidence, and settling results
into a deterministic contract. The product this repo develops.
_Avoid_: Runner (ambiguous with the CI/GitHub runner), Test engine

**Case**:
A single test scenario with a target URL, expected outcomes, and an evidence
contract. The unit of execution and reporting.
_Avoid_: Test case, Scenario (interchangeable)

**Epoch**:
One logical batch of cases executed under a single model session. On capacity
exhaustion or incompatibility, the AgentHost bisects the epoch and rotates to a
fresh physical session without replaying completed cases.
_Avoid_: Round, Iteration

**Evidence**:
The recorded, redacted proof of a case's outcome — the artifact that makes a
result verifiable rather than asserted.
_Avoid_: Log, Output (ambiguous)

**Mutation Ledger**:
The append-only record of state mutations during a run. It must be consistent
with the result contract; a malformed ledger is a fail-closed error, never a
silent pass.
_Avoid_: Audit trail, Journal

**Result contract**:
The deterministic, machine-checkable settlement of a run (per-case outcome +
summary). Consumers rely on its shape; changing it requires updating every
reader and its tests.
_Avoid_: Report, Verdict

**Run root / state file**:
Where a run's artifacts live (`artifacts/runs/…` on POSIX,
`%LOCALAPPDATA%\auto-test\runs` on Windows) and the AgentHost state file
(`codex-agent.state.json`) that defines "the latest run".
_Avoid_: Output dir (generic)

## Invariants & boundaries

- **Fail-closed**: any unverifiable outcome, malformed ledger, or broken
  evidence chain is a failure — never a pass, never skipped.
- **The AgentHost contract is sacred**: do not invent a parallel runtime
  contract; preserve the evidence + ledger + result-summary chain.
- **State-file shape is a contract**: `codex-agent.state.json` (v2.0) changes
  require updating every reader + test.
- **The `easy` CLI surface is user-visible**: documented commands/flags and
  their help text are contracts; removing/renaming them requires help + test
  updates.
- **Run root is platform-specific**: POSIX cwd-relative `artifacts/runs`;
  Windows `%LOCALAPPDATA%\auto-test\runs`. Keep both consistent.

## Decisions

See `docs/adr/` for architecture decisions. Notable current shapes:
- AgentHost-only execution: legacy `--legacy-runtime`, planner, recovery, and
  autonomous controller chains were removed (see issue #93/#94).
- Model supply is pluggable via server-local profiles (`claude-ark`, `psydo`,
  `aliyun-deepseek`); credentials never live in the repo.
