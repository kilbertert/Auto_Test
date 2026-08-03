# Codex-native Autonomous Workflow

## Product Contract

Auto-Test is a thin execution harness around one persistent Codex thread. It accepts the original test materials and a registered environment, then runs without interactive steering until one terminal outcome is produced:

- `passed`: the requested operations and observable expected results were verified;
- `product_failed`: the intended test action completed, but an immutable product or business expectation did not hold;
- `blocked`: execution could not finish because required environment, authentication, data, authority, identity, recovery state, or infrastructure was unavailable.

For a blocked result, the executing Codex must also state one failure source. `input` is incomplete or contradictory supplied material; `environment` is target permissions, authentication, test data, or physical preconditions; `infrastructure` is the provider, Codex CLI, browser, MCP, host, or network; `agent_execution` is an incomplete execution, recovery, or delivery by the agent. An `environment` case must reference a case-scoped recorded requirement with saved evidence, after the agent has attempted applicable non-mutating page interaction. The harness checks this contract and preserves it. It does not infer a source from the business summary.

The framework does not implement a second planner, locator interpreter, form-composition engine, or business-specific Runtime for first-time scenarios.

## Default Full-Agent Mode

Each run creates an isolated `agent-workspace/` containing:

- the original Excel workbook;
- the optional test brief;
- embedded and supplemental images;
- a run-scoped values file containing only Excel and Environment Profile values needed by this test;
- Codex-created notes, temporary scripts, and evidence artifacts.

The persistent Codex thread receives:

- a writable run workspace;
- shell commands and temporary code execution;
- network access and live Web Search;
- Codex subagents for parallel read-only analysis while the primary thread coordinates stateful browser writes;
- complete Playwright MCP capabilities, including accessibility, network, vision, page evaluation, and Playwright code execution;
- the authenticated browser state and registered environment context;
- optional Auto-Test Control MCP tools for plan snapshots, evidence checkpoints, field diagnostics, environment requirements, and Mutation Ledger operations.

Codex owns test understanding, working plans, exploration, execution, assertions, recovery, and the final structured result. A native Codex todo list, Markdown note, JavaScript helper, or direct Playwright code is valid. `test_plan_update`, `field_composition_check`, and `case_result_record` are optional diagnostics, not execution gates.

`--opaque-test-data` retains the previous restricted compatibility mode. In that mode the raw workbook and run-values file are not staged, the workspace is read-only, shell and Web Search are disabled, and browser requests remain limited to registered origins.

## Thin Harness Responsibilities

The framework remains responsible only for capabilities that must survive model or browser interruption:

1. index every source row in the Excel to establish immutable workflow and case identity; row-local diagnostics remain evidence for Codex, not an execution gate;
2. select and refresh the Environment Profile and browser authentication;
3. create the isolated Codex Home and run workspace;
4. start or resume the same Codex thread;
5. expose safe progress and preserve redacted event history;
6. retain the Mutation Ledger and environment requirements;
7. request one final JSON result from the same thread and validate its schema, workflow identity, exact case coverage, evidence presence, outcome consistency, and failure classification;
8. force `blocked` when an authoritative Mutation Ledger entry remains pending.

The harness does not require an `execution-plan.json`, field gate, or Control MCP evidence entry for a run to pass.

Before final delivery, Codex writes its own versioned `agent-workspace/case-results.json` recovery artifact. It records the workflow ID, source hash, every case conclusion, workspace-relative evidence paths, explicit non-pass classification, and terminal Ledger state. This is not a second planner or reporter: the harness reads it only after transport failure, validates the exact artifact contract, immutable identity, case coverage, evidence paths, classifications, and Ledger terminal state, then preserves Codex's conclusion without inventing business facts.

The same delivery contract also requires case-scoped execution receipts. Before supporting browser work for a case, the Codex thread calls `case_execution_begin`; the Runner automatically tags completed Playwright calls until `case_execution_end`. A `passed` or `product_failed` case must cite at least one interaction and one observation receipt belonging to that case. A receipt from another case, or a generic receipt list reused across cases, is rejected. Receipts prove that the browser execution episode occurred; they do not decide whether the business assertion is correct.

The risk value attached to a Manifest case is advisory context. A mutation is authorized only when the same Codex thread declares its actual `write` or `destructive` risk and the Environment Profile permits that risk. This prevents a weak text inference from becoming a second business planner or permission system.

## Mutation Recovery

Mutation Ledger entries are coarse crash-recovery records for externally persisted business operations. One entry can represent a coherent operation such as creating and later deleting a test entity, starting and stopping a device, or submitting and reviewing one order. Navigation, reads, selectors, and form composition do not require separate entries.

After interruption, Codex must re-observe the actual business state before continuing or compensating a pending operation. It must not repeat a write merely because the browser was recreated. The harness independently blocks the final result while any ledger entry remains `pending`.

## Environment Profiles

The default registry path is `~/.config/auto-test/environment-profiles.json` on Linux/macOS and `%APPDATA%\auto-test\environment-profiles.json` on Windows. A profile stores reusable authentication state and the highest pre-authorized test risk for that environment.

Full-agent mode treats profile origins as known starting context rather than a browser network allowlist. Codex may follow application redirects and discover supporting origins. Missing authentication or authority should be reported as a resumable environment requirement, not guessed or converted into a product defect.

## Result Boundary

After browser execution, the same Codex thread returns the final result directly under the repository JSON Schema. The harness performs deterministic checks only:

- immutable workflow and source hashes match;
- every input case appears exactly once;
- each case has execution evidence;
- top-level and case outcomes agree;
- passed results have no blockers or product defects;
- product failures are classified as product-sourced;
- pending authoritative mutations force `blocked`.

This preserves Codex judgment about the live business workflow while preventing an incomplete report or unrecovered write from being labeled as passed.
