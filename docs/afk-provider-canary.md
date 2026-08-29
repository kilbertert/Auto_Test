# AFK provider canary

Date: 2026-08-29

This record confirms the repository's AFK delivery workflow was validated
through the official planning boundary (`/grill-with-docs` -> `/to-spec` ->
`/to-tickets`) and the harness-neutral Sandcastle Standards/Spec review
orchestration.

That canary predates template 1.1.1 and does not prove the hardened pull request
delivery boundary. In 1.1.1, `pull_request_target` mutation workflows accept
only owner-authored same-repository pull requests, load dependencies and
orchestration from the current default-branch controller, expose only the read
token to the candidate Docker sandbox, and import verified Git bundles into a
clean delivery checkout. Missing or unusable `AGENT_PAT` now fails closed with
`agent:blocked`; it no longer falls back to `GITHUB_TOKEN`.

The repository-local static and template regression checks are recorded in
`qa-plan.md`. A new live `agent:review` canary remains pending until these
workflows are merged. No provider credentials, API keys, tenant data, device
identifiers, or internal endpoints are recorded here.
