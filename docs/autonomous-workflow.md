# Autonomous Workflow Controller

## Product Contract

The controller accepts workflow input and runs without interactive steering until one terminal outcome is reached:

- `passed`: approved Runtime and all final assertions passed.
- `product_failed`: immutable business assertions still failed after the bounded refinement budget.
- `blocked`: required authentication, data, policy, environment, or recovery capability was unavailable.

Autonomy never means changing an expected result to match the application. A product assertion remains immutable throughout refinement.

## State Machine

```text
planning
  -> exploring
  -> refining -> exploring
  -> policy_gate
  -> executing
  -> passed | product_failed | blocked
```

`autonomous-job.state.json` is written atomically with mode `0600` on POSIX systems. Windows uses the containing directory's NTFS ACL. Drafts, exploration reports, plans, and Runtime evidence are written separately.
Job events and terminal errors are redacted before persistence. Diagnostics larger than 8,000 characters are omitted instead of retaining raw provider prompts, sessions, or response envelopes.

## Mutation Safety

Every non-read phase intended for autonomous approval declares one recovery contract:

- `retry`: the whole phase is idempotent and safe to replay.
- `compensate`: ordered later phases in the same group restore a verified clean state.

Runtime records immutable mutation transitions:

```text
started -> committed
started -> failed -> retry_ready
started -> failed -> compensation_started -> compensated
started -> failed -> compensation_started -> compensation_failed
```

Only `retry_ready` and `compensated` failures are safe for automatic replanning. `started`, `committed`, `failed`, `interrupted`, or `compensation_failed` at a failed terminal point block the job.

Recovery phases reuse current-run captured entities. They must identify owned business entities rather than operate on the first or latest table row.

## Policy Gate

Automatic approval requires all of the following:

- live exploration passed and its draft hash matches;
- no unresolved locator, table, or business ambiguity remains;
- every phase risk is pre-authorized;
- required write/destructive phases have a validated recovery contract;
- the Planner did not persist plaintext sensitive data.

The resulting reviewer is a policy identity such as `policy:cli-autonomy-v1`, not a fabricated human reviewer.

## Environment Profiles

The default registry path is `~/.config/auto-test/environment-profiles.json` on Linux/macOS and `%APPDATA%\auto-test\environment-profiles.json` on Windows. A profile binds one or more URL origins to:

- private Playwright `storageState` and `sessionStorage` adapters;
- pre-authorized write and destructive risk levels;
- refinement and transient-environment retry budgets.
- optional form-login adapters backed by Secret refs and verified locators.

When exactly one profile covers all supplied URL origins, the autonomous command needs only the Excel and URLs. On POSIX systems, Auth artifacts and Secret Vault files must not grant group or other permissions; Windows relies on the current user's NTFS ACL. Auth Broker validates the authenticated pathname, refreshes expired form sessions, and atomically rewrites `storageState` plus optional `sessionStorage`. Unknown or ambiguous origins fail closed.

Live page evidence redacts every value supplied through `AUTO_TEST_SECRET_*`, including profile-only secrets and members of JSON list bindings, even when the current Draft does not reference that secret.

Composite values are governed by a generic field-representation contract. When one logical value is split across selectors, one or more editable inputs, display components, or derived controls, the agent must record the observed decomposition and a post-fill representation with `field_composition_check` before submitting. In the current execution-first mode, `test_value_get` exposes only the requested Excel/Profile run value to the test agent, allowing it to derive component values without receiving provider keys, cookies, browser storage, or host credentials. The gate requires one authoritative logical source, privately reconstructs it from components marked as segments, ignores context-only controls, strips raw derived values from persisted gate and event records, and rejects unknown semantics, missing observations, or duplicated/omitted segments. A validation response may be classified as `product_failed` only when the referenced field gate passed; malformed or unverified representations terminate as `blocked` with `failureSource: agent_execution`. `--opaque-test-data` retains the stricter alias-only mode for environments that require it.

See `templates/environment-profiles.example.json` for the registry shape.

## Current Boundary

The controller, recovery loop, origin-based Environment Profile Registry, and form-login Auth Broker are implemented. Profile enrollment remains a one-time prerequisite because credentials, OTP sources, test accounts, and physical-device authority cannot be inferred from a URL. During execution, a Codex agent may discover an origin referenced only by a screenshot or page link; the Control MCP records it as an environment requirement and the browser allowlist prevents navigation until the origin is registered. Generic OTP providers and test-data factories are not yet part of the registry contract; missing capabilities terminate as `blocked` with a resumable requirement rather than an invented route.
