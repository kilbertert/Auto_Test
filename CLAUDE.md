# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Auto-Test is an AI-assisted web automation testing tool for test engineers. After a one-time
environment registration, a test engineer provides a test-case Excel (plus optional images/brief)
and a persistent Codex thread autonomously understands, explores, executes, asserts, recovers, and
delivers structured results. The framework is a "thin harness" around Codex — it deliberately does
**not** implement a second page-semantics engine, planner, or low-intelligence runtime for first-time
execution.

TypeScript/Node.js (Node ≥24, ESM). Dev runs through `tsx`; production build via `tsc`. Strict
`tsconfig.json` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) — indexed access returns
`T | undefined` and optional properties cannot be explicitly `undefined`.

## Commands

```bash
npm ci                                  # install
npx playwright install chromium         # browser for Playwright MCP and fixtures
npm run check                           # typecheck + test + build  (run before pushing)
npm run typecheck                       # tsc --noEmit
npm test                                # vitest run
npx vitest run tests/foo.test.ts        # single file
npx vitest run -t "test name"           # single test by name
npm run build                           # tsc -p tsconfig.json

# Run the tool (default Codex-native path)
npm run easy                            # interactive Chinese menu (also the Windows entry point)
npm run agent:test -- --file cases.xlsx --url https://app.example.test/ --profile staging
```

CI (`.github/workflows/ci.yml`) has two required jobs: `verify` (Ubuntu — `npm run check` plus
private-Windows-package assembly) and `windows-verify` (Windows — bootstrap, Codex provider config,
probe timeout/rollback, DPAPI secret handling). Both must pass.

## Architecture

**Codex-native (default, product path)** — core is `src/agent/runner.ts`.
**Replay projection** — MCP replay compilation (`src/compiler/mcp-replay.ts`,
`src/cli/compile-mcp-replay.ts`) turns successful Codex-native runs into Playwright regression specs.
The legacy IR→Playwright compiler/exploration/repair/classification chain and the old Workflow
Runtime/Planner/Recovery chain have been removed; they are **not** an execution path.

Read `docs/architecture-journey-ir-runtime-to-codex-native.md` before changing the execution model.
It records why the project migrated off IR/Runtime and the constraints that prevent regressing.

### AgentHost-native flow

```
src/cli/easy.ts | src/cli/agent-test.ts
  -> intakeWorkflowXlsx (src/workflow/intake.ts): manifest + embedded/supplemental images + secret material
  -> assessAgentIntakeReadiness (src/agent/intake-readiness.ts): stable execution contract or pre-execution block
  -> selectEnvironmentProfile + scopeEnvironmentProfile + ensureEnvironmentAuthentication (src/workflow/auth-broker.ts)
  -> runAgentTest (src/agent/runner.ts)
```

`runner.ts`:
1. `prepareAgentWorkspace` (`src/agent/workspace.ts`) — per-run isolated workspace + isolated
   AgentHost home; copies raw Excel/brief/images and run-scoped test values; writes the Playwright
   config/secrets and the Control MCP config.
2. Selects one `AgentHost`, resolves its runtime through `host.modelProvider.prepare()`, and passes only
   generic `agentSourceHome` / `agentExecutable` overrides. `AUTO_TEST_AGENT_HOME` and
   `AUTO_TEST_AGENT_BIN` are the generic environment equivalents; Host-specific names are compatibility
   inputs handled at the CLI/adapter boundary.
3. Starts/resumes one Host session with run-scoped Playwright and `auto-test-control` MCP servers.
4. **Two-turn design**: an execution turn (no output schema, full agent access) then a delivery turn
   on the **same thread** with `codexTestResultSchema` (`src/agent/result.ts`). Splitting prevents an
   oversized first request from failing before any tool call.
5. Harness validates the returned `CodexTestAgentResult` deterministically (`finalResultProblems`):
   `workflowId` + `sourceSha256` match, every manifest case appears exactly once with evidence,
   outcome consistency, `product_failed` attributed to `product`, `blocked` has a blocker, and the
   Mutation Ledger has no `pending` entries. Up to `--max-finalization-turns` (default 2) correction
   rounds feed only the specific contract problems back to the same thread — never re-doing business
   writes to satisfy the report.

