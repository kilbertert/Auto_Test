# Trusted control plane for pull request mutation

AFK pull request mutation workflows accept only repository-owner-authored branches from the same repository. Host orchestration and dependencies come from the default-branch controller, candidate commands receive only the read token inside Docker, and resulting commits cross into a clean delivery checkout through a verified Git bundle before the host injects `AGENT_PAT` for the final push; missing or failed delivery credentials stop the workflow. This preserves downstream CI triggers without executing candidate-controlled host code with delivery credentials.

The review, implement, and update-branch workflows intentionally keep their
control-plane steps local because their triggers, preflight state, and write
phases differ. Extract a reusable workflow or composite action only when tests
can prove the owner/fork gates, candidate isolation, token scope, bundle
verification, and failure-label behavior remain unchanged for every caller.
