# AgentHost execution and provider boundary

Status: Accepted

## Context

The repository previously carried legacy planner, recovery, and autonomous
controller chains. Model credentials also need to remain server-local while
the execution host stays replaceable.

## Decision

Use AgentHost-only execution; the legacy runtime entry point and the old
planner/recovery/controller chain are removed. Model supply is selected through
server-local profiles (`claude-ark`, `psydo`, and `aliyun-deepseek`), with
credentials kept outside the repository.

## Consequences

The execution boundary is smaller and host-neutral, while provider setup remains
an operational concern. New execution paths must preserve the AgentHost result
contract and must not embed credentials in source or artifacts.
