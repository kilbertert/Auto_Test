# node 24 to match package.json engines (>=24); bookworm keeps the same libc
# base as the previous image so the existing toolchain stays compatible.
FROM node:24-bookworm

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Playwright chromium + its OS deps, baked in so the full test suite runs in
# the sandbox (host has these cached; the container must too, or AFK reports
# a false BLOCKED when Chromium cannot launch). Keep the version in sync with
# @playwright/test in package.json (^1.62.0). Browsers live outside the agent
# home so the UID/GID rename below cannot orphan them.
RUN PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx --yes playwright@1.62.0 install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*

RUN groupmod -o -g ${AGENT_GID} node \
  && usermod -o -u ${AGENT_UID} -g ${AGENT_GID} -d /home/agent -m -l agent node \
  && mkdir -p /opt/ms-playwright && chown -R ${AGENT_UID}:${AGENT_GID} /opt/ms-playwright

RUN mkdir -p /home/agent/.codex && chown ${AGENT_UID}:${AGENT_GID} /home/agent/.codex

RUN npm install --global @anthropic-ai/claude-code \
  && npm install --global @openai/codex@0.146.1 \
  && mv /usr/local/bin/claude /usr/local/bin/claude-real \
  && printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -eu' \
    'case "${AFK_PROFILE:-claude}" in' \
    '  claude) exec /usr/local/bin/claude-real "$@" ;;' \
    '  claude-ark|psydo) args=(); while [ "$#" -gt 0 ]; do if [ "$1" = "--model" ]; then shift 2; else args+=("$1"); shift; fi; done; exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_MODEL -u ANTHROPIC_REASONING_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 /usr/local/bin/claude-real --settings /home/agent/.afk-profile-settings.json "${args[@]}" ;;' \
    '  *) echo "unsupported AFK_PROFILE" >&2; exit 2 ;;' \
    'esac' > /usr/local/bin/claude \
  && chmod 755 /usr/local/bin/claude \
  && npm cache clean --force

# code-review skill (two-axis Standards/Spec review via parallel sub-agents),
# used by the review prompts. Source lives in .sandcastle/skills/code-review.
COPY skills/code-review /opt/code-review
RUN mkdir -p /home/agent/.claude/skills && cp -r /opt/code-review /home/agent/.claude/skills/code-review \
  && chown -R ${AGENT_UID}:${AGENT_GID} /home/agent/.claude

USER ${AGENT_UID}:${AGENT_GID}
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
