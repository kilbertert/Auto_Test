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
`qa-plan.md`. The post-merge live canary was attempted on 2026-08-30 with
workflow runs [33272059907](https://github.com/kilbertert/Auto_Test/actions/runs/33272059907),
[33272577334](https://github.com/kilbertert/Auto_Test/actions/runs/33272577334),
and [33273244207](https://github.com/kilbertert/Auto_Test/actions/runs/33273244207).
Trusted checkout, candidate preparation, and isolation passed. The review
provider stage was blocked: Aliyun timed out, Claude Ark rejected the account
without a CodingPlan subscription, and Psydo timed out. The workflow therefore
failed closed before delivery push or review publication; no provider
credentials, API keys, tenant data, device identifiers, or internal endpoints
are recorded here.
