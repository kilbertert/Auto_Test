Feature: Trusted AFK pull request automation
  Auto-Test runs pull request agents without executing candidate-controlled host code with delivery credentials.

  Rule: Pull request automation uses the current trusted controller

    Scenario: Review starts from the current default branch
      Given a persistent runner whose local main branch is stale
      And origin main has advanced
      When an owner-authored pull request receives the agent:review label
      Then the trusted controller resets local main to the current origin main
      And the review diff uses that current base

    Scenario: Candidate code cannot receive delivery credentials
      Given an owner-authored pull request from the Auto-Test repository
      When an AFK pull request mutation workflow runs
      Then host dependencies and orchestration load from the trusted controller
      And candidate commands run only in the Docker sandbox with the read token
      And a clean delivery checkout imports and pushes the verified result bundle

    Scenario: Untrusted or unauthenticated delivery stops
      Given a pull request is untrusted or AGENT_PAT cannot perform the requested mutation
      When an AFK mutation label is added
      Then the mutation does not report a successful handoff
      And credential failure records agent:blocked
