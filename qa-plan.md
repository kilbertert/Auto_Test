# AFK trusted delivery QA plan

## Cases

| ID | Environment | Preconditions | Test data | Actions | Expected observable result | Cleanup |
|---|---|---|---|---|---|---|
| AFK-B10 | Linux task branch | Template version 1.1.1 deployed | Six AFK mutation workflows | Run `node .sandcastle/policy-check.mjs workflows`, actionlint, and ShellCheck | Owner-only same-repository gates, trusted controller execution, read-only candidate token, clean delivery checkout, and fail-closed AGENT_PAT rules pass | None |
| AFK-B11 | afk-bootstrap test checkout | Template source is available | Stale main, advanced origin, merge result, and raced remote | Run `test/trusted-pr-delivery.sh` in afk-bootstrap and compare deployed managed files byte-for-byte | The helper resets the base, preserves the result commit through a bundle, rejects the race, and deployed files match the tested template | Temporary repositories are removed by the test |
| AFK-B12 | Auto-Test self-hosted runner | Hardened workflows merged; runner and required secrets online | Owner-authored disposable PR | Add `agent:review`; inspect the workflow, review, labels, and delivered branch | Review uses current main, completes through controller/candidate/delivery isolation, publishes the review, and leaves no blocked label | Close the disposable PR and remove its branch/labels |

## Results

AFK-B10 and AFK-B11 must record the tested commit, environment, timestamp, and command evidence before merge. AFK-B12 remains pending until the hardened template is merged and the live canary completes.

Complexity and mutation tools are not applicable to workflow YAML. The template-owned shell state machine has focused stale-base, merge-preservation, and race-rejection coverage; this repository verifies the deployed policy and byte identity.
