# Auto-Test 领域词汇表

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
One logical batch of cases executed under a single model session.
_Avoid_: Round, Iteration

**Evidence**:
The recorded, redacted proof of a case's outcome — the artifact that makes a
result verifiable rather than asserted.
_Avoid_: Log, Output (ambiguous)

**Mutation Ledger**:
The append-only record of state mutations during a run.
_Avoid_: Audit trail, Journal

**Result contract**:
The machine-checkable settlement of a run, including per-case outcomes and a
summary.
_Avoid_: Report, Verdict

**Run root / state file**:
The run's artifact location and the state record that identifies its latest
execution.
_Avoid_: Output dir (generic)

**Observation plane**:
The read-only projection of run artifacts for humans: a loopback web view of
runs, live progress, case results, and evidence. It never writes, never holds
control authority, and never exposes private material. Console summaries and
the web view are two surfaces of one projection.
_Avoid_: Dashboard (implementation name), Monitoring (vaguer)

**Control plane**:
The write path that acts on runs (pause/resume/re-run/configure). A deliberate
follow-up, kept distinct from the observation plane: conflating the two would
give an unauthenticated local view control authority.
_Avoid_: Admin panel
