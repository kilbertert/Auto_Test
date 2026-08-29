# AFK trusted delivery QA plan

## Cases

| ID | Environment | Preconditions | Test data | Actions | Expected observable result | Cleanup |
|---|---|---|---|---|---|---|
| AFK-B10 | Linux task branch | Template version 1.1.1 deployed | Six AFK mutation workflows | Run `node .sandcastle/policy-check.mjs workflows`, actionlint, and ShellCheck | Owner-only same-repository gates, trusted controller execution, read-only candidate token, clean delivery checkout, and fail-closed AGENT_PAT rules pass | None |
| AFK-B11 | afk-bootstrap test checkout | Template source is available | Stale main, advanced origin, merge result, and raced remote | Run `test/trusted-pr-delivery.sh` in afk-bootstrap and compare deployed managed files byte-for-byte | The helper resets the base, preserves the result commit through a bundle, rejects the race, and deployed files match the tested template | Temporary repositories are removed by the test |
| AFK-B12 | Auto-Test self-hosted runner | Hardened workflows merged; runner and required secrets online | Owner-authored disposable PR | Add `agent:review`; inspect the workflow, review, labels, and delivered branch | Review uses current main, completes through controller/candidate/delivery isolation, publishes the review, and leaves no blocked label | Close the disposable PR and remove its branch/labels |

## Results

AFK-B10: passed on `2026-08-30T03:31:15+08:00`, build identity
`2b42d80f10bc34e47125a8d8f302b4d06828b594`, Linux x86_64, Node v24.15.0,
Python 3.13.13, actionlint 1.7.12 and ShellCheck 0.11.0. Evidence:
`npm run check` (`423/423` tests plus typecheck/build), policy checker,
actionlint, ShellCheck and `git diff --check` passed. Managed workflow, policy
checker and bundle helper match the afk-bootstrap template byte-for-byte.

AFK-B11: passed at the same build identity; retained evidence is template
commit `84e9537c661f676f68951eb3e7480472b91ff728` and its `bash
test/trusted-pr-delivery.sh` report.

AFK-B12: blocked on provider availability. The owner-authored disposable PR
`#151` exercised the merged workflow three times. Runs 33272059907 and
33272577334 verified trusted checkout, candidate preparation, and isolation;
33273244207 reached both parallel review axes but the configured provider
returned a subscription error. The workflow marked the PR `agent:blocked` and
did not push or publish a review. PR #151 and issue #152 were closed, the
canary branch and worktree were removed, and `AFK_PROFILE` was restored to
`aliyun-deepseek`. Re-run AFK-B12 after a healthy provider is configured.

Complexity and mutation tools are not applicable to workflow YAML. The template-owned shell state machine has focused stale-base, merge-preservation, and race-rejection coverage; this repository verifies the deployed policy and byte identity.