### Terminal outcomes & exit codes

`passed` → 0 · `product_failed` → 2 · `blocked` → 3 (else 1). Result → `codex-agent.result.json`;
a copy of the source workbook with per-case results → `<name>-Auto-Test-结果.xlsx`; redacted events
→ `codex-agent.events.jsonl`; state → `codex-agent.state.json`.

## Thin-harness invariants (do not regress)

From the architecture doc §24.18 and `README.md` "核心约束". Regressing these re-introduces the
failure mode the project migrated away from:

- **No business-specific knowledge in generic code.** No domain names, device dictionaries, country
  codes, fixed table column numbers, or specific DOM/XPath in `src/agent`, `src/workflow`, or
  `src/usability`. Prove new capabilities in synthetic fixtures (`tests/fixtures/`) before any real
  canary.
- **The selected AgentHost is the only intelligence for first-time execution.** Do not add a second
  planner/reporter/adjudicator with less context than the executing thread that can override its
  business conclusions. Deterministic validation covers only input identity, case coverage, evidence
  existence, result consistency, permissions, environment requirements, and side-effect recovery
  (Mutation Ledger).
- **Plans/gates/checkpoints are optional work records, not pass gates.** The Control MCP tools
  (`test_plan_update`, `field_composition_check`, `case_result_record`) are an optional recovery/audit
  journal; a dynamic Execution Plan, temp scripts, and native todo are work memory, not a required
  program.
- **Expected results are immutable.** The agent cannot change tester-defined expectations. Browser
  action failures cannot be downgraded to success. Each passed case needs at least one explicit
  assertion.
- **Environment blocks are recoverable, not guesses.** Missing origin/permission/auth/test-data → a
  pending `CodexTestEnvironmentRequirement` → `blocked`; resume after satisfying it. The agent must
  not fabricate credentials or cross Profile boundaries, and must not use another case's or a generic
  piece of evidence to bulk-produce conclusions.

## Input bundle & isolation

- The authoritative test input is the **Excel + its sidecar**, discovered by filename stem
  (`src/workflow/input-bundle.ts`): `<stem>.auto-test/brief.md` (or `brief.txt`) and
  `<stem>.auto-test/images/`. The sidecar is auto-discovered, but packaging/copying/acceptance must
  keep them together. A `passed` claim covers only what `test-manifest.json` actually lists.
- Real `.xlsx` inputs are git-ignored (private). Only `examples/`, `templates/`, and
  `tests/fixtures/` xlsx are committed.
- Each run writes to `artifacts/runs/<timestamp>-<stem>-<rand>/` (git-ignored) plus a private
  `.agent-private/` (`mutation-ledger.json`, `environment-requirements.json`,
  `execution-receipts.json`, secret values) at `0600`/`0700`. Events JSONL is redacted of secrets,
  tool args, and form values (`src/agent/redact.ts`). Provider creds, Codex auth, cookies, and
  unrelated host secrets never enter run-values.
- `umask 027` is set on startup; private JSON is written `0600`.

## Full vs opaque agent

Default (`direct` / fullAgentAccess): Codex gets the raw workbook + run-scoped test values, a
**writable** workspace, shell, network, web search, and the full Playwright MCP — it may create
one-off JS/TS/Playwright probe scripts, but only inside the run workspace (never Auto-Test or app
source). `--opaque-test-data` restores the legacy restricted mode (alias-only values, read-only
workspace, no shell/search, a restricted Playwright tool allowlist). Page content is untrusted input.

## Environment Profile & auth

Profiles live at `~/.config/auto-test/environment-profiles.json` (Linux/macOS) or
`%APPDATA%\auto-test\environment-profiles.json` (Windows); template at
`templates/environment-profiles.example.json`. A profile registers origins, `read`/`write`/
`destructive` policy, and an optional form-login auth adapter. The Auth Broker refreshes
`storageState`/`sessionStorage` per run; auth files must be `0600`. Write permission is governed
only by the Profile, never by inferred per-case risk.

