#!/usr/bin/env bash
# Post the delivery link back to the GitHub issue this run started from.
#
# WHY THE HOST DOES THIS AND NOT THE AGENT. The implement prompts ask the agent
# to record the ticket's identity and the acceptance criteria met, and pointedly
# do NOT ask for a pull-request URL: the commit is made BEFORE the PR exists, so
# a URL in the commit body could only be invented or absent. Measured on the
# 1.7.18-1.7.20 text, which asked for exactly that. The one party that knows the
# PR URL is the host, after `gh pr create` — so the prompt says "the host posts
# that link to the issue itself", and this is the step that makes the sentence
# true rather than aspirational.
#
# Usage: ticket-writeback.sh <issue-number> <pr-url> <branch>
#
# The issue is the one the `agent:implement` label was on. It is not inferred
# from the commits: the commits carry the ticket's identity for a human to read
# and for the case where the ticket came from another system, but the issue to
# comment on is the one this run was started from and the workflow already knows
# its number.
#
# A `Source ticket:` line naming ANOTHER system (a requirements platform the
# sandbox cannot reach) is reported, not posted to — the sandbox reaches GitHub
# and nothing else, which is the whole reason the prompt asks for the record.
set -uo pipefail

ISSUE="${1:-}"
PR_URL="${2:-}"
BRANCH="${3:-}"
if [ -z "$ISSUE" ] || [ -z "$PR_URL" ]; then
  echo "usage: ticket-writeback.sh <issue-number> <pr-url> [<branch>]" >&2
  exit 1
fi

say() { printf '%s\n' "$*"; }

# What the agent recorded, if anything. Purely informational: it tells the human
# reading the issue where the work originally came from.
RECORD="$(git log --format=%B "origin/main..$BRANCH" 2>/dev/null \
  | sed -n 's/^[[:space:]]*Source ticket:[[:space:]]*//Ip' \
  | head -n1 | tr -d '\r')"

EXTRA=""
if [ -n "$RECORD" ] && [ "$(printf '%s' "$RECORD" | tr -d '#[:space:]')" != "$ISSUE" ]; then
  EXTRA="

Recorded source: \`$RECORD\`"
fi

gh issue comment "$ISSUE" --body "$(cat <<EOF
Implementation delivered: $PR_URL$EXTRA
EOF
)" && say "posted the delivery link to #$ISSUE"
