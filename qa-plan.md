# AFK trusted delivery QA plan

## Cases

| ID | Environment | Preconditions | Test data | Actions | Expected observable result | Cleanup |
|---|---|---|---|---|---|---|
| AFK-B10 | Linux task branch | Template version 1.1.1 deployed | Six AFK mutation workflows | Run `node .sandcastle/policy-check.mjs workflows`, actionlint, and ShellCheck | Owner-only same-repository gates, trusted controller execution, read-only candidate token, clean delivery checkout, and fail-closed AGENT_PAT rules pass | None |
| AFK-B11 | afk-bootstrap test checkout | Template source is available | Stale main, advanced origin, merge result, and raced remote | Run `test/trusted-pr-delivery.sh` in afk-bootstrap and compare deployed managed files byte-for-byte | The helper resets the base, preserves the result commit through a bundle, rejects the race, and deployed files match the tested template | Temporary repositories are removed by the test |
| AFK-B12 | Auto-Test self-hosted runner | Hardened workflows merged; runner and required secrets online | Owner-authored disposable PR | Add `agent:review`; inspect the workflow, review, labels, and delivered branch | Review uses current main, completes through controller/candidate/delivery isolation, publishes the review, and leaves no blocked label | Close the disposable PR and remove its branch/labels |

## Results

AFK-B10: passed on `2026-08-30T03:09:18+08:00`, build identity
`7f1d64fd5a198043a012b29b33aea24c61b1b5ed`, Linux x86_64, Node v24.15.0,
Python 3.13.13, actionlint 1.7.12 and ShellCheck 0.11.0. Evidence:
`npm run check` (`423/423` tests plus typecheck/build), policy checker,
actionlint, ShellCheck and `git diff --check` passed. Managed workflow, policy
checker and bundle helper match the afk-bootstrap template byte-for-byte.

AFK-B11: passed at the same build identity; retained evidence is template
commit `7973f255059c4e71de67ae9375bc0fb28b584824` and its `bash
test/trusted-pr-delivery.sh` report.

AFK-B12 remains pending until the hardened workflow is merged and an
owner-authored `agent:review` canary retains its workflow URL, review result,
labels and cleanup evidence.

Complexity and mutation tools are not applicable to workflow YAML. The template-owned shell state machine has focused stale-base, merge-preservation, and race-rejection coverage; this repository verifies the deployed policy and byte identity.