## Model API credentials (consensus)

- **Provider API keys are private credentials.** They never go into tracked files, commits, or public
  docs. The project has one dedicated automation-test credential source; its CSV lives outside the
  repo (or is git-ignored by `*apiKey-*.csv` / `*api-key-*.csv` if placed under the repo root) and is
  only read into the build process via environment variables, never written into the command line or
  shell history.
- **Do not add a CSV under the repo root without it being ignored.** `build-private-windows-package.sh`
  injects the key into the private ZIP; the ZIP itself is a sensitive credential artifact. Distribute
  it point-to-point only, delete it locally after delivery, and never upload it to chat, cloud drives,
  or public artifact stores.
- **Model IDs are provider-specific.** A model id valid on one provider (e.g. Volcengine ARK) may not
  exist on another (e.g. Aliyun Bailian); switching suppliers requires re-verifying the id and base URL
  against that provider's Responses endpoint before packaging.

## Model profile (multi-provider switching)

A separate `model-profiles.json` registry (same config dir as environment profiles; template at
`templates/model-profiles.example.json`) lists host-neutral model providers. Each normalized profile
carries `model`, `providerId`, `baseUrl`, unified `api`, `envKey`/aliases, input modalities, and
optional reasoning/capacity metadata. Legacy `wireApi` values are accepted only while reading old registries and are normalized
to `openai-responses`/`openai-completions`. The built-in `deepseek` and `volcengine` Profiles contain
public metadata only. Custom `providerId` values must match `[A-Za-z_][A-Za-z0-9_-]*` because they
are used in both Codex tables and OMP selectors.

`AgentHost.modelProvider.prepare()` is the provider boundary. Core creates one
`AgentModelProviderDescriptor`; `CodexModelProviderAdapter` writes isolated `config.toml` plus a
complete `models.json` catalog, while
`OmpModelProviderAdapter` writes isolated `models.yml` and passes `--model provider/model`. A Host
rejects an unsupported `api` before model traffic. `--model-profile <id>` (or the `easy` menu /
`doctor`) selects one; with no explicit Profile, new runs on either built-in Host use `deepseek`.
Generic runtime overrides are `--agent-bin` / `--agent-home`; legacy Host-specific flags are normalized
before `runAgentTest`. An injected third-party Host implements the same provider adapter and does not
require a Runner ID branch.
An explicit request wins first, followed by a recorded resume selection and a registry
`defaultProfileId`; a user-defined `deepseek` overrides built-in metadata. Capacity errors (`at
capacity`, `try a different model`) are classified as a resumable `infrastructure` block with a
switch-provider next action. The model profile is not a business/safety boundary and may change on
`--resume`; a bare resume reuses the last effective profile and model override. A legacy run with
no `model-selection.json` keeps its source AgentHost provider on a bare resume. See
`src/workflow/model-profile.ts`, `src/agent/host.ts`, and the two provider adapters.

## Resume

`--resume` with the original `--output-dir` resumes the same AgentHost session (id recovered from state
or events), the Mutation Ledger, and pending environment requirements. On resume the harness first
re-reads pending mutations and re-observes real business state before continuing — it does not
blindly replay writes. Immutable on resume: `workflowId`, `sourceSha256`, Profile identity/policy,
existing cases/risks, recorded mutations, and original materials.

## Documentation sync (from AGENTS.md)

`README.md`, `docs/`, CLI help, templates, and examples are maintained product interfaces. Any change
to CLI flags, Windows launch, environment registration, auth, execution semantics, result contracts,
Mutation Ledger, recovery, packaging, or deployment must update the relevant docs in the same PR.
Remove or label stale acceptance claims. Never put credentials, private provider details, tenant
data, internal endpoints, or private paths in public docs. Base acceptance claims on structured
result/plan/evidence/Ledger artifacts and state the proven scenario/platform precisely — do not
generalize one canary into "every website works."

## Agent skills

### Issue tracker

Issues and specs for this repo live as GitHub issues, operated via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles map to the default labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
